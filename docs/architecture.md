# Architecture notes

Companion to the [master document](../specs/Geospatial_Intelligence_Platform_Master_Document.md).
This file records **implementation decisions** — why the code looks the way it does.

## 1. Everything on Cloudflare

A single Worker hosts both the scheduled ingestion (`scheduled()`) and the read API
(`fetch()`). Storage is D1 (relational), R2 (raw payloads), KV (config). This keeps the
MVP to one deployable unit with scale-to-zero cost.

## 2. No PostGIS — H3 is the spatial key

D1 is SQLite with no spatial extension. Instead of geometry SQL:

- On ingest, every detection is resolved to an **H3 cell** (`res 7`, ~5 km²) and stored
  in `observation.h3_cell`. The Digital Twin and fire weather use the same key.
- Joining detection ↔ context ↔ weather is therefore an **indexed equality lookup**, not
  a spatial query.
- Polygon/distance math (footprints, buffers) runs **in the Worker** with `h3-js`
  (add `@turf/turf` when Phase 3 needs distance-to-asset), on demand around active events.
- Source rasters/vectors stay in native format in R2; only per-cell summaries reach D1.

## 3. Direct writes now, Queue later

Phase 1 ingestion writes straight to D1/R2. The Queue in the blueprint is deferred to
**Phase 3**, when the consumer does deterministic scoring + an LLM call and decoupling
(retries, backpressure, DLQ) earns its keep. Adding it now would be complexity without
payoff.

## 4. Precision honesty

Per the spec's *Spatial Resolution & Uncertainty Principle*, each `observation` stores
`nominal_resolution_m`, `geolocation_uncertainty_m`, `confidence` and an approximate
`footprint_geojson`. The footprint is a square sized to the sensor pixel (375 m for
VIIRS) — deliberately not a point. Downstream outputs must never imply finer precision.

## 5. Configuration lives in `src/config.ts`

Region bbox, H3 resolution and feed constants are centralised. Re-pointing the platform
at another region is a one-file edit (plus rebuilding the Digital Twin).

## 6. Ingestion feeds (Phase 1)

| Feed | Source | Cadence | Auth | Notes |
|------|--------|---------|------|-------|
| Hotspots | NASA FIRMS VIIRS_SNPP_NRT (Area CSV API) | 15 min | free map key | 375 m nominal resolution |
| Fire weather | Open-Meteo current | hourly | none | grid-sampled, Triple-30 flagged |

## Open items

- Fuel-moisture proxy is a placeholder (relative humidity); replace with an EFFIS/FWI
  component. Aragón is within the EFFIS domain.
- H3 resolution 7 vs 8 to be validated against storage/granularity for Aragón.
- Weather is grid-sampled (9 points); per-cell interpolation is a later refinement.
