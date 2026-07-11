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

## 7. Digital Twin build (Phase 2)

The Digital Twin is a **build-time batch job** (`scripts/build-digital-twin.mjs`), not a
runtime path. It enumerates the H3 res-7 cells covering Aragón and enriches each, then
emits idempotent `INSERT OR REPLACE` SQL applied to D1. No new dependencies — `h3-js`
plus native `fetch`; distance/bearing are inline haversine.

| Field | Source | Status |
|-------|--------|--------|
| cell set | Nominatim boundary of Aragón → `h3.polygonToCells` (res 7, ~9.4k cells) | real |
| `slope_deg`, `aspect_deg` | Open-Elevation → steepest-descent over the H3 neighbourhood | real |
| `population`, `population_density` | **INE Censo Anual 2025** by census section (ref 1-Jan-2025), areally interpolated to H3 | real, authoritative |
| `dist_asset_m` | nearest OSM asset (fire station, substation, settlement) via Overpass | real, best-effort |
| `land_cover`, `fuel_type`, `hist_fire_flag` | — | **NULL in v1** (Phase 2.1: CORINE/EFFIS raster sampling) |

### Population: INE Censo Anual 2025 (authoritative)

Population comes from the **original INE source**, not the Eurostat republication (which is
the fixed 2021 census). Two INE endpoints, joined by the 10-digit `CUSEC` section code:

- **Geometry** — INE OGC API Features (`Secciones_2025` collection, filter
  `CCA='02' AND TIPO='SECCIONADO'`) → 1,463 Aragón census sections as GeoJSON. No shapefile parsing.
- **Population** — INE Censo Anual jaxiT3 CSV tables, one per Aragón province (Huesca 69193,
  Zaragoza 69289, Teruel 69345), filtered to `Total / Todas las edades / 2025`. Total ≈ 1.36 M
  (matches the official Aragón figure).

**Areal interpolation to H3**: each section polygon is discretised into equal-area H3 res-9
subcells (~0.1 km²); its population is split evenly across them and re-aggregated to the res-7
parent cells. This handles both large rural sections (spread across many cells) and dense urban
sections (many sections per cell). `population_density` = population / cell area (people/km²).
Sections with <50 residents are suppressed by INE (statistical secrecy) and count as 0.

Design choices:

- **Res 7 is mandatory**, not a tuning knob: observations are indexed at res 7
  (`src/config.ts`), so the twin must match for the cell-key join to work.
- **Terrain + population are authoritative; OSM (dist_asset_m) is best-effort** — if
  Overpass fails, cells still get terrain and population; only `dist_asset_m` stays NULL.
  Phase 3 scoring must treat NULLs as neutral.
- **Elevation via Open-Elevation** (bulk POST, no hourly cap), checkpointed to
  `tmp/elevations.json` so re-runs are near-free. (Open-Meteo's elevation API was dropped:
  its free tier hourly limit can't cover ~9.4k points in one run.)
- Slope is a **cell-scale** value (gradient over the ~1.4 km res-7 neighbourhood), not
  slope at a point — consistent with the platform's precision-honesty principle.

## Open items

- **Phase 2.1**: populate `land_cover` / `fuel_type` (CORINE Land Cover or ESA WorldCover
  raster sampling) and `hist_fire_flag` (EFFIS historical burnt areas). Aragón is within
  the EFFIS domain.
- Fuel-moisture proxy is a placeholder (relative humidity); replace with an EFFIS/FWI
  component.
- Weather is grid-sampled (9 points); per-cell interpolation is a later refinement.
