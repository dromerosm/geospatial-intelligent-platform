import { describe, it, expect } from "vitest";
import {
  scoreDetection,
  DEFAULT_WEIGHTS,
  DEFAULT_THRESHOLD,
  type ScoreContext,
} from "./score.js";

// A neutral baseline: unknown everything. The scorer must still produce a
// well-formed result in [0,1] rather than throwing on nulls.
const neutral: ScoreContext = {
  detectionConfidence: null,
  persistenceCount: 1,
  lightningActive: false,
  fwi: null,
  triple30: null,
  fuelType: null,
  slopeDeg: null,
  populationDensity: null,
  popElderly: null,
  distAssetM: null,
};

describe("scoreDetection — output shape & bounds", () => {
  it("keeps score and confidence within [0,1]", () => {
    const r = scoreDetection(neutral);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("echoes an auditable breakdown with all five contributions", () => {
    const r = scoreDetection(neutral);
    expect(Object.keys(r.breakdown.contributions).sort()).toEqual(
      ["exposure", "fire_weather", "fuel_terrain", "persistence", "source_confidence"],
    );
    expect(r.breakdown.weights).toEqual(DEFAULT_WEIGHTS);
  });

  it("defaults DEFAULT_WEIGHTS sum to 1 so the score cannot exceed 1", () => {
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe("scoreDetection — contribution normalisation", () => {
  it("saturates persistence at 3+ detections", () => {
    const three = scoreDetection({ ...neutral, persistenceCount: 3 });
    const six = scoreDetection({ ...neutral, persistenceCount: 6 });
    expect(three.breakdown.contributions.persistence).toBe(1);
    expect(six.breakdown.contributions.persistence).toBe(1);
  });

  it("treats unknown source confidence as neutral 0.5", () => {
    const r = scoreDetection({ ...neutral, detectionConfidence: null });
    expect(r.breakdown.contributions.source_confidence).toBe(0.5);
  });

  it("maps fuel classes onto increasing fire_weather-independent scores", () => {
    // Hold everything else fixed; higher fuel class must not lower fuel_terrain.
    const ctx = (fuelType: string): ScoreContext => ({ ...neutral, fuelType, slopeDeg: 0 });
    const low = scoreDetection(ctx("low")).breakdown.contributions.fuel_terrain;
    const high = scoreDetection(ctx("high")).breakdown.contributions.fuel_terrain;
    const veryHigh = scoreDetection(ctx("very_high")).breakdown.contributions.fuel_terrain;
    expect(high).toBeGreaterThan(low);
    expect(veryHigh).toBeGreaterThan(high);
  });

  it("Triple-30 lifts the fire-weather floor to 0.7 when FWI is unknown", () => {
    const r = scoreDetection({ ...neutral, fwi: null, triple30: 1 });
    expect(r.breakdown.contributions.fire_weather).toBeGreaterThanOrEqual(0.7);
  });

  it("an official AEMET warning raises the fire-weather floor to its level", () => {
    const low = scoreDetection({ ...neutral, fwi: 5 }); // fwi/50 = 0.1
    const warned = scoreDetection({ ...neutral, fwi: 5, officialFireWeatherLevel: 0.8 });
    expect(low.breakdown.contributions.fire_weather).toBeLessThan(0.8);
    expect(warned.breakdown.contributions.fire_weather).toBeCloseTo(0.8, 5);
  });
});

describe("scoreDetection — confidence & corroboration gate", () => {
  it("stronger evidence produces higher confidence", () => {
    const weak = scoreDetection({ ...neutral, persistenceCount: 1, detectionConfidence: 0.2 });
    const strong = scoreDetection({ ...neutral, persistenceCount: 3, detectionConfidence: 0.95 });
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
  });

  it("an active lightning watch raises confidence (corroboration)", () => {
    const off = scoreDetection({ ...neutral, persistenceCount: 3, detectionConfidence: 0.9 });
    const on = scoreDetection({ ...neutral, persistenceCount: 3, detectionConfidence: 0.9, lightningActive: true });
    expect(on.confidence).toBeGreaterThan(off.confidence);
  });

  it("an official wildfire alert corroborates just like lightning", () => {
    const on = scoreDetection({
      ...neutral, persistenceCount: 3, detectionConfidence: 0.9, officialWildfireAlert: true,
    });
    expect(on.confidence).toBeGreaterThan(scoreDetection({
      ...neutral, persistenceCount: 3, detectionConfidence: 0.9,
    }).confidence);
    expect(on.breakdown.officialWildfireAlert).toBe(true);
  });

  it("a strong corroborated detection crosses the event-creation threshold", () => {
    const r = scoreDetection({
      ...neutral, persistenceCount: 3, detectionConfidence: 0.95, lightningActive: true,
    });
    expect(r.confidence).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
  });

  it("custom weights still keep the score in [0,1]", () => {
    const r = scoreDetection(
      { ...neutral, persistenceCount: 3, detectionConfidence: 1, fwi: 50 },
      { persistence: 0.5, source_confidence: 0.2, fire_weather: 0.2, fuel_terrain: 0.05, exposure: 0.05 },
    );
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});
