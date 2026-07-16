import { describe, it, expect } from "vitest";
import { isValidCell, getResolution, cellToLatLng, greatCircleDistance } from "h3-js";
import { cellFor, footprintPolygon } from "./h3.js";
import { H3_RESOLUTION } from "../config.js";

// Zaragoza, in the middle of the MVP region (Aragón).
const LAT = 41.6488;
const LNG = -0.8891;

describe("cellFor", () => {
  it("returns a valid H3 cell at the configured analytical resolution", () => {
    const cell = cellFor(LAT, LNG);
    expect(isValidCell(cell)).toBe(true);
    expect(getResolution(cell)).toBe(H3_RESOLUTION);
  });

  it("is deterministic for the same point", () => {
    expect(cellFor(LAT, LNG)).toBe(cellFor(LAT, LNG));
  });

  it("centres near the input point (< 5 km for res-7)", () => {
    const cell = cellFor(LAT, LNG);
    const [clat, clng] = cellToLatLng(cell);
    expect(greatCircleDistance([LAT, LNG], [clat, clng], "km")).toBeLessThan(5);
  });

  it("honours an explicit resolution override", () => {
    expect(getResolution(cellFor(LAT, LNG, 5))).toBe(5);
  });
});

describe("footprintPolygon", () => {
  const parse = (s: string) => JSON.parse(s) as { type: string; coordinates: number[][][] };

  it("emits a closed GeoJSON Polygon ring", () => {
    const poly = parse(footprintPolygon(LAT, LNG, 375));
    expect(poly.type).toBe("Polygon");
    const ring = poly.coordinates[0];
    expect(ring).toHaveLength(5); // 4 corners + repeated first point
    expect(ring[0]).toEqual(ring[4]); // ring is closed
  });

  it("is centred on the point", () => {
    const ring = parse(footprintPolygon(LAT, LNG, 375)).coordinates[0];
    const meanLng = (ring[0][0] + ring[2][0]) / 2;
    const meanLat = (ring[0][1] + ring[2][1]) / 2;
    expect(meanLng).toBeCloseTo(LNG, 6);
    expect(meanLat).toBeCloseTo(LAT, 6);
  });

  it("scales with the sensor footprint size", () => {
    const small = parse(footprintPolygon(LAT, LNG, 375)).coordinates[0];
    const big = parse(footprintPolygon(LAT, LNG, 1000)).coordinates[0];
    const width = (r: number[][]) => r[1][0] - r[0][0];
    expect(width(big)).toBeGreaterThan(width(small));
  });

  it("widens the longitude span toward the poles for the same footprint", () => {
    // cos(lat) shrinks a degree of longitude, so higher latitude => wider dLng.
    const mid = parse(footprintPolygon(41, LNG, 375)).coordinates[0];
    const high = parse(footprintPolygon(65, LNG, 375)).coordinates[0];
    const span = (r: number[][]) => Math.abs(r[1][0] - r[0][0]);
    expect(span(high)).toBeGreaterThan(span(mid));
  });
});
