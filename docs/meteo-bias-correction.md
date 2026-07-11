# Meteo bias correction (AEMET → gridded background)

Design decision and roadmap for correcting the gridded weather field with AEMET
station observations. Written before implementation so the approach is fixed and
reviewable. Scope: how to make the ~15 km Aragón weather grid more accurate
without over-engineering it for a Cloudflare Workers stack.

## Core principle

**Do not spatially interpolate weather from the sparse AEMET stations.** With an
uneven network (Pyrenees, Iberian System, Ebro valley) nearest-neighbour / IDW /
kriging *of the raw variable* is fragile. Instead, keep a **complete gridded
background** and use stations to correct only its **local residual**:

```
final(x,t) = background(x,t) + R̂(x,t)
R_i(t)     = obs_AEMET,i(t) − background(x_i,t)      # residual at station i
```

`R̂` is the residual field interpolated from the per-station residuals `R_i`.
The background already carries the broad atmospheric + topographic structure;
stations only nudge local bias. This is far more robust than interpolating the
sparse stations directly.

## Which background — and why not ERA5-Land as the live field

The project already has a complete gridded background; the correction attaches to
it. It is **not** ERA5-Land:

| Path | Background | Source in code |
|---|---|---|
| **Live** (current + 3-day forecast) | Open-Meteo | `src/ingest/weather.ts` → `fire_weather` |
| **Historical** (FWI drought-code spin-up) | Open-Meteo archive | `src/index.ts` `runFwiSpinup` (`archive-api.open-meteo.com`) |

ERA5-Land (`reanalysis-era5-land`, 0.1° ≈ 9 km) is a **reanalysis, not a
real-time feed**: it lags real time by ~5–6 days (observed 2026-07-05 available on
2026-07-11). For a wildfire product that is about *now* and the *forecast*, it
cannot be the live background. Open-Meteo already fills the live and historical
roles, and its archive is itself ERA5/ERA5-Land reprocessed — so pulling raw
ERA5-Land via the CDS adds async-job friction and worse latency for no gain on the
live path.

**ERA5-Land's role here is optional/historical only** — an alternative reanalysis
for the FWI spin-up or offline validation. A sample slice lives at
`data/era5/era5land_t2m_aragon_2026-07-05.nc` (retrieved via the CDS API; see
credentials `cds_url`/`cds_key` in `.dev.vars`).

> Decision (2026-07-11): the residual-correction machinery is built **background-
> agnostic** so it serves both live and historical, but **the live Open-Meteo grid
> is the first target**.

## Blocker: AEMET observations are not ingested yet

Today AEMET is used only for lightning (`src/ingest/lightning-aemet.ts`, image
scraping). There is **no ingestion of station observations** (T / dewpoint / RH /
wind / precip). No observations ⇒ no residuals. The first implementation step is
therefore ingestion, not choosing an interpolation method.

### Ingestion path (verified live 2026-07-11)

**Bulk = one national call + client-side clip to Aragón.** AEMET OpenData has **no
server-side region filter** for conventional observations; the bulk endpoint is
national. Standard two-fetch pattern, authenticated with `AEMET_API_KEY`:

```
GET /observacion/convencional/todas/?api_key=…   → { datos: <url>, metadatos: … }
GET <datos url>                                  → JSON array of observations
```

Observed response (2026-07-11 sample):

- **9 522 records · ~3.2 MB**, **836 stations** nationwide, last ~12 h, **hourly**
  (12 timestamps per station).
- **~109 stations fall in the Aragón bbox** (107 with temperature) — but the bbox
  **over-captures** border stations (e.g. Vandellós, in Tarragona). Clip to the
  **Aragón admin boundary** (as `aragon-density.geojson` does), not the rectangle;
  true count is somewhat lower.
- Per-record fields: `idema, ubi, lat, lon, alt, fint, ta, tamax, tamin, hr, tpr
  (dewpoint), vv, dv, vmax, dmax, prec, pres, pres_nmar`. **Dewpoint (`tpr`) is
  provided**, so the T + Td → RH plan needs no estimation.

Gotchas:

- **Encoding is latin-1**, not UTF-8 — decode accordingly when parsing.
- **Per-minute rate limit** (a 429 "caudal por minuto excedido" is easy to hit).
  One national call per cron cycle + backoff. The per-station endpoint
  (`/observacion/convencional/datos/estacion/{idema}`) would be ~109 calls —
  worse under the limit; prefer bulk + filter.
- Both fetches fit in a Worker (fetch national, clip to Aragón, store in D1).

Then, per station store `station_id, timestamp, lat, lon, elevation, variable,
value`, apply quality control (range checks, stuck-sensor, gross-error vs
background) and align to the grid's timestamps.

## Tier 1 — the MVP that fits this stack

Cloudflare Workers runtime is **lookup-only**; anything geostatistical must be
**offline precompute** (a `scripts/build-*.mjs` → static JSON served by the
Worker, exactly like `build-weather-grid.mjs` and `aragon-density.geojson`).

Tier 1, per variable-appropriate rules below:

```
final = OpenMeteo + IDW( AEMET − OpenMeteo@station , Δz-adjusted ) + uncertainty
```

- **Grid**: keep the existing lat/lon 0.1° grid. Do **not** reproject to UTM
  (EPSG:25830) yet — it adds a proj dependency for no MVP benefit.
- **Elevation term (Δz)**: correct the residual for the difference between station
  elevation and the background cell's elevation. In Aragón this is significant;
  ignoring it poisons the residual in mountains. (DEM/elevation already available
  via Open-Elevation, see architecture.md.)
- **Spread**: inverse-distance weighting of Δz-adjusted residuals, with a distance
  cap. Simple, interpretable, robust for a sparse net.

### Variable-specific rules (cheap, physically correct — adopt regardless of tier)

- **Temperature / dewpoint**: correct these two; **derive RH afterwards** rather
  than interpolating RH directly (preserves physical consistency).
- **Wind**: interpolate **U/V components**, not speed/direction; reconstruct
  `speed = √(u²+v²)`, `dir = atan2(−u,−v)`.
- **Precipitation is special** — intermittent, zero-inflated, skewed. Do **not**
  IDW/krige it naively. Defer to Tier 2 (two-stage: P(rain>0) then a
  `log(1+p)`-space residual), or leave precip uncorrected in Tier 1.
- **Pressure**: correct at a common altitude (reduce to MSLP), not raw station
  pressure.

### Uncertainty layer (cheap, high value)

Every corrected cell carries confidence context:

```json
{
  "temperature": 31.4,
  "temperature_uncertainty": 1.2,
  "station_count_within_50km": 3,
  "nearest_station_km": 18.7,
  "method": "openmeteo_residual_idw_v1"
}
```

Cells far from stations or separated by strong topography get larger uncertainty.

## Validation (do this offline, it is cheap and catches self-deception)

Random train/test splits over-report quality (nearby stations are correlated).
Use:

- **Leave-one-station-out (LOSO)** — predict a held-out station from the rest;
  tells you whether it generalises to unstationed locations.
- **Spatial-block CV** — hold out whole regions (Pyrenees / Ebro / Iberian System
  / west / east Aragón).
- **Temporal holdout** — hold out heatwaves, convective storms, strong-wind events.
  A method good on average can be worst *exactly* during wildfire-risk conditions.

Report bias, MAE, RMSE, correlation, 90/95th-pct error, and extreme-event error.

## Deferred (Tier 2/3) — do not build for the MVP

Regression/universal kriging, GAM + residual kriging, gradient boosting
(LightGBM/CatBoost/XGBoost) on residuals, radar-composite precip background,
DEM slope/aspect/exposure covariates, anisotropic variograms, UTM reprojection.
All are **offline-precompute** if adopted, and any ML must predict the **residual
against the physical background**, never replace the background. Revisit only when
Tier 1 is live and its validation shows a specific, quantified shortfall.

## Attribution

If ERA5-Land data is used in any output:
"Generated using Copernicus Climate Change Service information [2026]"
(licences `licence-to-use-copernicus-products` + `cc-by`, accepted on the CDS
account). Open-Meteo has its own attribution terms.
