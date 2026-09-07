# MapLibre and OpenFreeMap migration

Date: 7 September 2026. Owner: Diego Romero. Scope: the Aragón map frontend.

CARTO returned HTTP 200 images containing an “API KEY REQUIRED” watermark.
A transport-only check missed the defect. The replacement uses MapLibre GL JS
5.24.0 and OpenFreeMap. Existing Worker routes, ingestion schedules, scoring,
D1, R2 and Telegram delivery are outside this change.

## Decisions using elon-algo

| Area | Decision | Evidence and rationale | Owner or dependency | Validation |
| --- | --- | --- | --- | --- |
| Requirements challenged | Preserve the existing data, scales, imagery, events and interactions. Change the renderer and base provider. | A dark map and working operational layers are the outcome; Leaflet and CARTO were implementation choices. | Diego; existing API contracts. | Desktop/mobile browser checklist and identical snapshot. |
| Deletion candidates | Remove Leaflet, CARTO tile requests, the Leaflet bridge option, canvas/SVG panes and per-cell restyling. Remove broken place icons and woodland texture references. | One renderer is enough. The OFM sprite lacked `circle-11` and `wood-pattern`. Labels and woodland fill remain. | MapLibre; OpenFreeMap style. | No Leaflet/CARTO service requests; no missing-icon warning after correction. |
| Simplification | Load one style and toggle background visibility. Keep GeoJSON and the static HTML panel. | Replacing the whole style risks losing custom layers. A framework, vector-tile backend and new database schema add no value to this repair. | Existing Pages project. | Overlay selections survive all background switches. |
| Acceleration | Compute static colours once; share lazy weather, h3-js and GIBS requests. | Avoid redundant per-cell updates and duplicate requests. No performance improvement is claimed without a benchmark. | Browser and public APIs. | One weather load supplies temperature, FWI and wind; map remains interactive. |
| Automation | Add a read-only preview, deployment smoke checks and CI syntax validation. | These checks are stable and cheap. Visual QA remains necessary because valid image responses may contain warnings. | Maintainer; GitHub Actions. | Commands exit 0 and the browser checklist passes before release. |

The old rendering path was removed while keeping every user function.
No deleted feature needed restoration during the local trials. Keeping two map
engines solely as a rollback path would increase maintenance; Git and Pages retain
the previous version instead.

## Local verification

Commands: `npm run map:check`, `npm run typecheck`, `npm test`, and
`npm run map:smoke` against `http://127.0.0.1:8000/mapa/`.
All returned exit code 0. The existing 33 unit tests passed. Those tests cover the
engine, FWI and H3 helpers, not the browser renderer.

Browser checks used the local frontend with the preview's read-only production
API proxy. This is not an isolated backend test. Observed data: 9,408 cells,
1,362,718 inhabitants, 481 weather points and 100 recent FIRMS footprints.
The active event count changed from three to four during the session.

| Check | Local result |
| --- | --- |
| OpenFreeMap dark background | Rendered without the CARTO watermark; attribution visible. |
| Five thematic layers | Density, age, fuel, temperature and FWI rendered with their legends. |
| Cell inspection | A click displayed Lécera, population and age bands, fuel, slope, asset distance and H3. |
| Weather | 481 arrows; enabling wind selected temperature; disabling removed arrows. |
| Events | Priority markers and readable briefing popup; actions and precision expanded. |
| FIRMS / EFFIS | Recent footprints and historical burnt cells displayed. |
| NASA backgrounds | True and false colour rendered for VIIRS SNPP, 6 September 2026. |
| GIBS overlays | SNPP, NOAA-20 and MODIS toggled together above the cells. |
| Background switches | Existing project overlays remained selected and visible. |
| Mobile | 390 × 844 viewport; layer panel opened/closed; deep link centred and opened a scrollable briefing. |

The initial browser run exposed a removed MapLibre `supported()` API call. It was
removed before release. Missing `circle-11` and `wood-pattern` warnings were fixed in the local style.
The sprite inventory confirmed both were absent, while `oneway` was available.
One EUMETSAT WMS tile returned HTTP 500 during the local imagery check. Repeating
the exact request returned HTTP 200. Treat this as an observed transient provider
failure, not proof of uninterrupted availability. The UI reports resource failures.

## Remote verification

Published to Pages deployment `3fc8aad3-0235-4868-ad05-0de97571f78a`:
[deployment URL](https://3fc8aad3.geospatial-platform-map.pages.dev).
The production browser checks used the canonical
[public map](https://geospatial-platform.diegoromero.es/mapa/).

`npm run map:smoke -- https://geospatial-platform.diegoromero.es/mapa/` passed
with 9,408 cells, 481 weather points, 100 observations and four active events.
The full desktop checklist was repeated: all five thematic layers, all four
backgrounds, all three GIBS overlays, EFFIS, FIRMS, weather, cell details and events.
Switching to Oscuro preserved enabled overlays; each overlay could be turned off
and restored. An event opened with Enter and its actions/precision expanded.

At 390 × 844, the production deep link opened the correct event, the popup stayed
within the viewport, and the layer panel opened and closed. An unknown event link
showed “el evento del enlace ya no está activo”. No MapLibre errors or warnings
were captured during the production pass. This is a point-in-time browser check,
not a load test or a guarantee of provider uptime. Triple-30 was zero during the
checks, so no live red-ring example was available.

Deployed JavaScript, style and GeoJSON bytes matched the local files:

| File | SHA-256 |
| --- | --- |
| `map.js` | `893e4fb8bbbfce133d90c24002056d87c3bf85907bba0a413026193311af192a` |
| `styles/dark.json` | `5a8787ff00aa607c5a90190bd4ef89719572e77c3a165c96ccd9c55ea765328b` |
| `data/aragon-density.geojson` | `809682b39c27231226947bd34e1984b1611fab5089a250481283fe6260aefb26` |

The canonical HTML matched the local content before Cloudflare's injected script.
A first byte comparison used `/mapa/index.html`, which the existing Pages/Worker
redirect path sends to the landing page. The check was corrected to `/mapa/`.
Use that canonical route; this migration does not change the Worker proxy.

Wrangler warned that the root Worker configuration lacks `pages_build_output_dir`.
The existing deploy command explicitly supplies the Pages directory and project,
so Wrangler ignored that Worker config and successfully deployed the static site.
No configuration or binding changes were needed.

Deployment preceded commit, as requested. Pages therefore records the old Git
head plus a dirty working tree; the file hashes above identify the tested release.
The subsequent migration commit records the deployed source and this report.

## Operating limits

- OpenFreeMap, NASA GIBS, EUMETSAT and the library CDNs need network access.
- OpenFreeMap's public instance currently provides no SLA. Self-hosting is possible
  but adds an operations burden that this change does not require.
- MapLibre needs a browser capable of WebGL rendering. Constructor/load failures
  produce an error message; a second rendering engine is not bundled.
- API layers are snapshots loaded on demand for the current page session. Reload
  for fresh data. This preserves the existing behaviour; no polling was added.
- Weather colours still use the nearest sample, without altitude correction.
- Existing event scoring, missing territorial context and briefing freshness
  findings from the earlier review are not fixed by changing the renderer.

## Release and rollback

Target: existing Cloudflare Pages project `geospatial-platform-map`, production
branch `main`, public route `https://geospatial-platform.diegoromero.es/mapa/`.
No Worker deployment or database migration is needed.

Pre-migration Pages deployment: `d59ff751-d2f7-40bb-8b7b-e06471eee8f9`, source
`b474317d3298a2f3cec75f22188a9a298d38c8b6`.

If the migration causes a regression, use the Pages dashboard to roll back to that
production deployment. Then revert the migration commit in Git, run validation and
push the revert. This restores the old visor but also restores its known CARTO
watermark; rollback is for restoring functionality, not resolving that provider issue.

## Sources

- [OpenFreeMap service and terms](https://openfreemap.org/)
- [OpenFreeMap integration guide](https://openfreemap.org/quick_start/)
- [MapLibre WMS example](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-wms-source/)
- [Upstream style licences](https://github.com/hyperknot/openfreemap-styles/blob/main/LICENSE.md)
