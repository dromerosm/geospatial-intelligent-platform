// Phase 2 — Digital Twin batch build (build-time, NOT runtime).
//
// Enumerates the H3 res-7 cells covering Aragón and enriches each with:
//   - terrain: elevation -> steepest-descent slope + aspect  (Open-Meteo, real)
//   - infrastructure: distance to nearest critical asset      (OSM Overpass, best-effort)
//   - population_nearby: population of settlements within 10 km (OSM, best-effort)
//
// land_cover / fuel_type / hist_fire_flag are left NULL in v1 (see docs/architecture.md).
//
// Output: SQL (INSERT OR REPLACE) written to the path in --out (default tmp/digital-twin.sql).
// Apply with:  wrangler d1 execute geospatial-db --remote --file tmp/digital-twin.sql
//
// Usage: node scripts/build-digital-twin.mjs [--out tmp/digital-twin.sql]

import { cellToLatLng, gridDisk, polygonToCells } from "h3-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RES = 7; // must match src/config.ts H3_RESOLUTION (observations are indexed at res 7)
const POP_RADIUS_M = 10_000;
const OUT = argValue("--out") ?? "tmp/digital-twin.sql";
const UA = "geospatial-platform/0.1 (https://github.com/dromerosm/geospatial-intelligent-platform)";

const R = 6_371_000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function haversine([la1, lo1], [la2, lo2]) {
  const dLat = toRad(la2 - la1);
  const dLon = toRad(lo2 - lo1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearing([la1, lo1], [la2, lo2]) {
  const y = Math.sin(toRad(lo2 - lo1)) * Math.cos(toRad(la2));
  const x =
    Math.cos(toRad(la1)) * Math.sin(toRad(la2)) -
    Math.sin(toRad(la1)) * Math.cos(toRad(la2)) * Math.cos(toRad(lo2 - lo1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// --- 1. Region boundary -----------------------------------------------------
async function aragonBoundary() {
  const url =
    "https://nominatim.openstreetmap.org/search?q=Arag%C3%B3n&countrycodes=es" +
    "&format=json&polygon_geojson=1&limit=1";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  if (!data[0]?.geojson) throw new Error("No boundary geometry returned");
  console.error(`Boundary: ${data[0].display_name}`);
  return data[0].geojson;
}

function cellsForBoundary(geojson) {
  const polys = geojson.type === "MultiPolygon" ? geojson.coordinates : [geojson.coordinates];
  const cells = new Set();
  for (const poly of polys) for (const h of polygonToCells(poly, RES, true)) cells.add(h);
  return [...cells];
}

function bboxOf(geojson) {
  let s = 90, w = 180, n = -90, e = -180;
  const polys = geojson.type === "MultiPolygon" ? geojson.coordinates : [geojson.coordinates];
  for (const poly of polys)
    for (const [lng, lat] of poly[0]) {
      s = Math.min(s, lat); n = Math.max(n, lat);
      w = Math.min(w, lng); e = Math.max(e, lng);
    }
  return { s, w, n, e };
}

// --- 2. Terrain (Open-Elevation, bulk POST, checkpointed) -------------------
// Open-Elevation accepts large POST batches with no hourly cap. We checkpoint to
// tmp/elevations.json so the build is resumable and re-runs are near-free.
const ELEV_CACHE = "tmp/elevations.json";
const ELEV_CHUNK = 200;

async function elevations(cells) {
  const elev = new Map(existsSync(ELEV_CACHE) ? Object.entries(JSON.parse(readFileSync(ELEV_CACHE, "utf8"))) : []);
  const todo = cells.filter((c) => !elev.has(c));
  console.error(`  cached: ${elev.size}, to fetch: ${todo.length}`);

  for (let i = 0; i < todo.length; i += ELEV_CHUNK) {
    const batch = todo.slice(i, i + ELEV_CHUNK);
    const locations = batch.map((c) => {
      const [latitude, longitude] = cellToLatLng(c);
      return { latitude, longitude };
    });

    let results;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch("https://api.open-elevation.com/api/v1/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": UA },
          body: JSON.stringify({ locations }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        results = (await res.json()).results;
        break;
      } catch (err) {
        if (attempt >= 5) throw new Error(`Open-Elevation failed: ${err.message}`);
        console.error(`  chunk retry (${err.message}), waiting 10s...`);
        await sleep(10_000);
      }
    }

    batch.forEach((c, idx) => elev.set(c, results[idx].elevation));
    writeFileSync(ELEV_CACHE, JSON.stringify(Object.fromEntries(elev)));
    console.error(`  elevation ${Math.min(i + ELEV_CHUNK, todo.length)}/${todo.length}`);
    await sleep(500);
  }
  return elev;
}

// Steepest-descent slope + aspect over the ~1.4 km H3 neighbourhood.
function terrain(cell, elev) {
  const c = cellToLatLng(cell);
  const zc = elev.get(cell);
  let bestGrad = 0;
  let aspect = null;
  for (const n of gridDisk(cell, 1)) {
    if (n === cell) continue;
    const zn = elev.get(n);
    if (zn == null) continue;
    const d = haversine(c, cellToLatLng(n));
    if (d === 0) continue;
    const grad = (zc - zn) / d; // >0 => neighbour is downhill
    if (grad > bestGrad) {
      bestGrad = grad;
      aspect = bearing(c, cellToLatLng(n));
    }
  }
  return {
    slopeDeg: Math.round(toDeg(Math.atan(bestGrad)) * 10) / 10,
    aspectDeg: aspect == null ? null : Math.round(aspect),
  };
}

// --- 3. Infrastructure (OSM Overpass, best-effort) --------------------------
async function osmAssets(bbox) {
  const bb = `${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
  const query = `[out:json][timeout:180];
(
  node["amenity"="fire_station"](${bb});
  way["amenity"="fire_station"](${bb});
  node["power"="substation"](${bb});
  way["power"="substation"](${bb});
  node["place"~"^(city|town|village)$"](${bb});
);
out center tags;`;
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "User-Agent": UA },
    body: query,
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const data = await res.json();
  const assets = [];
  const settlements = [];
  for (const el of data.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    assets.push([lat, lng]);
    const pop = Number.parseInt(el.tags?.population ?? "", 10);
    if (Number.isFinite(pop)) settlements.push({ pt: [lat, lng], pop });
  }
  return { assets, settlements };
}

function distAndPop(cell, assets, settlements) {
  if (assets.length === 0) return { distAssetM: null, popNearby: null };
  const c = cellToLatLng(cell);
  let nearest = Infinity;
  for (const a of assets) {
    const d = haversine(c, a);
    if (d < nearest) nearest = d;
  }
  let pop = 0;
  for (const s of settlements) if (haversine(c, s.pt) <= POP_RADIUS_M) pop += s.pop;
  return { distAssetM: Math.round(nearest), popNearby: pop };
}

// --- 4. Emit SQL ------------------------------------------------------------
function toSql(rows) {
  const num = (v) => (v == null ? "NULL" : v);
  const lines = ["-- Digital Twin for Aragón (generated by scripts/build-digital-twin.mjs)"];
  for (let i = 0; i < rows.length; i += 100) {
    const values = rows
      .slice(i, i + 100)
      .map(
        (r) =>
          `('${r.cell}',NULL,NULL,${num(r.slopeDeg)},${num(r.aspectDeg)},` +
          `${num(r.popNearby)},${num(r.distAssetM)},0)`,
      )
      .join(",");
    lines.push(
      "INSERT OR REPLACE INTO digital_twin_cell " +
        "(h3_cell,land_cover,fuel_type,slope_deg,aspect_deg,population_nearby,dist_asset_m,hist_fire_flag) " +
        `VALUES ${values};`,
    );
  }
  return lines.join("\n") + "\n";
}

// --- main -------------------------------------------------------------------
async function main() {
  const boundary = await aragonBoundary();
  const cells = cellsForBoundary(boundary);
  console.error(`Cells (H3 res ${RES}): ${cells.length}`);

  console.error("Fetching elevation...");
  const elev = await elevations(cells);

  let assets = [];
  let settlements = [];
  try {
    console.error("Fetching OSM assets (Overpass)...");
    ({ assets, settlements } = await osmAssets(bboxOf(boundary)));
    console.error(`  assets: ${assets.length}, settlements w/ population: ${settlements.length}`);
  } catch (err) {
    console.error(`  Overpass failed (${err.message}) — infra fields left NULL`);
  }

  const rows = cells.map((cell) => {
    const t = terrain(cell, elev);
    const dp = distAndPop(cell, assets, settlements);
    return { cell, ...t, ...dp };
  });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, toSql(rows));

  const withInfra = rows.filter((r) => r.distAssetM != null).length;
  console.error(
    `\nDone. ${rows.length} cells -> ${OUT}\n` +
      `  slope populated: ${rows.filter((r) => r.slopeDeg != null).length}\n` +
      `  infra populated: ${withInfra}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
