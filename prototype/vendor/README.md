# MapLibre browser assets

Unmodified MapLibre GL JS **5.24.0**, served locally to remove a startup CDN
connection. The version is part of the JS and CSS filenames so the files can
use immutable caching. No new runtime package was added.

Sources:

- https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js
- https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css
- https://unpkg.com/maplibre-gl@5.24.0/LICENSE.txt

The license is retained as `maplibre-LICENSE.txt`. When upgrading, download both
assets for the same pinned version, update the HTML and smoke check, and repeat
the map and terrain regression checks. Do not overwrite versioned assets with
different bytes.
