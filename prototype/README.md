# Aragón Digital Twin map

The map uses **MapLibre GL JS 5.24.0** and an **OpenFreeMap dark vector basemap**.
It displays 9,408 H3 cells from the territorial snapshot and reads live weather,
hotspots and events from the platform API. OpenFreeMap needs no API key.

## Run locally

```bash
npm run map:dev
# Open http://127.0.0.1:8000/mapa/
```

The preview server binds to loopback. It serves this directory and proxies only
GET `/fire-weather`, `/observations` and `/events` to the public production API.
Responses are cached for 30 seconds to avoid repeated rate-limit hits during QA.
It does not run cron jobs, access credentials or expose manual ingestion routes.
An internet connection is required for live data, MapLibre, h3-js and map tiles.

A plain static server also works for the territorial snapshot, but live API
layers need the proxy or the production `/mapa/` route. The Pages hostname alone
does not supply the Worker API.

## Features

| Control | Behaviour |
| --- | --- |
| Densidad | Population density, using the existing YlOrRd scale. |
| % mayores 65+ | Share of residents aged 65+, with uninhabited cells grey. |
| Combustible | CORINE-derived fuel classes. |
| Temperatura | Air temperature from the nearest weather sample. |
| Peligro (FWI) | Canadian FWI, coloured with the existing EFFIS classes. |
| Oscuro | OpenFreeMap dark style with place labels. |
| Satélite / Falso color | NASA GIBS reflectance imagery, with a shared date and sensor. |
| Geo Colour | Latest available EUMETSAT MTG frame via WMS. |
| Focos VIIRS SNPP / N20 / MODIS | Independent NASA GIBS thermal-anomaly overlays. |
| Eventos + IA | Active events, priority markers and expandable briefing popups. |
| EFFIS histórico | Burnt cells from the static territorial snapshot. |
| FIRMS focos | Recent detection footprints from `/observations`. |
| Meteo (viento) | Wind arrows and Triple-30 rings; also selects temperature. |

Hover over or tap a cell to inspect its population, age bands, land cover, fuel,
slope, distance to assets, fire history and H3 identifier. Event markers support
keyboard activation. The mobile layer panel collapses behind **Capas**.

`/mapa/?event=<h3>` enables the events layer, centres on the event and opens its
briefing. An expired or unknown identifier shows a message instead.

## Rendering and dependencies

`map.js` owns one MapLibre map. The base style loads once; switching backgrounds
changes layer visibility without replacing the style. The H3 cells, GIBS overlays,
EFFIS and FIRMS use native raster or GeoJSON layers. Events and wind use MapLibre
DOM markers. There is no Leaflet adapter or CARTO tile service.

Static cell colours are computed once. Temperature and FWI share a lazy weather
request and nearest-sample calculation. h3-js is also loaded on demand. Failed
API requests show an error and can be retried; they are not cached as empty data.
A valid empty event or hotspot response is shown separately from a failed request.

GIBS discovery starts only when a GIBS layer is selected. It searches up to 16
previous days across SNPP, NOAA-20 and Terra, under a bounded time budget, and
checks that both true- and false-colour probe images decode before choosing a
pair. It does not guarantee coverage of every tile. WMS overlays use EPSG:3857
bounding boxes; reflectance sources overzoom their native zoom level 9.

OpenFreeMap's public service has no API keys and currently no SLA. Its tiles,
glyphs and sprites remain external dependencies. The checked-in dark style
removes missing `circle-11` icons and a missing `wood-pattern` texture; place
labels and the woodland fill colour remain.
Keep the visible OpenMapTiles/OpenStreetMap attribution and the upstream
[licence notices](styles/LICENSE.md). Source: [OpenFreeMap](https://openfreemap.org/)
and its [integration guide](https://openfreemap.org/quick_start/).

## Files

- `index.html`: existing Spanish controls, layout, metadata and MapLibre imports.
- `map.js`: renderer, data loading and interactions.
- `styles/dark.json`: OpenFreeMap style snapshot and provenance metadata.
- `data/aragon-density.geojson`: versioned territorial snapshot.
- `build-geojson.mjs`: rebuilds the snapshot from `tmp/digital-twin.sql`.
- `_headers`: response headers and cache rules.
- `../scripts/map-dev.mjs`: local preview and read-only API proxy.
- `../scripts/map-smoke.mjs`: repeatable asset and data checks.

## Validate and deploy

```bash
npm run map:check
npm run typecheck
npm test
npm run map:smoke
# After the local browser checklist passes:
npm run map:deploy
npm run map:smoke -- https://geospatial-platform.diegoromero.es/mapa/
```

The smoke command verifies assets, 9,000+ unique cells, metadata consistency,
API response shapes and weather freshness. It exits non-zero on failure.
It deliberately does not treat HTTP 200 as proof of a correct map image.

Before and after deployment, check all controls listed above in a real browser.
Inspect images, cell detail, wind direction, event popups, the deep link, mobile
layout and console errors. Switch back to Oscuro with overlays still enabled,
then turn them off and on. See the [migration record](../docs/maplibre-migration.md)
for the decisions, observed results, limitations and rollback procedure.

The existing Pages project is `geospatial-platform-map`. The Worker proxies it
under `/mapa/`; a map-only release does not require a Worker deployment.
Rebuild the GeoJSON with `npm run map:build` only when the territorial snapshot
changes. This migration keeps the dataset and its classification scales intact.

## Satellite terrain

Select a satellite background and use **Relieve 3D**, or tilt the map. Elevation
loads on demand. **2D · Norte** removes it and resets the view; **Oscuro** also
returns to 2D. Satellite and false colour receive subtle hillshade. Geo Colour
keeps its cloud imagery without extra shading. See the [terrain record](../docs/terrain-3d.md)
for controls, provider attribution, resource impact, tests and rollback.

`terrain.js` manages this optional mode. `map:check` includes its lifecycle tests
from `scripts/terrain.test.mjs`, including provider errors and timeout fallback.
