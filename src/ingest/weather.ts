// Fire-weather ingestion from Open-Meteo (free, no API key). We sample a coarse
// grid over the bbox, fetch current conditions in one call, and map each sample
// to its H3 cell. Per-cell interpolation is a later refinement.
import { ARAGON_BBOX, TRIPLE30, WEATHER_GRID_STEPS } from "../config.js";
import { cellFor } from "../lib/h3.js";
import type { FireWeather } from "../types.js";

/** Evenly spaced sample points across the bbox. */
export function weatherGrid(steps = WEATHER_GRID_STEPS): { lat: number; lng: number }[] {
  const { west, south, east, north } = ARAGON_BBOX;
  const pts: { lat: number; lng: number }[] = [];
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const lat = south + ((north - south) * (i + 0.5)) / steps;
      const lng = west + ((east - west) * (j + 0.5)) / steps;
      pts.push({ lat, lng });
    }
  }
  return pts;
}

/**
 * Placeholder fuel-moisture proxy in [0,1] (higher = moister/safer). v1 uses
 * relative humidity; replace with an EFFIS/FWI component in a later phase.
 */
function fuelMoistureProxy(rhPct: number): number {
  return Math.round((rhPct / 100) * 100) / 100;
}

export async function fetchFireWeather(updatedAt: string): Promise<FireWeather[]> {
  const grid = weatherGrid();
  const lats = grid.map((p) => p.lat.toFixed(3)).join(",");
  const lngs = grid.map((p) => p.lng.toFixed(3)).join(",");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lngs}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation` +
    `&wind_speed_unit=kmh`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
  // Multiple coordinates -> array; single -> object. Normalise to array.
  const body = await res.json<any>();
  const items = Array.isArray(body) ? body : [body];

  return items.map((item, idx) => {
    const c = item.current;
    const tempC = c.temperature_2m;
    const rhPct = c.relative_humidity_2m;
    const windKmh = c.wind_speed_10m;
    const triple30: 0 | 1 =
      tempC > TRIPLE30.tempC && windKmh > TRIPLE30.windKmh && rhPct < TRIPLE30.rhPct ? 1 : 0;
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
    };
  });
}
