// Phase 2 — Digital Twin batch build (build-time, NOT runtime).
//
// Enumerates the H3 res-7 cells covering Aragón and enriches each with:
//   - terrain: elevation -> steepest-descent slope + aspect  (Open-Elevation, real)
//   - population + population_density + age bands pop_child (0-14) /
//     pop_adult (15-64) / pop_elderly (65+): INE Censo Anual 2025 by census
//     section (both sexes), areally interpolated to H3 via res-9 subcells
//     (authoritative, ref 1-Jan-2025). child + adult + elderly = population.
//   - municipio: predominant municipality per cell (INE section NMUN/NPRO,
//     majority of res-9 subcells) — labelling/context only, not a scoring input
//   - land_cover + fuel_type: CORINE Land Cover 2018 (EEA Identify) -> fuel class
//   - hist_fire_flag: EFFIS burnt-area perimeters intersecting the cell
//   - dist_asset_m: distance to nearest OSM asset (fire station, substation,
//     settlement) via Overpass (best-effort)
//
// Output: SQL (INSERT OR REPLACE) written to --out (default tmp/digital-twin.sql).
// Apply with:  wrangler d1 execute geospatial-db --remote --file tmp/digital-twin.sql
//
// Usage: node scripts/build-digital-twin.mjs [--out tmp/digital-twin.sql]

import { cellArea, cellToLatLng, cellToParent, gridDisk, latLngToCell, polygonToCells } from "h3-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RES = 7; // must match src/config.ts H3_RESOLUTION (observations are indexed at res 7)
const INTERP_RES = 9; // subcell resolution for areal population interpolation (~0.1 km²)
const OUT = argValue("--out") ?? "tmp/digital-twin.sql";
const UA = "geospatial-platform/0.1 (https://github.com/dromerosm/geospatial-intelligent-platform)";

// INE OGC API Features — census-section geometry (2025 vintage).
const INE_OGC = "https://www.ine.es/geoserver/ogc/features/v1/collections";
const SECTIONS_COLLECTION = "WMS_INE_SECCIONES_G01:Secciones_2025";
// INE Censo Anual jaxiT3 section tables, one per Aragón province (CSV download).
const INE_POP_TABLES = { Huesca: 69193, Zaragoza: 69289, Teruel: 69345 };
const CENSUS_YEAR = "2025";

// CORINE Land Cover 2018 (Copernicus/EEA) — per-cell class via ArcGIS Identify.
const CLC_BASE = "https://image.discomap.eea.europa.eu/arcgis/rest/services/Corine/CLC2018_WM/MapServer";
const LC_CACHE = "tmp/landcover.json";
const LC_CONCURRENCY = 6;
// EFFIS burnt-area perimeters (Copernicus) — for historical fire occurrence.
const EFFIS_WFS = "https://maps.effis.emergency.copernicus.eu/effis";

// CLC CODE_18 -> wildfire fuel class. Ranges cover the 44-class nomenclature.
const FUEL_BY_CODE = {
  312: "very_high", // coniferous forest
  311: "medium", 313: "high", // broadleaved / mixed forest
  322: "high", 323: "high", 324: "high", // moors & heath / sclerophyllous / transitional woodland-shrub
  321: "medium", 231: "medium", 243: "medium", 244: "medium", 333: "medium", // grassland/pasture/agroforestry/sparse
};
function fuelFromCode(code) {
  if (code == null) return null;
  if (FUEL_BY_CODE[code]) return FUEL_BY_CODE[code];
  if (code >= 211 && code <= 242) return "low"; // arable land, permanent crops
  if (code >= 111 && code <= 142) return "none"; // artificial surfaces
  if (code >= 331 && code <= 335) return "low"; // bare / beaches / burnt / glaciers
  if (code >= 411 && code <= 523) return "none"; // wetlands / water
  return "low";
}

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

// --- 3. Population (INE Censo Anual 2025, by census section) -----------------
// Geometry from the INE OGC API; population from the per-province jaxiT3 tables;
// areally interpolated onto H3 res-7 cells through res-9 subcells.
async function fetchSections() {
  const enc = encodeURIComponent(SECTIONS_COLLECTION);
  const filter = encodeURIComponent("CCA='02' AND TIPO='SECCIONADO'"); // 02 = Aragón
  const url =
    `${INE_OGC}/${enc}/items?f=application/json&limit=3000` +
    `&filter-lang=cql2-text&filter=${filter}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`INE OGC ${res.status}`);
  const fc = await res.json();
  return fc.features; // GeoJSON (CRS84 lon/lat), properties.CUSEC
}

// Lower bound of an INE five-year age label: "De 65 a 69 años" -> 65,
// "100 y más años" -> 100, "Todas las edades" -> null.
function ageBandLower(edad) {
  const m = edad.match(/^De (\d+)/) ?? edad.match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

// Per section (both sexes): total plus the two dependency bands, children (0-14)
// and elderly (65+). Working-age adults (15-64) are the residual at emit time so
// child + adult + elderly = population exactly.
async function fetchSectionPopulation() {
  const pop = new Map(); // CUSEC -> { total, child, elderly }
  for (const [prov, id] of Object.entries(INE_POP_TABLES)) {
    const res = await fetch(`https://www.ine.es/jaxiT3/files/t/es/csv_bdsc/${id}.csv`);
    if (!res.ok) throw new Error(`INE table ${id} (${prov}) ${res.status}`);
    const text = await res.text();
    let count = 0;
    for (const line of text.split("\n")) {
      const col = line.split(";");
      // Provincias;Municipios;Secciones;Sexo;Edad;Periodo;Total
      if (col.length < 7 || !col[2]) continue; // section rows only
      if (col[3] !== "Total" || col[5] !== CENSUS_YEAR) continue; // both sexes, 2025
      const cusec = col[2].split(" ")[0];
      const v = Number(col[6].replace(/\./g, "").replace(/"/g, "").trim()) || 0;
      let rec = pop.get(cusec);
      if (!rec) { rec = { total: 0, child: 0, elderly: 0 }; pop.set(cusec, rec); count++; }
      if (col[4] === "Todas las edades") { rec.total = v; continue; }
      const lo = ageBandLower(col[4]);
      if (lo == null) continue;
      if (lo < 15) rec.child += v;
      else if (lo >= 65) rec.elderly += v;
    }
    console.error(`  ${prov} (table ${id}): ${count} sections`);
  }
  return pop;
}

function ringCentroid(ring) {
  let lng = 0, lat = 0;
  for (const [x, y] of ring) { lng += x; lat += y; }
  return [lng / ring.length, lat / ring.length];
}

// Distribute each section's population over the H3 res-7 cells it covers,
// weighted by area via equal-area res-9 subcells.
function populationByCell(sections, popMap) {
  const pop7 = new Map(); // cell -> { total, child, elderly }
  let matched = 0, unmatched = 0, assigned = 0;
  const add = (cell, rec, w) => {
    let a = pop7.get(cell);
    if (!a) { a = { total: 0, child: 0, elderly: 0 }; pop7.set(cell, a); }
    a.total += rec.total * w;
    a.child += rec.child * w;
    a.elderly += rec.elderly * w;
  };
  for (const f of sections) {
    const rec = popMap.get(f.properties.CUSEC);
    if (rec == null) { unmatched++; continue; }
    matched++;
    const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    const children = new Set();
    for (const poly of polys) for (const h of polygonToCells(poly, INTERP_RES, true)) children.add(h);
    if (children.size === 0) {
      const [lng, lat] = ringCentroid(polys[0][0]);
      add(latLngToCell(lat, lng, RES), rec, 1);
    } else {
      const w = 1 / children.size;
      for (const child of children) add(cellToParent(child, RES), rec, w);
    }
    assigned += rec.total;
  }
  console.error(`  sections matched: ${matched}, unmatched: ${unmatched}, population distributed: ${Math.round(assigned)}`);
  return pop7;
}

// "Municipio (Provincia)"; drop the parenthetical for the homonymous capital.
function municipioLabel(p) {
  return p.NPRO && p.NPRO !== p.NMUN ? `${p.NMUN} (${p.NPRO})` : p.NMUN;
}

// Predominant municipality per H3 res-7 cell: rasterise each section to res-9
// subcells (as populationByCell does) and let the majority municipio win. Uses
// the section attributes (NMUN/NPRO) already present in the fetched geometry —
// no extra request. Cells outside every section stay unlabelled (null).
function municipioByCell(sections) {
  const votes = new Map(); // res-7 cell -> Map(label -> subcell count)
  for (const f of sections) {
    const label = municipioLabel(f.properties);
    if (!label || !f.geometry) continue;
    const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const poly of polys)
      for (const child of polygonToCells(poly, INTERP_RES, true)) {
        const parent = cellToParent(child, RES);
        let v = votes.get(parent);
        if (!v) { v = new Map(); votes.set(parent, v); }
        v.set(label, (v.get(label) ?? 0) + 1);
      }
  }
  const muni = new Map();
  for (const [cell, v] of votes) {
    let best = null, bestN = 0;
    for (const [l, n] of v) if (n > bestN) { bestN = n; best = l; }
    muni.set(cell, best);
  }
  return muni;
}

// --- 3b. Land cover + fuel (CORINE CLC2018, per-cell Identify) --------------
async function mapPool(items, concurrency, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function identifyCLC(lat, lng) {
  const ext = `${lng - 0.01},${lat - 0.01},${lng + 0.01},${lat + 0.01}`;
  const url =
    `${CLC_BASE}/identify?f=json&geometry=${lng},${lat}&geometryType=esriGeometryPoint` +
    `&sr=4326&layers=all&tolerance=1&mapExtent=${ext}&imageDisplay=50,50,96&returnGeometry=false`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const results = (await res.json()).results ?? [];
      const rast = results.find((r) => r.attributes && r.attributes["Raster.CODE_18"]);
      if (rast) return { code: Number(rast.attributes["Raster.CODE_18"]), label: rast.attributes["Raster.LABEL3"] };
      const vec = results.find((r) => /^\d+$/.test(r.value ?? ""));
      if (vec) return { code: Number(vec.value), label: vec.layerName };
      return null; // outside CLC extent (e.g. water) -> no class
    } catch (err) {
      if (attempt >= 4) { console.error(`  CLC fail ${lat},${lng}: ${err.message}`); return null; }
      await sleep(3000);
    }
  }
}

async function fetchLandCover(cells) {
  const cache = new Map(existsSync(LC_CACHE) ? Object.entries(JSON.parse(readFileSync(LC_CACHE, "utf8"))) : []);
  const todo = cells.filter((c) => !cache.has(c));
  console.error(`  landcover cached: ${cache.size}, to fetch: ${todo.length}`);
  let done = 0;
  await mapPool(todo, LC_CONCURRENCY, async (cell) => {
    const [lat, lng] = cellToLatLng(cell);
    cache.set(cell, await identifyCLC(lat, lng));
    if (++done % 500 === 0) {
      writeFileSync(LC_CACHE, JSON.stringify(Object.fromEntries(cache)));
      console.error(`  landcover ${done}/${todo.length}`);
    }
  });
  writeFileSync(LC_CACHE, JSON.stringify(Object.fromEntries(cache)));
  return cache;
}

// --- 3c. Historical fire (EFFIS burnt-area perimeters) ----------------------
async function burntAreaCells(bbox) {
  const url =
    `${EFFIS_WFS}?service=WFS&version=1.0.0&request=GetFeature&typename=ms:modis.ba.poly` +
    `&bbox=${bbox.w},${bbox.s},${bbox.e},${bbox.n}&outputformat=geojson`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`EFFIS ${res.status}`);
  const fc = await res.json();
  const cells = new Set();
  for (const f of fc.features ?? []) {
    if (!f.geometry) continue;
    const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const poly of polys) {
      // EFFIS WFS 1.0.0 GeoJSON emits [lat, lng]; polygonToCells expects [lng, lat].
      const rings = poly.map((ring) => ring.map(([lat, lng]) => [lng, lat]));
      for (const h of polygonToCells(rings, RES, true)) cells.add(h);
    }
  }
  console.error(`  burnt areas: ${(fc.features ?? []).length} perimeters -> ${cells.size} cells`);
  return cells;
}

// --- 4. Infrastructure (OSM Overpass, best-effort) --------------------------
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

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
out center;`;
  let data;
  for (const url of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "User-Agent": UA },
        body: query,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      break;
    } catch (err) {
      console.error(`  Overpass ${url} failed (${err.message}), trying next...`);
      await sleep(5000);
    }
  }
  if (!data) throw new Error("all Overpass mirrors failed");
  const assets = [];
  for (const el of data.elements) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat != null && lng != null) assets.push([lat, lng]);
  }
  return assets;
}

function nearestAsset(cell, assets) {
  if (assets.length === 0) return null;
  const c = cellToLatLng(cell);
  let nearest = Infinity;
  for (const a of assets) {
    const d = haversine(c, a);
    if (d < nearest) nearest = d;
  }
  return Math.round(nearest);
}

// --- 5. Emit SQL ------------------------------------------------------------
function toSql(rows) {
  const num = (v) => (v == null ? "NULL" : v);
  const str = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  const lines = ["-- Digital Twin for Aragón (generated by scripts/build-digital-twin.mjs)"];
  for (let i = 0; i < rows.length; i += 100) {
    const values = rows
      .slice(i, i + 100)
      .map(
        (r) =>
          `('${r.cell}',${str(r.landCover)},${str(r.fuelType)},${num(r.slopeDeg)},${num(r.aspectDeg)},` +
          `${num(r.population)},${num(r.density)},${num(r.distAssetM)},${r.histFire},${str(r.municipio)},` +
          `${num(r.popChild)},${num(r.popAdult)},${num(r.popElderly)})`,
      )
      .join(",");
    lines.push(
      "INSERT OR REPLACE INTO digital_twin_cell " +
        "(h3_cell,land_cover,fuel_type,slope_deg,aspect_deg,population,population_density,dist_asset_m,hist_fire_flag,municipio,pop_child,pop_adult,pop_elderly) " +
        `VALUES ${values};`,
    );
  }
  return lines.join("\n") + "\n";
}

// --- main -------------------------------------------------------------------
async function main() {
  const boundary = await aragonBoundary();
  const cells = cellsForBoundary(boundary);
  const cellSet = new Set(cells);
  console.error(`Cells (H3 res ${RES}): ${cells.length}`);

  console.error("Fetching elevation...");
  const elev = await elevations(cells);

  console.error("Fetching INE census sections + population...");
  const sections = await fetchSections();
  console.error(`  sections (geometry): ${sections.length}`);
  const popMap = await fetchSectionPopulation();
  const pop7 = populationByCell(sections, popMap);
  const muni7 = municipioByCell(sections);

  console.error("Fetching CORINE land cover (per cell)...");
  const landCover = await fetchLandCover(cells);

  console.error("Fetching EFFIS burnt areas...");
  let burnt = new Set();
  try {
    burnt = await burntAreaCells(bboxOf(boundary));
  } catch (err) {
    console.error(`  EFFIS failed (${err.message}) — hist_fire_flag = 0`);
  }

  let assets = [];
  try {
    console.error("Fetching OSM assets (Overpass)...");
    assets = await osmAssets(bboxOf(boundary));
    console.error(`  assets: ${assets.length}`);
  } catch (err) {
    console.error(`  Overpass failed (${err.message}) — dist_asset_m left NULL`);
  }

  const rows = cells.map((cell) => {
    const t = terrain(cell, elev);
    const p = pop7.get(cell) ?? { total: 0, child: 0, elderly: 0 };
    const population = Math.round(p.total);
    const density = Math.round((population / cellArea(cell, "km2")) * 10) / 10;
    const popChild = Math.round(p.child);
    const popElderly = Math.round(p.elderly);
    const lc = landCover.get(cell);
    return {
      cell,
      ...t,
      landCover: lc?.label ?? null,
      fuelType: fuelFromCode(lc?.code ?? null),
      population,
      density,
      popChild,
      popAdult: population - popChild - popElderly, // residual: bands sum to population
      popElderly,
      distAssetM: nearestAsset(cell, assets),
      histFire: burnt.has(cell) ? 1 : 0,
      municipio: muni7.get(cell) ?? null,
    };
  });

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, toSql(rows));

  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const totalPop = sum((r) => r.population);
  const child = sum((r) => r.popChild);
  const adult = sum((r) => r.popAdult);
  const elderly = sum((r) => r.popElderly);
  console.error(
    `\nDone. ${rows.length} cells -> ${OUT}\n` +
      `  slope populated:      ${rows.filter((r) => r.slopeDeg != null).length}\n` +
      `  land cover populated: ${rows.filter((r) => r.landCover != null).length}\n` +
      `  municipio populated:  ${rows.filter((r) => r.municipio != null).length}\n` +
      `  population in cells:   ${totalPop} (child 0-14: ${child}, adult 15-64: ${adult}, elderly 65+: ${elderly})\n` +
      `  hist-fire cells:      ${rows.filter((r) => r.histFire).length}\n` +
      `  infra (dist) populated: ${rows.filter((r) => r.distAssetM != null).length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
