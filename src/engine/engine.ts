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
import { aiApiKey, generateBriefing, type AiError, type BriefingInput } from "../ai/briefing.js";
import { DEFAULT_MIN_PRIORITY, MAX_NOTIFICATIONS_PER_RUN, PRIORITY_RANK } from "../config.js";
import {
  activeEventByCell, activeWildfireAlert, digitalTwinCell, fireWeatherCell, hasActiveLightningWatch,
  insertEvent, markNotified, observationsSince, officialFireWeatherLevel, updateEvent, updateEventBriefing, writeAudit,
} from "../db.js";
import { buildMessage, sendTelegram, type AlertBriefing, type TelegramError } from "../notify/telegram.js";
import { weatherGrid } from "../ingest/weather.js";
import { cellFor } from "../lib/h3.js";
import type { Env } from "../types.js";
import { DEFAULT_THRESHOLD, DEFAULT_WEIGHTS, scoreDetection, type ScoreResult, type Weights } from "./score.js";

type ObsRow = Awaited<ReturnType<typeof observationsSince>>[number];

// Best-effort AI briefing for one event. Called at most once per event (only
// when it has none yet) and only if the active provider's key is set. The deterministic
// event already exists; a failure here just leaves the briefing null and is
// audited — it never interrupts the engine.
async function briefEvent(
  env: Env, eventId: string, cell: string, threshold: number,
  r: ScoreResult, ctx: BriefingInput["context"], municipio: string | null, group: ObsRow[],
): Promise<{ rateLimited: boolean; briefing: AlertBriefing | null }> {
  const apiKey = aiApiKey(env);
  if (!apiKey) return { rateLimited: false, briefing: null };
  const input: BriefingInput = {
    cell, municipio, score: r.score, confidence: r.confidence, threshold,
    contributions: r.breakdown.contributions, weighted: r.breakdown.weighted, context: ctx,
    observations: group.map((o) => ({
      source: o.source, nominalResolutionM: o.nominal_resolution_m,
      uncertaintyM: o.geolocation_uncertainty_m, confidence: o.confidence, acquiredAt: o.acquired_at,
    })),
  };
  try {
    const brief = await generateBriefing(apiKey, input);
    await updateEventBriefing(env, eventId, JSON.stringify(brief.json), brief.json.briefing_text);
    await writeAudit(env, "ai", { eventId, cell, model: brief.model, priority: brief.json.priority, usage: brief.usage });
    return { rateLimited: false, briefing: brief.json };
  } catch (err) {
    const status = (err as AiError)?.status;
    const rateLimited = status === 429;
    await writeAudit(env, "ai", { eventId, cell, error: String(err), ...(rateLimited ? { rateLimited, retryAfter: (err as AiError).retryAfter } : {}) });
    console.error(`briefing failed for ${eventId}:`, err);
    // On a rate limit, tell the caller to stop briefing for the rest of the pass.
    return { rateLimited, briefing: null };
  }
}

/** Notify threshold from KV `notify_config` {"min_priority":"..."}, over the default. */
async function loadMinPriority(env: Env): Promise<string> {
  const raw = (await env.CONFIG.get("notify_config", "json")) as { min_priority?: string } | null;
  const p = raw?.min_priority;
  return p && p in PRIORITY_RANK ? p : DEFAULT_MIN_PRIORITY;
}

// Best-effort Telegram alert for one event, once its briefing meets the priority
// threshold. Gated + deduped by the caller (event.notified_at). Like the briefing:
// a failure just leaves notified_at NULL and is retried next pass; a 429 tells the
// caller to stop notifying for the rest of the pass. Relays only — never mutates events.
async function notifyEvent(
  env: Env, eventId: string, cell: string, municipio: string | null,
  score: number, confidence: number, briefing: AlertBriefing, minPriority: string,
): Promise<{ attempted: boolean; rateLimited: boolean }> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { attempted: false, rateLimited: false };
  // Local priority gate — no API call when below threshold (won't waste quota,
  // and notified_at stays NULL so a later escalation could still alert).
  if ((PRIORITY_RANK[briefing.priority] ?? 0) < (PRIORITY_RANK[minPriority] ?? 2)) {
    return { attempted: false, rateLimited: false };
  }
  try {
    const text = buildMessage({ cell, municipio, score, confidence, briefing });
    await sendTelegram(token, chatId, text);
    await markNotified(env, eventId, new Date().toISOString());
    await writeAudit(env, "notify", { eventId, cell, priority: briefing.priority });
    return { attempted: true, rateLimited: false };
  } catch (err) {
    const status = (err as TelegramError)?.status;
    const rateLimited = status === 429;
    await writeAudit(env, "notify", { eventId, cell, error: String(err), ...(rateLimited ? { rateLimited, retryAfter: (err as TelegramError).retryAfter } : {}) });
    console.error(`telegram notify failed for ${eventId}:`, err);
    return { attempted: true, rateLimited };
  }
}

/** Detections within this window feed persistence/clustering. */
const WINDOW_H = 24;

// Cap how many briefings one pass generates. Two reasons: bound the pass's added
// latency, and stay under the provider's per-minute token budget. Groq gpt-oss-120b
// free tier is 8,000 tokens/min and a briefing is ~2,000 tokens, so 3/pass (~6k)
// stays comfortably under it; passes are ≥15 min apart, and daily volume (RPD 1,000)
// is never approached since above-threshold events are rare. Unbriefed events are
// picked up by the next pass (the engine only briefs events that still have none).
const MAX_BRIEFINGS_PER_RUN = 3;

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

  const minPriority = await loadMinPriority(env);
  let events = 0;
  let subthreshold = 0;
  let briefed = 0;
  let rateLimited = false; // once true, skip briefings for the rest of this pass
  let notified = 0;
  let notifyRateLimited = false; // once true, skip notifications for the rest of this pass
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
      const municipio = twin?.municipio ?? null;
      const existing = await activeEventByCell(env, cell);
      let eventId: string;
      let needsBriefing: boolean;
      let briefing: AlertBriefing | null = null;
      let alreadyNotified: boolean;
      if (existing) {
        await updateEvent(env, existing.id, { score: r.score, confidence: r.confidence, breakdown, obsIds });
        eventId = existing.id;
        needsBriefing = !existing.has_briefing; // refresh only if it never got one
        alreadyNotified = existing.notified_at != null;
        if (existing.briefing_json) { try { briefing = JSON.parse(existing.briefing_json); } catch {} }
      } else {
        eventId = crypto.randomUUID();
        await insertEvent(env, { id: eventId, cell, score: r.score, confidence: r.confidence, breakdown, obsIds, at: nowIso });
        needsBriefing = true;
        alreadyNotified = false;
      }
      events++;
      if (needsBriefing && briefed < MAX_BRIEFINGS_PER_RUN && !rateLimited) {
        const res = await briefEvent(env, eventId, cell, threshold, r, ctx, municipio, group);
        briefed++;
        rateLimited = res.rateLimited; // 429 -> stop briefing the rest; next pass retries
        if (res.briefing) briefing = res.briefing;
      }
      // Notify once per event, when its briefing meets the priority threshold.
      if (briefing && !alreadyNotified && notified < MAX_NOTIFICATIONS_PER_RUN && !notifyRateLimited) {
        const nres = await notifyEvent(env, eventId, cell, municipio, r.score, r.confidence, briefing, minPriority);
        if (nres.attempted) notified++;
        notifyRateLimited = nres.rateLimited; // 429 -> stop notifying the rest; next pass retries
      }
    } else {
      await writeAudit(env, "score", { cell, confidence: r.confidence, score: r.score, reason: "below_threshold" });
      subthreshold++;
    }
  }

  await writeAudit(env, "engine", { window_h: WINDOW_H, clusters: byCell.size, events, subthreshold, briefed, rateLimited, notified, notifyRateLimited });
  return { clusters: byCell.size, events, subthreshold };
}
