// Deterministic scoring — pure, explainable, unit-testable. No I/O.
//
// Two outputs:
//   - confidence: how sure this is a real active fire (gates event creation).
//   - score:      overall operational priority (ranks events once created).
// Both are weighted sums of NAMED contributions, each normalised to [0,1] and
// echoed in `breakdown` so every decision is auditable. Weights are tunable
// (Phase-3 increment 3 loads them from KV); defaults live here.

export interface ScoreContext {
  detectionConfidence: number | null; // source-reported [0,1] (max in cluster)
  persistenceCount: number; // # detections in the cluster/time-window
  lightningActive: boolean; // active lightning watch on the cell
  fwi: number | null; // Fire Weather Index (nearest weather point)
  triple30: 0 | 1 | null;
  fuelType: string | null; // none|low|medium|high|very_high
  slopeDeg: number | null;
  populationDensity: number | null; // people/km²
  popElderly: number | null; // residents 65+ in the cell
  distAssetM: number | null; // metres to nearest critical asset
}

export interface Weights {
  persistence: number;
  source_confidence: number;
  fire_weather: number;
  fuel_terrain: number;
  exposure: number;
}

// Sum to 1 so the score stays in [0,1]. Deliberately simple; tune in KV.
export const DEFAULT_WEIGHTS: Weights = {
  persistence: 0.25,
  source_confidence: 0.2,
  fire_weather: 0.25,
  fuel_terrain: 0.15,
  exposure: 0.15,
};

/** Event is created when confidence ≥ threshold. */
export const DEFAULT_THRESHOLD = 0.5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const FUEL_SCORE: Record<string, number> = { none: 0, low: 0.25, medium: 0.5, high: 0.75, very_high: 1 };

/** Each contribution normalised to [0,1] from the raw context. */
function contributions(c: ScoreContext) {
  const persistence = clamp01(c.persistenceCount / 3); // 3+ passes -> full
  const source_confidence = c.detectionConfidence ?? 0.5; // unknown -> neutral

  // Fire weather: FWI (50 ≈ extreme) is primary; Triple-30 lifts the floor.
  let fire_weather =
    c.fwi != null ? clamp01(c.fwi / 50) : c.triple30 ? 0.7 : 0.3;
  if (c.triple30) fire_weather = Math.max(fire_weather, 0.7);

  // Fuel × terrain: fuel dominates, slope (spread) modulates.
  const fuel = c.fuelType != null ? (FUEL_SCORE[c.fuelType] ?? 0.4) : 0.4;
  const slopeNorm = clamp01((c.slopeDeg ?? 0) / 30);
  const fuel_terrain = fuel * (0.6 + 0.4 * slopeNorm);

  // Exposure: population density + vulnerable residents + proximity to assets.
  const densityNorm = clamp01((c.populationDensity ?? 0) / 500);
  const elderlyNorm = clamp01((c.popElderly ?? 0) / 100);
  const assetNorm = c.distAssetM != null ? clamp01(1 - c.distAssetM / 10000) : 0.3;
  const exposure = clamp01(0.5 * densityNorm + 0.2 * elderlyNorm + 0.3 * assetNorm);

  return { persistence, source_confidence, fire_weather, fuel_terrain, exposure };
}

export interface ScoreResult {
  score: number;
  confidence: number;
  breakdown: {
    weights: Weights;
    contributions: Record<string, number>;
    weighted: Record<string, number>;
    lightningActive: boolean;
  };
}

export function scoreDetection(c: ScoreContext, weights: Weights = DEFAULT_WEIGHTS): ScoreResult {
  const contrib = contributions(c);
  const weighted: Record<string, number> = {};
  let score = 0;
  for (const k of Object.keys(weights) as (keyof Weights)[]) {
    weighted[k] = Math.round(contrib[k] * weights[k] * 1000) / 1000;
    score += contrib[k] * weights[k];
  }

  // Confidence that this is a real active fire: evidence strength + ignition
  // evidence (a lightning watch on the cell raises it).
  const confidence = clamp01(
    0.4 * contrib.persistence + 0.4 * contrib.source_confidence + 0.2 * (c.lightningActive ? 1 : 0.3),
  );

  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    score: round(score),
    confidence: round(confidence),
    breakdown: {
      weights,
      contributions: Object.fromEntries(Object.entries(contrib).map(([k, v]) => [k, round(v)])),
      weighted,
      lightningActive: c.lightningActive,
    },
  };
}
