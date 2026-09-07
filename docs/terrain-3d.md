# Optional terrain on satellite maps

The map opens in its existing flat view. Choose **Satélite**, **Falso color** or
**Geo Colour**, then press **Relieve 3D**. Tilting the map also loads terrain.
Use two fingers to tilt on a touch screen, right-drag on desktop, or focus the
map and press Shift + Up/Down. Shift + Left/Right rotates it. **2D · Norte**
removes terrain and resets pitch and bearing. **Oscuro** also returns to 2D.

Satellite and false-colour imagery receive subtle hillshade below the H3 cells.
Geo Colour uses terrain without added hillshade: shading clouds would make its
weather imagery harder to read. Heights use an exaggeration of 1; pitch stops
at 60 degrees. This view provides geographic context, not more accurate imagery
or new inputs to the fire-risk model.

## Decisions following elon-algo

| Step | Decision and reason |
| --- | --- |
| Question requirements | Provide visible relief during satellite exploration while keeping the initial map and existing classification scales. Hillshade alone does not create 3D geometry. |
| Attempt deletion | Omit always-on elevation, new SDKs, paid keys, backend elevation services, sky effects and exaggeration settings. None is needed for the requested interaction. |
| Simplify | Use the existing MapLibre renderer and one public elevation dataset. Keep two logical DEM sources because MapLibre 5.24 warns against sharing one instance between terrain and hillshade. |
| Accelerate | Create sources only on request, cap DEM zoom at 12, and remove them on reset. Geo Colour needs only the terrain source. |
| Automate | Test activation, cancellation, provider failure, stalled loading and base changes. Check the deployed module through the existing smoke command. Keep visual checks for real imagery and interaction. |

## Data, cost and failure behaviour

Elevation comes from [Mapzen Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/),
using its public Terrarium PNG endpoint. It needs no API key. The browser contacts
AWS directly; the application adds no Worker, database or paid API call.
This is an external dependency without an availability guarantee from this project.
Provider attribution links appear in the map while elevation is enabled. See the
[dataset attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
and [format specification](https://github.com/tilezen/joerd/blob/master/docs/formats.md).

Initial 2D adds a 3.3 kB JavaScript module (uncompressed) but no DEM requests or terrain rendering.
3D adds elevation downloads, decoding, textures and terrain rendering. The two
logical sources may benefit from HTTP caching, but separate decoding and GPU
resources still have a cost. Removing sources stops their continued use; it does
not clear the browser's HTTP cache. A sampled Aragón tile at z8 was 72,660 bytes,
HTTP 200, on 7 September 2026. This is one tile, not a session bandwidth estimate.

An elevation error or a 15-second initial loading timeout restores 2D and shows a
retry message. Cancelling a load or choosing Oscuro cannot be undone by late data.
A successful first tile marks terrain active; subsequent tile failures still
trigger the fallback. Background imagery failures keep their existing handling.

Wind arrows now rotate and tilt with the map. Event labels and popups remain
upright. Points behind terrain are faded; return to 2D or change the viewing angle
to inspect them. MapLibre intentionally prevents opening a terrain-covered marker.
H3 values, weather calculations and event briefings are unchanged.

## Verification

Local checks on 7 September 2026:

- `npm run map:check`: syntax checks and five terrain lifecycle tests passed.
- `npm run typecheck` and `npm test`: passed; 33 platform tests.
- `npm run map:smoke`: 9,408 unique cells, 481 weather points, 100 observations
  and four events; weather freshness passed.
- Browser: satellite terrain loaded; false colour and Geo Colour switched while
  preserving 3D. Wind, EFFIS, FIRMS and event controls worked together. A visible
  event opened its briefing. Enter also opened the briefing after suppressing
  the native button click that duplicated MapLibre’s keypress handling. Reset and keyboard tilt activated the correct states.
- A rotated wind marker had `rotateX(50deg) rotateZ(156deg)` in its rendered DOM,
  confirming map-relative pitch and bearing were applied.
- The 390 × 844 layout exposed the new controls through the existing Capas panel.

The browser review found no new console warnings or errors. It also caught a
loading-event mismatch and a popup opacity issue; both were corrected. The final keyboard check also caught and fixed the duplicate
Enter action on event buttons. Five unit tests cover failure and timeout paths with a simulated map;
they do not replace a browser test of a real provider outage.

Desktop interactions remained usable with 481 wind markers, but no controlled
FPS, GPU-memory or full-session bandwidth benchmark was run. Physical multitouch
and low-end mobile hardware were not tested. The narrow viewport checks layout
and controls, not device performance. Satellite resolution and cloud cover still
limit visual detail; zooming further cannot recover information from the image.

## Release and rollback

Deploy only the `geospatial-platform-map` Pages project with `npm run map:deploy`.
Then run `npm run map:smoke -- https://geospatial-platform.diegoromero.es/mapa/`
and repeat the 3D controls, background, wind and popup browser checks.
No Worker deployment or data migration is needed.

To roll back this feature, restore the map assets from commit
`2ddb4ce49fe7bc18e612d66e968640ff718860ed` and redeploy Pages. That release already
uses MapLibre and OpenFreeMap and does not restore CARTO.

Production release: [0a635417](https://0a635417.geospatial-platform-map.pages.dev).
The public `/mapa/` route passed the same data smoke checks. Browser checks confirmed
active terrain, 481 wind markers, rotation, Enter opening an event briefing,
false colour with all three GIBS overlays, and Geo Colour with EFFIS and FIRMS.
No console errors or warnings were reported during these checks.

Public assets matched local bytes after deployment:

| Asset | SHA-256 |
| --- | --- |
| `map.js` | `6d74ff1414a48ee436d8cc8f092f50a8cb9d28ee11327dc3f70495f602e3666f` |
| `terrain.js` | `afedb22810e719ba8cc16121384becf6857222f8eeb90afd9290947f959e370e` |
| `styles/dark.json` | `5a8787ff00aa607c5a90190bd4ef89719572e77c3a165c96ccd9c55ea765328b` |
| `data/aragon-density.geojson` | `809682b39c27231226947bd34e1984b1611fab5089a250481283fe6260aefb26` |

Wrangler emitted its existing warning that the root Worker configuration lacks
`pages_build_output_dir`. The explicit Pages directory and project arguments were
used successfully. The Worker configuration was not changed.
