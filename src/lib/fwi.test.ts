import { describe, it, expect } from "vitest";
import { computeFwi, FWI_START, type FwiInput } from "./fwi.js";

// Standard startup codes (spring), as prescribed by the FWI System.
const startup = { ffmc0: FWI_START.ffmc, dmc0: FWI_START.dmc, dc0: FWI_START.dc };

describe("computeFwi — van Wagner & Pickett (1987) reference day", () => {
  // The worked example from the reference implementation: a single April day
  // advanced from the standard startup codes. Values are asserted against the
  // published FWI System outputs (tolerance absorbs 1-decimal rounding).
  const out = computeFwi({
    temp: 17, rh: 42, wind: 25, rain: 0, month: 4, ...startup,
  });

  it("reproduces the reference moisture codes", () => {
    expect(out.ffmc).toBeCloseTo(87.7, 0);
    expect(out.dmc).toBeCloseTo(8.5, 0);
    expect(out.dc).toBeCloseTo(19.0, 0);
  });

  it("reproduces the reference fire-behaviour indices", () => {
    expect(out.isi).toBeCloseTo(10.9, 0);
    expect(out.bui).toBeCloseTo(8.5, 0);
    expect(out.fwi).toBeCloseTo(10.1, 0);
  });
});

describe("computeFwi — physical invariants", () => {
  const base: FwiInput = { temp: 20, rh: 40, wind: 15, rain: 0, month: 7, ...startup };

  it("returns finite, non-negative indices", () => {
    const o = computeFwi(base);
    for (const v of Object.values(o)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("clamps FFMC to its physical ceiling of 101", () => {
    // Extremely hot, bone-dry, windy day cannot push FFMC past the scale max.
    const o = computeFwi({ ...base, temp: 40, rh: 5, wind: 40 });
    expect(o.ffmc).toBeLessThanOrEqual(101);
  });

  it("drier air (lower RH) yields a higher FFMC than humid air", () => {
    const dry = computeFwi({ ...base, rh: 15 });
    const humid = computeFwi({ ...base, rh: 90 });
    expect(dry.ffmc).toBeGreaterThan(humid.ffmc);
  });

  it("rain lowers the FFMC relative to an identical dry day", () => {
    const dryDay = computeFwi(base);
    const wetDay = computeFwi({ ...base, rain: 10 });
    expect(wetDay.ffmc).toBeLessThan(dryDay.ffmc);
  });

  it("stronger wind raises the ISI (rate of spread)", () => {
    const calm = computeFwi({ ...base, wind: 5 });
    const gale = computeFwi({ ...base, wind: 45 });
    expect(gale.isi).toBeGreaterThan(calm.isi);
  });

  it("tolerates out-of-range humidity by clamping to [0,100]", () => {
    const o = computeFwi({ ...base, rh: 250 });
    expect(Number.isFinite(o.ffmc)).toBe(true);
  });
});
