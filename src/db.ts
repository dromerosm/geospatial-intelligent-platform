// Thin D1 access layer. Kept deliberately small: batched writes for ingestion,
// a couple of read helpers for the REST endpoints.
import type { Env, FireWeather, HazardAlert, Observation } from "./types.js";

export async function insertObservations(env: Env, obs: Observation[]): Promise<number> {
  if (obs.length === 0) return 0;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO observation
       (id, source, acquired_at, ingested_at, h3_cell, footprint_geojson,
        nominal_resolution_m, geolocation_uncertainty_m, confidence, raw_r2_key, props_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const batch = obs.map((o) =>
    stmt.bind(
      o.id, o.source, o.acquiredAt, o.ingestedAt, o.h3Cell, o.footprintGeojson,
      o.nominalResolutionM, o.geolocationUncertaintyM, o.confidence, o.rawR2Key,
      JSON.stringify(o.props),
    ),
  );
  await env.DB.batch(batch);
  return obs.length;
}

export async function upsertFireWeather(env: Env, rows: FireWeather[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = env.DB.prepare(
    `INSERT INTO fire_weather
       (h3_cell, updated_at, temp_c, rh_pct, wind_kmh, wind_dir_deg, rain_mm, fuel_moisture_proxy, triple30, forecast_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(h3_cell) DO UPDATE SET
       updated_at=excluded.updated_at, temp_c=excluded.temp_c, rh_pct=excluded.rh_pct,
       wind_kmh=excluded.wind_kmh, wind_dir_deg=excluded.wind_dir_deg, rain_mm=excluded.rain_mm,
       fuel_moisture_proxy=excluded.fuel_moisture_proxy, triple30=excluded.triple30,
       forecast_json=excluded.forecast_json`,
  );
  const batch = rows.map((r) =>
    stmt.bind(
      r.h3Cell, r.updatedAt, r.tempC, r.rhPct, r.windKmh, r.windDirDeg, r.rainMm,
      r.fuelMoistureProxy, r.triple30, r.forecastJson,
    ),
  );
  await env.DB.batch(batch);
  return rows.length;
}

/** Drop fire-weather rows from previous grids (self-heal after a grid change). */
export async function pruneFireWeather(env: Env, keepUpdatedAt: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM fire_weather WHERE updated_at <> ?`).bind(keepUpdatedAt).run();
}

/** Rows needed to advance the FWI System (forecast + yesterday's moisture codes). */
export async function fireWeatherForFwi(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT h3_cell, forecast_json, ffmc, dmc, dc FROM fire_weather`,
  ).all<{ h3_cell: string; forecast_json: string | null; ffmc: number | null; dmc: number | null; dc: number | null }>();
  return results;
}

export async function updateFwi(
  env: Env,
  rows: { cell: string; ffmc: number; dmc: number; dc: number; isi: number; bui: number; fwi: number }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = env.DB.prepare(
    `UPDATE fire_weather SET ffmc=?, dmc=?, dc=?, isi=?, bui=?, fwi=? WHERE h3_cell=?`,
  );
  await env.DB.batch(rows.map((r) => stmt.bind(r.ffmc, r.dmc, r.dc, r.isi, r.bui, r.fwi, r.cell)));
  return rows.length;
}

// --- Lightning Watch --------------------------------------------------------
export async function recordLightningStrikes(
  env: Env,
  rows: { cell: string; at: string; expiresAt: string }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = env.DB.prepare(
    `INSERT INTO lightning_watch (h3_cell, first_seen, last_strike, strike_count, expires_at)
     VALUES (?,?,?,1,?)
     ON CONFLICT(h3_cell) DO UPDATE SET
       last_strike = MAX(last_strike, excluded.last_strike),
       strike_count = strike_count + 1,
       expires_at = MAX(expires_at, excluded.expires_at)`,
  );
  await env.DB.batch(rows.map((r) => stmt.bind(r.cell, r.at, r.at, r.expiresAt)));
  return rows.length;
}

export async function pruneLightningWatch(env: Env, now: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM lightning_watch WHERE expires_at < ?`).bind(now).run();
}

export async function activeLightningWatches(env: Env, now: string) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM lightning_watch WHERE expires_at > ? ORDER BY last_strike DESC`,
  ).bind(now).all();
  return results;
}

/** Is there an active lightning watch on this cell? (correlation, Phase 3). */
export async function hasActiveLightningWatch(env: Env, cell: string, now: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM lightning_watch WHERE h3_cell = ? AND expires_at > ? LIMIT 1`,
  ).bind(cell, now).first();
  return row != null;
}

// --- Hazard alerts (external authoritative warnings) ------------------------
export async function upsertHazardAlerts(env: Env, rows: HazardAlert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = env.DB.prepare(
    `INSERT INTO hazard_alert
       (id, source, category, fire_relevant, severity, severity_num, level_label, headline,
        area_desc, in_region, onset, expires, lat, lng, url, raw_r2_key, ingested_at, props_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       severity=excluded.severity, severity_num=excluded.severity_num, level_label=excluded.level_label,
       headline=excluded.headline, area_desc=excluded.area_desc, in_region=excluded.in_region,
       onset=excluded.onset, expires=excluded.expires, lat=excluded.lat, lng=excluded.lng,
       url=excluded.url, raw_r2_key=excluded.raw_r2_key, ingested_at=excluded.ingested_at,
       props_json=excluded.props_json`,
  );
  const batch = rows.map((a) =>
    stmt.bind(
      a.id, a.source, a.category, a.fireRelevant, a.severity, a.severityNum, a.levelLabel, a.headline,
      a.areaDesc, a.inRegion, a.onset, a.expires, a.lat, a.lng, a.url, a.rawR2Key, a.ingestedAt,
      JSON.stringify(a.props),
    ),
  );
  await env.DB.batch(batch);
  return rows.length;
}

/** Drop alerts that have expired (or, if no expiry, that are older than maxAgeH). */
export async function pruneHazardAlerts(env: Env, now: string, maxAgeH = 48): Promise<void> {
  const cutoff = new Date(new Date(now).getTime() - maxAgeH * 3600_000).toISOString();
  await env.DB.prepare(
    `DELETE FROM hazard_alert
       WHERE (expires IS NOT NULL AND expires < ?)
          OR (expires IS NULL AND ingested_at < ?)`,
  ).bind(now, cutoff).run();
}

/** Currently-valid alerts (onset passed or null, not expired), highest severity first. */
export async function activeHazardAlerts(env: Env, now: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, source, category, fire_relevant, severity, severity_num, level_label, headline,
            area_desc, in_region, onset, expires, lat, lng, url
       FROM hazard_alert
       WHERE (expires IS NULL OR expires > ?) AND (onset IS NULL OR onset <= ?)
       ORDER BY severity_num DESC, expires ASC`,
  ).bind(now, now).all();
  return results;
}

/** Is an official wildfire alert (GDACS) active over the region? (corroboration). */
export async function activeWildfireAlert(env: Env, now: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM hazard_alert
       WHERE source = 'GDACS' AND category = 'wildfire' AND in_region = 1
         AND (expires IS NULL OR expires > ?) AND (onset IS NULL OR onset <= ?) LIMIT 1`,
  ).bind(now, now).first();
  return row != null;
}

/**
 * Highest official fire-weather warning level active over the region right now,
 * as [0,1] (AEMET amarillo/naranja/rojo). 0 when only "verde"/none. A region-
 * wide proxy; per-zone polygon containment is a documented refinement.
 */
export async function officialFireWeatherLevel(env: Env, now: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT MAX(severity_num) AS m FROM hazard_alert
       WHERE source = 'AEMET_CAP' AND fire_relevant = 1 AND in_region = 1
         AND (expires IS NULL OR expires > ?) AND (onset IS NULL OR onset <= ?)`,
  ).bind(now, now).first<{ m: number | null }>();
  return row?.m ?? 0;
}

// --- Decision engine (Phase 3) ----------------------------------------------
export async function observationsSince(env: Env, sinceIso: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, h3_cell, confidence, acquired_at, source, nominal_resolution_m, geolocation_uncertainty_m
       FROM observation WHERE acquired_at >= ? ORDER BY acquired_at DESC`,
  ).bind(sinceIso).all<{
    id: string; h3_cell: string; confidence: number | null; acquired_at: string;
    source: string; nominal_resolution_m: number | null; geolocation_uncertainty_m: number | null;
  }>();
  return results;
}

export async function activeEventByCell(env: Env, cell: string) {
  // has_briefing lets the engine call the LLM only once per event lifetime.
  return env.DB.prepare(
    `SELECT id, (briefing_json IS NOT NULL) AS has_briefing
       FROM event WHERE h3_cell = ? AND status = 'active' LIMIT 1`,
  ).bind(cell).first<{ id: string; has_briefing: number }>();
}

export async function updateEventBriefing(
  env: Env,
  id: string,
  briefingJson: string,
  briefingText: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE event SET briefing_json = ?, briefing_text = ? WHERE id = ?`,
  ).bind(briefingJson, briefingText, id).run();
}

export async function insertEvent(
  env: Env,
  ev: { id: string; cell: string; score: number; confidence: number; breakdown: string; obsIds: string; at: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO event (id, created_at, h3_cell, status, det_score, det_confidence, score_breakdown_json, observation_ids)
     VALUES (?,?,?,'active',?,?,?,?)`,
  ).bind(ev.id, ev.at, ev.cell, ev.score, ev.confidence, ev.breakdown, ev.obsIds).run();
}

export async function updateEvent(
  env: Env,
  id: string,
  u: { score: number; confidence: number; breakdown: string; obsIds: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE event SET det_score=?, det_confidence=?, score_breakdown_json=?, observation_ids=? WHERE id=?`,
  ).bind(u.score, u.confidence, u.breakdown, u.obsIds, id).run();
}

export async function activeEvents(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, h3_cell, status, det_score, det_confidence, score_breakdown_json, observation_ids, briefing_json, briefing_text
       FROM event WHERE status = 'active' ORDER BY det_score DESC`,
  ).all();
  return results;
}

export async function writeAudit(env: Env, stage: string, detail: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (id, at, stage, event_id, detail_json) VALUES (?,?,?,?,?)`,
  )
    .bind(crypto.randomUUID(), new Date().toISOString(), stage, null, JSON.stringify(detail))
    .run();
}

export async function recentObservations(env: Env, limit = 100) {
  const { results } = await env.DB.prepare(
    `SELECT id, source, acquired_at, h3_cell, confidence, nominal_resolution_m, footprint_geojson
       FROM observation ORDER BY acquired_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return results;
}

export async function currentFireWeather(env: Env) {
  // Exclude forecast_json — 225 rows × a 3-day series would be a heavy response.
  const { results } = await env.DB.prepare(
    `SELECT h3_cell, updated_at, temp_c, rh_pct, wind_kmh, wind_dir_deg, rain_mm,
            triple30, ffmc, dc, fwi
       FROM fire_weather ORDER BY updated_at DESC`,
  ).all();
  return results;
}

/** Full fire weather (incl. the 3-day forecast) for one sample cell. */
export async function fireWeatherCell(env: Env, cell: string) {
  return env.DB.prepare(`SELECT * FROM fire_weather WHERE h3_cell = ?`).bind(cell).first();
}

/** Digital Twin coverage summary (for verifying the Phase 2 batch build). */
export async function digitalTwinStats(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT
       COUNT(*)                                     AS cells,
       COUNT(slope_deg)                             AS with_slope,
       COUNT(land_cover)                            AS with_land_cover,
       COUNT(dist_asset_m)                          AS with_infra,
       SUM(hist_fire_flag)                          AS hist_fire_cells,
       MAX(slope_deg)                               AS max_slope_deg,
       SUM(population)                              AS total_population,
       SUM(pop_child)                              AS total_child_0_14,
       SUM(pop_adult)                              AS total_adult_15_64,
       SUM(pop_elderly)                            AS total_elderly_65plus,
       ROUND(MAX(population_density), 1)            AS max_density_km2
     FROM digital_twin_cell`,
  ).all();
  return results[0] ?? { cells: 0 };
}

/** Context for a single cell — the join Phase 3 will do per detection. */
export async function digitalTwinCell(env: Env, cell: string) {
  return env.DB.prepare(`SELECT * FROM digital_twin_cell WHERE h3_cell = ?`).bind(cell).first();
}
