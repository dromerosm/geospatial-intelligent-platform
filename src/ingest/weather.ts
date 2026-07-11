// Fire-weather ingestion from Open-Meteo (free, no API key). Sample points are a
// surface-uniform grid clipped to the Aragón boundary (src/weather-points.json,
// built by scripts/build-weather-grid.mjs). For each point we fetch current
// conditions + a 3-day hourly forecast in bulk (comma-separated coordinates),
// chunked to keep each GET URL under the server's ~8 KB limit. Each point is
// mapped to its H3 cell; Phase 3 resolves the nearest point to a detection.
import { TRIPLE30 } from "../config.js";
import { cellFor } from "../lib/h3.js";
import type { FireWeather } from "../types.js";
import WEATHER_POINTS from "../weather-points.json";

/** ~8 km surface-uniform sample points, all inside Aragón. */
export function weatherGrid(): { lat: number; lng: number }[] {
  return WEATHER_POINTS as { lat: number; lng: number }[];
}

/** Max coordinates per Open-Meteo GET call (URL length ~8 KB caps at ~500). */
const BULK_CHUNK = 500;

/**
 * Placeholder fuel-moisture proxy in [0,1] (higher = moister/safer). v1 uses
 * relative humidity; replace with an EFFIS/FWI component in a later phase.
 */
function fuelMoistureProxy(rhPct: number): number {
  return Math.round((rhPct / 100) * 100) / 100;
}

const round1 = (a: number[]): number[] => a.map((v) => Math.round(v * 10) / 10);

export async function fetchFireWeather(updatedAt: string): Promise<FireWeather[]> {
  const grid = weatherGrid();
  const vars = "temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation";

  // Fetch in chunks (URL-length limit) and concatenate in order so items[idx]
  // still lines up with grid[idx].
  const items: any[] = [];
  for (let i = 0; i < grid.length; i += BULK_CHUNK) {
    const chunk = grid.slice(i, i + BULK_CHUNK);
    const lats = chunk.map((p) => p.lat.toFixed(3)).join(",");
    const lngs = chunk.map((p) => p.lng.toFixed(3)).join(",");
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}` +
      `&current=${vars}&hourly=${vars}&forecast_days=3&wind_speed_unit=kmh`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
    const body = await res.json<any>();
    items.push(...(Array.isArray(body) ? body : [body]));
  }

  return items.map((item, idx) => {
    const c = item.current;
    const h = item.hourly;
    const tempC = c.temperature_2m;
    const rhPct = c.relative_humidity_2m;
    const windKmh = c.wind_speed_10m;
    const triple30: 0 | 1 =
      tempC > TRIPLE30.tempC && windKmh > TRIPLE30.windKmh && rhPct < TRIPLE30.rhPct ? 1 : 0;
    // Compact 3-day hourly forecast (72 steps) stored per point for Phase 3.
    const forecastJson = JSON.stringify({
      t0: h.time[0],
      step_h: 1,
      temp_c: round1(h.temperature_2m),
      rh_pct: h.relative_humidity_2m,
      wind_kmh: round1(h.wind_speed_10m),
      wind_dir_deg: h.wind_direction_10m,
      rain_mm: round1(h.precipitation),
    });
    return {
      h3Cell: cellFor(grid[idx].lat, grid[idx].lng),
      updatedAt,
      tempC,
      rhPct,
      windKmh,
      windDirDeg: c.wind_direction_10m,
      rainMm: c.precipitation,
      fuelMoistureProxy: fuelMoistureProxy(rhPct),
      triple30,
      forecastJson,
    };
  });
}
