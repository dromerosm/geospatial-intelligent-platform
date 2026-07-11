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
