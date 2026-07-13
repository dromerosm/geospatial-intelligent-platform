// Region + ingestion constants. Kept in one place so the platform can be
// re-pointed at another region by editing this file only.

/** Aragón bounding box (lon/lat degrees). */
export const ARAGON_BBOX = {
  west: -2.2,
  south: 39.8,
  east: 0.8,
  north: 42.95,
} as const;

/** H3 resolution for the national/regional analytical grid (~5 km² per cell). */
export const H3_RESOLUTION = 7;

// --- NASA FIRMS -------------------------------------------------------------
// Area API: https://firms.modaps.eosdis.nasa.gov/api/area/
// Ingest ALL available near-real-time constellations, not just one satellite: a
// single platform (e.g. Suomi-NPP) misses fires that NOAA-20/21 or MODIS see on
// a different overpass. Cross-satellite hits in the same cell also raise the
// engine's persistence/confidence. res = nominal pixel size (m).
export const FIRMS_SOURCES = [
  { id: "VIIRS_SNPP_NRT", sat: "SNPP", resM: 375 },
  { id: "VIIRS_NOAA20_NRT", sat: "NOAA20", resM: 375 },
  { id: "VIIRS_NOAA21_NRT", sat: "NOAA21", resM: 375 },
  { id: "MODIS_NRT", sat: "MODIS", resM: 1000 },
] as const;
export const FIRMS_DAY_RANGE = 1; // last N days
/** VIIRS confidence letters -> numeric [0,1] (MODIS uses a 0-100 number). */
export const FIRMS_CONFIDENCE: Record<string, number> = { l: 0.3, n: 0.6, h: 0.9 };

// --- Fire weather -----------------------------------------------------------
// Sample points are a surface-uniform grid clipped to Aragón, precomputed in
// src/weather-points.json (scripts/build-weather-grid.mjs).

/** Classic Triple-30 operational indicator (one signal, not the sole rule). */
export const TRIPLE30 = { tempC: 30, windKmh: 30, rhPct: 30 } as const;

// --- Lightning Watch --------------------------------------------------------
/** Monitoring window opened by a cloud-to-ground strike (spec: 24-72 h). */
export const LIGHTNING_WATCH_HOURS = 48;

// --- Hazard alerts (external authoritative warnings) ------------------------
// GDACS — Global Disaster Alert and Coordination System (JRC/UN). The EVENTS4APP
// endpoint returns a GeoJSON FeatureCollection; ?eventtypes=WF = wildfires only.
// Coordinates are [lon,lat]; alertlevel is Green/Orange/Red. We keep Spain-wide
// wildfire alerts and flag the ones overlapping Aragón (context + corroboration).
export const GDACS_WF_URL =
  "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP?eventtypes=WF";
/** ISO3 country codes whose GDACS wildfire alerts we retain. */
export const GDACS_KEEP_ISO3 = ["ESP"] as const;

// AEMET avisos (CAP 1.2) — Spain's official adverse-weather warnings. OpenData
// area code 62 = Aragón (61 is Andalucía, etc.). `ultimoelaborado` returns a
// JSON pointer whose `datos` URL is a POSIX tar of one CAP XML per phenomenon.
// Requires the same AEMET_API_KEY already used for the lightning feed.
export const AEMET_AVISOS_AREA = "62"; // Aragón
export const AEMET_AVISOS_URL = (area: string, key: string) =>
  `https://opendata.aemet.es/opendata/api/avisos_cap/ultimoelaborado/area/${area}?api_key=${key}`;
/** AEMET Meteoalerta phenomenon codes that drive/represent wildfire risk. */
export const AEMET_FIRE_PHENOMENA = ["AT", "VI", "TO"] as const; // heat, wind, thunderstorm

// --- AI briefing agent (Phase 4) --------------------------------------------
// A single LLM call turns an above-threshold event into a plain-language
// operational briefing + structured JSON. Called DIRECTLY (no AI Gateway) to
// avoid extra moving parts. The reasoning layer is provider-agnostic: both Groq
// and OpenAI expose an OpenAI-compatible endpoint + strict Structured Outputs,
// so swapping providers means flipping AI_PROVIDER only.
//
// Provider: GROQ by default. Validated 2026-07-13 that Groq `gpt-oss-120b` is
// ~5× faster than OpenAI `gpt-5-mini` (median ~1.5 s vs ~7 s), with much tighter
// latency variance and equal/better structured quality. Flip to "openai" to revert.
export const AI_PROVIDER: "groq" | "openai" = "groq";

const AI_ENDPOINTS = {
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b", effort: "low" },
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-5-mini", effort: "minimal" },
} as const;

export const AI_URL = AI_ENDPOINTS[AI_PROVIDER].url;
export const AI_MODEL = AI_ENDPOINTS[AI_PROVIDER].model;
// Reasoning stays low/minimal on purpose: the deterministic engine already did the
// analysis, so the model only needs to phrase it well. A stronger, explicit prompt
// carries the load (see src/ai/briefing.ts). Bump the effort if briefings need
// deeper synthesis (costs latency).
export const AI_REASONING_EFFORT = AI_ENDPOINTS[AI_PROVIDER].effort;
// Bound the call so a cron pass can't hang. A call returns in a few seconds; keep
// headroom. If it aborts, the briefing stays null and the next engine pass retries
// it (self-healing — the engine only briefs events with none).
export const AI_TIMEOUT_MS = 30_000;

// --- Telegram operational alerts (Phase 5) ----------------------------------
// The bot pushes each new event whose AI briefing priority meets the threshold to
// an operations chat. Best-effort + self-healing like the briefing; dedup via
// event.notified_at. Bot token + chat id are secrets (see types.ts / .dev.vars).
export const TELEGRAM_API = (token: string, method: string) =>
  `https://api.telegram.org/bot${token}/${method}`;
/** Priority ordering; a briefing is notified when its rank ≥ min_priority's rank. */
export const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
/** Default notify threshold; override live via KV `notify_config` {"min_priority":"..."}. */
export const DEFAULT_MIN_PRIORITY = "high";
/** Public origin used to build the map deep-link inside each alert. */
export const PUBLIC_ORIGIN = "https://geospatial-platform.diegoromero.es";
/** Cap notifications per engine pass (Telegram is generous; symmetry + burst guard). */
export const MAX_NOTIFICATIONS_PER_RUN = 5;
export const TELEGRAM_TIMEOUT_MS = 15_000;
