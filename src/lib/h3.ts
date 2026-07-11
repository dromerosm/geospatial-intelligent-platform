// H3 helpers. Spatial joins in this platform are by cell key (D1 has no
// spatial SQL); geometry is derived here in the Worker.
import { latLngToCell } from "h3-js";
import { H3_RESOLUTION } from "../config.js";

/** Resolve a point to its analytical H3 cell. */
export function cellFor(lat: number, lng: number, res = H3_RESOLUTION): string {
  return latLngToCell(lat, lng, res);
}

/**
 * Approximate square observation footprint centred on a point, sized to the
 * sensor's nominal resolution. Returned as a GeoJSON Polygon string.
 * Approximate by design — never implies more precision than `sideM` allows.
 */
export function footprintPolygon(lat: number, lng: number, sideM: number): string {
  const half = sideM / 2;
  const dLat = half / 111_320;
  const dLng = half / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring = [
    [lng - dLng, lat - dLat],
    [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat],
    [lng - dLng, lat + dLat],
    [lng - dLng, lat - dLat],
  ];
  return JSON.stringify({ type: "Polygon", coordinates: [ring] });
}
