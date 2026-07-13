// Shared types.

/** Worker bindings (see wrangler.jsonc). */
export interface Env {
  DB: D1Database;
  CONFIG: KVNamespace;
  RAW: R2Bucket;
  REGION: string;
  // Hard rate limiter for the API endpoints (native Workers Rate Limiting).
  API_RL: RateLimit;
  // Secrets (via .dev.vars locally / `wrangler secret put` in prod).
  FIRMS_MAP_KEY: string;
  AEMET_API_KEY: string;
  // Phase 4: key for the briefing agent (provider chosen in config.ts). Optional —
  // when the active provider's key is unset the engine still runs deterministically
  // and simply leaves briefings null.
  OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
}

/**
 * Normalised detection from any feed. Mirrors the "Observation model" in the
 * spec: we never claim more precision than the source provides.
 */
export interface Observation {
  id: string;
  source: string;
  acquiredAt: string; // ISO-8601 UTC
  ingestedAt: string;
  h3Cell: string;
  footprintGeojson: string | null;
  nominalResolutionM: number;
  geolocationUncertaintyM: number | null;
  confidence: number | null; // [0,1]
  rawR2Key: string | null;
  props: Record<string, unknown>;
}

/**
 * A discrete authoritative alert/warning issued by an external agency (GDACS,
 * AEMET). Normalised so GDACS wildfire events and AEMET CAP warnings share one
 * shape. Expiring, unlike the per-cell grids. See migrations/0009.
 */
export interface HazardAlert {
  id: string; // deterministic: source + native id
  source: "GDACS" | "AEMET_CAP";
  category: string; // wildfire | heat | wind | thunderstorm | cold | rain | snow | coastal | other
  fireRelevant: 0 | 1;
  severity: string | null; // minor | moderate | severe | extreme
  severityNum: number | null; // [0,1]
  levelLabel: string | null; // native: verde/amarillo/naranja/rojo | Green/Orange/Red
  headline: string | null;
  areaDesc: string | null;
  inRegion: 0 | 1; // overlaps the Aragón bbox
  onset: string | null;
  expires: string | null;
  lat: number | null;
  lng: number | null;
  url: string | null;
  rawR2Key: string | null;
  ingestedAt: string;
  props: Record<string, unknown>;
}

/** Latest fire weather for one cell. */
export interface FireWeather {
  h3Cell: string;
  updatedAt: string;
  tempC: number;
  rhPct: number;
  windKmh: number;
  windDirDeg: number;
  rainMm: number;
  fuelMoistureProxy: number;
  triple30: 0 | 1;
  /** Compact 3-day hourly forecast (Open-Meteo) as JSON. */
  forecastJson: string;
}
