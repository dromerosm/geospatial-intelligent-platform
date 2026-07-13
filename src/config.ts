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
