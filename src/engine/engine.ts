// Deterministic decision engine (Phase 3) — the AUTHORITATIVE source of events.
//
// For the recent detection window it: clusters detections by H3 cell, enriches
// each cluster with the Digital Twin, the nearest fire-weather point and any
// active lightning watch, scores it (explainable, src/engine/score.ts), and —
// only when confidence ≥ threshold — creates/updates an event. Below threshold
// it writes an audit row (transparency about non-events). Pure scoring; all I/O
// is here. Kept deliberately simple: cluster by exact cell (k-ring merge is a
// documented refinement), one active event per cell.
import { cellToLatLng } from "h3-js";
import {
  activeEventByCell, activeWildfireAlert, digitalTwinCell, fireWeatherCell, hasActiveLightningWatch,
  insertEvent, observationsSince, officialFireWeatherLevel, updateEvent, writeAudit,
} from "../db.js";
import { weatherGrid } from "../ingest/weather.js";
import { cellFor } from "../lib/h3.js";
import type { Env } from "../types.js";
import { DEFAULT_THRESHOLD, DEFAULT_WEIGHTS, scoreDetection, type Weights } from "./score.js";

/** Detections within this window feed persistence/clustering. */
const WINDOW_H = 24;

/**
 * Weights + confidence threshold, from KV `CONFIG` key `engine_config` (JSON),
 * merged over the defaults. Tune live with:
 *   wrangler kv key put --binding=CONFIG engine_config '{"threshold":0.6,"weights":{...}}'
 */
export async function loadEngineConfig(env: Env): Promise<{ weights: Weights; threshold: number }> {
  const raw = (await env.CONFIG.get("engine_config", "json")) as { weights?: Partial<Weights>; threshold?: number } | null;
  return {
    weights: { ...DEFAULT_WEIGHTS, ...(raw?.weights ?? {}) },
    threshold: typeof raw?.threshold === "number" ? raw.threshold : DEFAULT_THRESHOLD,
  };
}

/** Nearest fire-weather sample cell to a detection cell (213-point grid). */
function nearestWeatherCell(cell: string): string {
  const [lat, lng] = cellToLatLng(cell);
  let best = weatherGrid()[0];
  let bestD = Infinity;
  for (const p of weatherGrid()) {
    const d = (p.lat - lat) ** 2 + (p.lng - lng) ** 2; // squared-deg: fine for nearest
    if (d < bestD) { bestD = d; best = p; }
  }
  return cellFor(best.lat, best.lng);
}

export async function runDecisionEngine(env: Env): Promise<{ clusters: number; events: number; subthreshold: number }> {
  const nowIso = new Date().toISOString();
  const { weights, threshold } = await loadEngineConfig(env);
  const since = new Date(Date.now() - WINDOW_H * 3600_000).toISOString();
  const obs = await observationsSince(env, since);

  // Official corroboration is region-wide, so resolve it once per pass:
  //   • a live GDACS wildfire alert over Aragón, and
  //   • the highest active AEMET fire-weather warning level.
  const officialWildfire = await activeWildfireAlert(env, nowIso);
  const officialFwLevel = await officialFireWeatherLevel(env, nowIso);

  // Cluster by exact H3 cell.
  const byCell = new Map<string, typeof obs>();
  for (const o of obs) {
    const g = byCell.get(o.h3_cell);
    if (g) g.push(o); else byCell.set(o.h3_cell, [o]);
  }

  let events = 0;
  let subthreshold = 0;
  for (const [cell, group] of byCell) {
    const twin = (await digitalTwinCell(env, cell)) as Record<string, any> | null;
    const fw = (await fireWeatherCell(env, nearestWeatherCell(cell))) as Record<string, any> | null;
    const lightning = await hasActiveLightningWatch(env, cell, nowIso);

    const ctx = {
      detectionConfidence: Math.max(...group.map((o) => o.confidence ?? 0.5)),
      persistenceCount: group.length,
      lightningActive: lightning,
      fwi: fw?.fwi ?? null,
      triple30: (fw?.triple30 ?? null) as 0 | 1 | null,
      fuelType: twin?.fuel_type ?? null,
      slopeDeg: twin?.slope_deg ?? null,
      populationDensity: twin?.population_density ?? null,
      popElderly: twin?.pop_elderly ?? null,
      distAssetM: twin?.dist_asset_m ?? null,
      officialWildfireAlert: officialWildfire,
      officialFireWeatherLevel: officialFwLevel,
    };
    const r = scoreDetection(ctx, weights);
    const obsIds = JSON.stringify(group.map((o) => o.id));
    const breakdown = JSON.stringify({ ...r.breakdown, context: ctx, municipio: twin?.municipio ?? null });

    if (r.confidence >= threshold) {
      const existing = await activeEventByCell(env, cell);
      if (existing) await updateEvent(env, existing.id, { score: r.score, confidence: r.confidence, breakdown, obsIds });
      else await insertEvent(env, { id: crypto.randomUUID(), cell, score: r.score, confidence: r.confidence, breakdown, obsIds, at: nowIso });
      events++;
    } else {
      await writeAudit(env, "score", { cell, confidence: r.confidence, score: r.score, reason: "below_threshold" });
      subthreshold++;
    }
  }

  await writeAudit(env, "engine", { window_h: WINDOW_H, clusters: byCell.size, events, subthreshold });
  return { clusters: byCell.size, events, subthreshold };
}
