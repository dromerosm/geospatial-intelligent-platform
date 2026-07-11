// Build the fire-weather sample grid: a surface-uniform (km-corrected) set of
// points clipped to the real Aragón boundary, so every sample falls inside the
// region. Written to src/weather-points.json, imported by the Worker.
//
// Regenerate only when the region or spacing changes:  node scripts/build-weather-grid.mjs
//
// Spacing is chosen so the whole grid fits Open-Meteo's free tier at a 3 h cadence
// (background layer); event-time precision is fetched on demand in Phase 3.

import { writeFileSync } from "node:fs";

const SPACING_KM = 10;
const OUT = "src/weather-points.json";
const UA = "geospatial-platform/0.1 (https://github.com/dromerosm/geospatial-intelligent-platform)";
const KM_PER_DEG = 111.32;

async function aragonBoundary() {
  const url =
    "https://nominatim.openstreetmap.org/search?q=Arag%C3%B3n&countrycodes=es" +
    "&format=json&polygon_geojson=1&limit=1";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  if (!data[0]?.geojson) throw new Error("No boundary geometry");
  return data[0].geojson;
}

// Ray-casting point-in-ring / polygon (with holes) / multipolygon. [lng,lat].
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(x, y, poly) {
  if (!inRing(x, y, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(x, y, poly[k])) return false; // hole
  return true;
}
function inside(x, y, geo) {
  const polys = geo.type === "MultiPolygon" ? geo.coordinates : [geo.coordinates];
  return polys.some((p) => inPolygon(x, y, p));
}

function bboxOf(geo) {
  let s = 90, w = 180, n = -90, e = -180;
  const polys = geo.type === "MultiPolygon" ? geo.coordinates : [geo.coordinates];
  for (const poly of polys)
    for (const [lng, lat] of poly[0]) {
      s = Math.min(s, lat); n = Math.max(n, lat);
      w = Math.min(w, lng); e = Math.max(e, lng);
    }
  return { s, w, n, e };
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;

async function main() {
  const boundary = await aragonBoundary();
  const { s, w, n, e } = bboxOf(boundary);
  const dLat = SPACING_KM / KM_PER_DEG;
  const pts = [];
  for (let lat = s + dLat / 2; lat <= n; lat += dLat) {
    const dLon = SPACING_KM / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180));
    for (let lng = w + dLon / 2; lng <= e; lng += dLon) {
      if (inside(lng, lat, boundary)) pts.push({ lat: round5(lat), lng: round5(lng) });
    }
  }
  writeFileSync(OUT, JSON.stringify(pts));
  console.error(`Spacing ~${SPACING_KM} km -> ${pts.length} points inside Aragón -> ${OUT}`);
  console.error(`Open-Meteo weight @3h: ${pts.length * 8}/day, ${pts.length * 8 * 30}/month (free: 10k/day, 300k/month)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
