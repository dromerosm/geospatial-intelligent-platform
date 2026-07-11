// Prototype build step — turn the Digital Twin SQL into a GeoJSON layer.
//
// Reads the INSERT rows from ../tmp/digital-twin.sql, converts each H3 res-7
// cell to its boundary polygon (h3-js), and writes a GeoJSON FeatureCollection
// carrying every Digital Twin field per cell: land cover + fuel class, slope,
// population + density, distance-to-asset, historical-fire flag, and the
// predominant municipality — all read straight from the SQL (the main generator,
// scripts/build-digital-twin.mjs, already computed them). Fully offline: only
// needs the SQL file and h3-js — no INE / D1 / Worker calls.
//
// Usage: node prototype/build-geojson.mjs

import { cellToBoundary, cellToLatLng } from "h3-js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_IN = join(HERE, "..", "tmp", "digital-twin.sql");
const OUT = join(HERE, "data", "aragon-density.geojson");

// Columns emitted by scripts/build-digital-twin.mjs toSql(), in order:
const COLUMNS = [
  "h3", "land_cover", "fuel_type", "slope_deg", "aspect_deg",
  "population", "density", "dist_asset_m", "hist_fire_flag", "municipio",
];

// Parse the SQL VALUES tuples. A hand tokenizer (not a regex) because string
// fields such as land_cover contain commas and '' escapes — e.g.
//   'Land principally occupied by agriculture, with significant areas...'
function* parseTuples(sql) {
  let i = 0;
  while (i < sql.length) {
    if (sql[i] !== "(") { i++; continue; }
    i++; // skip '('
    const fields = [];
    let cur = "";
    let quoted = false;
    let inStr = false;
    while (i < sql.length) {
      const ch = sql[i];
      if (inStr) {
        if (ch === "'" && sql[i + 1] === "'") { cur += "'"; i += 2; continue; }
        if (ch === "'") { inStr = false; i++; continue; }
        cur += ch; i++; continue;
      }
      if (ch === "'") { inStr = true; quoted = true; i++; continue; }
      if (ch === ",") { fields.push(quoted ? cur : cur.trim()); cur = ""; quoted = false; i++; continue; }
      if (ch === ")") { fields.push(quoted ? cur : cur.trim()); i++; break; }
      cur += ch; i++;
    }
    // Only cell rows: 10 fields whose first looks like an H3 index.
    if (fields.length === COLUMNS.length && /^[0-9a-f]+$/.test(fields[0])) yield fields;
  }
}

const val = (s) => (s == null || s === "" || s === "NULL" ? null : s);
const num = (s) => (val(s) == null ? null : Number(s));

function main() {
  const sql = readFileSync(SQL_IN, "utf8");
  const features = [];
  let densMin = Infinity, densMax = -Infinity, popTotal = 0, labelled = 0, fires = 0;

  for (const f of parseTuples(sql)) {
    const [h3, landCover, fuelType, slope, aspect, population, density, dist, hist, municipio] = f;
    const pop = num(population) ?? 0;
    const dens = num(density) ?? 0;
    const [lat, lng] = cellToLatLng(h3);
    if (val(municipio)) labelled++;
    if (num(hist)) fires++;
    features.push({
      type: "Feature",
      properties: {
        h3,
        land_cover: val(landCover),
        fuel_type: val(fuelType),
        slope_deg: num(slope),
        population: pop,
        density: dens,
        dist_asset_m: num(dist),
        hist_fire: num(hist) ? 1 : 0,
        municipio: val(municipio),
        lat: Math.round(lat * 1e5) / 1e5,
        lng: Math.round(lng * 1e5) / 1e5,
      },
      geometry: { type: "Polygon", coordinates: [cellToBoundary(h3, true)] }, // [lng,lat] closed ring
    });
    densMin = Math.min(densMin, dens);
    densMax = Math.max(densMax, dens);
    popTotal += pop;
  }

  if (features.length === 0) {
    throw new Error(`No cells parsed from ${SQL_IN} — is the Digital Twin built (npm run twin:build)?`);
  }

  writeFileSync(OUT, JSON.stringify({
    type: "FeatureCollection",
    metadata: {
      source: "Aragón Digital Twin (INE 2025 population, CORINE land cover, EFFIS fire history) at H3 res-7",
      cells: features.length,
      populationTotal: popTotal,
      densityMin: densMin,
      densityMax: densMax,
      generatedFrom: "tmp/digital-twin.sql",
    },
    features,
  }));

  console.error(
    `Wrote ${OUT}\n` +
      `  cells: ${features.length}\n` +
      `  with municipality: ${labelled} (${Math.round((labelled / features.length) * 100)}%)\n` +
      `  hist-fire cells: ${fires}\n` +
      `  population (sum of cells): ${popTotal.toLocaleString("es-ES")}\n` +
      `  density people/km²: min ${densMin}, max ${densMax}`,
  );
}

main();
