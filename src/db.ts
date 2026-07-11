// Thin D1 access layer. Kept deliberately small: batched writes for ingestion,
// a couple of read helpers for the REST endpoints.
import type { Env, FireWeather, Observation } from "./types.js";

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
