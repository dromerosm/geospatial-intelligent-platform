// Prototype build step — turn the Digital Twin SQL into a GeoJSON layer.
//
// Reads the INSERT rows from ../tmp/digital-twin.sql, converts each H3 res-7
// cell to its boundary polygon (h3-js), and writes a GeoJSON FeatureCollection
// carrying, per cell: population + population_density, the cell-centre lat/lng,
// and the predominant municipality (authoritative, from INE census sections).
// The static map (index.html) loads only this file — no D1 / Worker needed.
//
// Municipality is derived, not reverse-geocoded: each INE 2025 census section
// carries NMUN/NPRO + geometry; we rasterise every section to H3 res-9 subcells
// (municipio map), then label each res-7 cell by majority vote of its subcells.
// The sections GeoJSON is cached under tmp/ so re-runs are fully offline.
//
// Usage: node prototype/build-geojson.mjs

import { cellToBoundary, cellToChildren, cellToLatLng, polygonToCells } from "h3-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_IN = join(HERE, "..", "tmp", "digital-twin.sql");
const SECTIONS_CACHE = join(HERE, "..", "tmp", "ine_sections_aragon.geojson");
const OUT = join(HERE, "data", "aragon-density.geojson");

const RES = 7; // matches the H3 resolution of the Digital Twin cells
const INTERP_RES = 9; // subcell resolution for the municipio raster
const UA = "geospatial-platform/0.1 (https://github.com/dromerosm/geospatial-intelligent-platform)";

// INE OGC API Features — census-section geometry + attributes (2025 vintage).
const INE_OGC =
  "https://www.ine.es/geoserver/ogc/features/v1/collections/" +
  "WMS_INE_SECCIONES_G01:Secciones_2025/items";

// Match each VALUES tuple:
//   ('<h3>',<land>,<fuel>,<slope>,<aspect>,<population>,<density>,<dist>,<hist>)
// land_cover / fuel_type are NULL in v1; the numeric columns may be NULL too.
const ROW = /\('([0-9a-f]+)',[^,]*,[^,]*,([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*)\)/g;

const num = (s) => (s == null || s.trim() === "" || s.trim() === "NULL" ? null : Number(s));

// --- INE census sections (geometry + NMUN/NPRO) -----------------------------
async function loadSections() {
  if (existsSync(SECTIONS_CACHE)) {
    console.error(`  sections: cached (${SECTIONS_CACHE})`);
    return JSON.parse(readFileSync(SECTIONS_CACHE, "utf8")).features;
  }
  const filter = encodeURIComponent("CCA='02' AND TIPO='SECCIONADO'"); // 02 = Aragón
  const url = `${INE_OGC}?f=application/json&limit=3000&filter-lang=cql2-text&filter=${filter}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`INE OGC ${res.status}`);
  const fc = await res.json();
  writeFileSync(SECTIONS_CACHE, JSON.stringify(fc));
  console.error(`  sections: fetched ${fc.features.length} (cached to ${SECTIONS_CACHE})`);
  return fc.features;
}

// Rasterise every section onto H3 res-9, keyed to its municipality label.
// A later section overwriting an earlier one on a shared subcell is negligible
// (sections tile the territory; overlaps are boundary-thin).
function municipioBySubcell(sections) {
  const sub = new Map(); // res-9 cell -> "Municipio (Provincia)"
  for (const f of sections) {
    const p = f.properties;
    const label = p.NPRO && p.NPRO !== p.NMUN ? `${p.NMUN} (${p.NPRO})` : p.NMUN;
    if (!label || !f.geometry) continue;
    const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const poly of polys) for (const c of polygonToCells(poly, INTERP_RES, true)) sub.set(c, label);
  }
  return sub;
}

// Majority-vote the municipality of a res-7 cell from its res-9 children.
function municipioForCell(cell, sub) {
  const tally = new Map();
  for (const child of cellToChildren(cell, INTERP_RES)) {
    const label = sub.get(child);
    if (label) tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [label, n] of tally) if (n > bestN) { bestN = n; best = label; }
  return best;
}

// --- main -------------------------------------------------------------------
async function main() {
  const sql = readFileSync(SQL_IN, "utf8");

  console.error("Loading INE census sections for municipality labels...");
  const sections = await loadSections();
  const sub = municipioBySubcell(sections);
  console.error(`  res-9 municipio raster: ${sub.size.toLocaleString("es-ES")} subcells`);

  const features = [];
  let densMin = Infinity;
  let densMax = -Infinity;
  let popTotal = 0;
  let labelled = 0;

  for (const m of sql.matchAll(ROW)) {
    const [, cell, , , population, density] = m;
    const pop = num(population);
    const dens = num(density);
    const [lat, lng] = cellToLatLng(cell);
    const municipio = municipioForCell(cell, sub);
    if (municipio) labelled++;
    // [lng,lat] rings, closed loop — h3-js GeoJSON mode.
    const boundary = cellToBoundary(cell, true);
    features.push({
      type: "Feature",
      properties: {
        h3: cell,
        population: pop ?? 0,
        density: dens ?? 0,
        lat: Math.round(lat * 1e5) / 1e5,
        lng: Math.round(lng * 1e5) / 1e5,
        municipio: municipio ?? null,
      },
      geometry: { type: "Polygon", coordinates: [boundary] },
    });
    if (dens != null) {
      densMin = Math.min(densMin, dens);
      densMax = Math.max(densMax, dens);
    }
    popTotal += pop ?? 0;
  }

  if (features.length === 0) {
    throw new Error(`No cells parsed from ${SQL_IN} — is the Digital Twin built?`);
  }

  const fc = {
    type: "FeatureCollection",
    metadata: {
      source: "INE Censo Anual 2025 (population + municipality) interpolated to H3 res-7",
      cells: features.length,
      populationTotal: popTotal,
      densityMin: densMin,
      densityMax: densMax,
      generatedFrom: "tmp/digital-twin.sql",
    },
    features,
  };

  writeFileSync(OUT, JSON.stringify(fc));
  console.error(
    `Wrote ${OUT}\n` +
      `  cells: ${features.length}\n` +
      `  with municipality: ${labelled} (${Math.round((labelled / features.length) * 100)}%)\n` +
      `  population (sum of cells): ${popTotal.toLocaleString("es-ES")}\n` +
      `  density people/km²: min ${densMin}, max ${densMax}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
