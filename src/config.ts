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
export const FIRMS_SOURCE = "VIIRS_SNPP_NRT";
export const FIRMS_DAY_RANGE = 1; // last N days
export const FIRMS_NOMINAL_RESOLUTION_M = 375; // VIIRS I-band pixel
/** VIIRS confidence letters -> numeric [0,1]. */
export const FIRMS_CONFIDENCE: Record<string, number> = { l: 0.3, n: 0.6, h: 0.9 };

// --- Fire weather -----------------------------------------------------------
/**
 * Sampling grid over the bbox (points per axis). 15 -> 225 samples (~15 km),
 * fetched in a single Open-Meteo bulk call. Kept < ~500 so the GET URL stays
 * under the server's ~8 KB limit (600+ coords returns HTTP 414).
 */
export const WEATHER_GRID_STEPS = 15;

/** Classic Triple-30 operational indicator (one signal, not the sole rule). */
export const TRIPLE30 = { tempC: 30, windKmh: 30, rhPct: 30 } as const;
