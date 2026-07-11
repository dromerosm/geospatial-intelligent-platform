# Prototipo — Digital Twin de Aragón

Mapa estático local que dibuja las **9.408 celdas H3 (res-7, ~5 km²)** del Digital
Twin. Un selector de **capa** las colorea por distintos campos y, al pasar el ratón,
un panel muestra el detalle completo de la celda. Todos los datos vienen del build
principal (INE Censo Anual 2025, CORINE Land Cover 2018, EFFIS) — los mismos que en D1.

No necesita Cloudflare, Worker ni D1: lee un único GeoJSON generado a partir de
`tmp/digital-twin.sql`.

## Capas

- **Densidad** (hab/km²) — YlOrRd, cortes fijos (distribución muy sesgada: de <1 en la
  estepa a ~25.000 en Zaragoza).
- **% mayores 65+** — rampa BuPu; celdas sin población en gris (evita "0 %" engañoso).
- **Combustible** — clase ordinal derivada de CORINE (nulo → muy alto), rampa de riesgo.
- **Incendio histórico** — binario: área quemada EFFIS (87 celdas) resaltada.

El panel de hover muestra, además: **población desglosada por bandas de edad**
(0-14 / 15-64 / 65+ con % ), uso del suelo, combustible, pendiente, distancia al
activo más cercano, incendio histórico, lat/lon y la celda H3.

## Capas satélite (NASA GIBS)

Segundo eje del mapa, además del choropleth de datos. La **fecha = ayer** (la última
imagen VIIRS totalmente procesada; el día en curso lleva unas horas de latencia),
calculada en cliente. La config exacta de cada capa (tile-matrix, formato) se tomó del
WMTS GetCapabilities autoritativo:
`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml`

**Bases** (selector "Base", radio — WMTS raster):

| Etiqueta | Capa GIBS | Matrix | Formato |
|---|---|---|---|
| Oscuro | CARTO `dark_nolabels` | — | png |
| Satélite | `VIIRS_SNPP_CorrectedReflectance_TrueColor` | Level9 | jpg |
| Falso color | `VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1` | Level9 | jpg |

**Overlays** ("Capas GIBS", multi-selección — WMS PNG transparente; las anomalías
térmicas solo existen como *vector tiles* en WMTS, así que se piden por WMS, que las
rasteriza en servidor):

| Etiqueta | Capa GIBS |
|---|---|
| Focos VIIRS SNPP | `VIIRS_SNPP_Thermal_Anomalies_375m_All` |
| Focos VIIRS N20 | `VIIRS_NOAA20_Thermal_Anomalies_375m_All` |
| Focos MODIS | `MODIS_Terra_Thermal_Anomalies_All` |
| Aerosol / humo | `MODIS_Combined_Value_Added_AOD` |

Endpoints:
- WMTS — `…/wmts/epsg3857/best/{id}/default/{date}/{matrix}/{z}/{y}/{x}.{ext}`
- WMS — `…/wms/epsg3857/best/wms.cgi` (GetMap, `transparent=true`, `time={date}`)

**Añadir más capas GIBS** (en `BASES` / `OVERLAYS` de `index.html`): busca el
`Identifier` en el GetCapabilities y mira su `Format` y `TileMatrixSet`. Si el formato
es `image/png|jpeg` → usa `gibsWmts(id, matrix, ext)`. Si es
`application/vnd.mapbox-vector-tile` → usa `gibsWms(id)`. Los overlays viven en el pane
`gibs` (z-index 450, `pointer-events:none`) para quedar sobre el choropleth sin romper
el hover. GIBS tiene cientos de capas (NDVI, temperatura de superficie, humedad…):
catálogo en https://nasa-gibs.github.io/gibs-api-docs/

## Uso

```bash
# 1. Generar el GeoJSON desde el SQL del Digital Twin (usa h3-js del repo)
node prototype/build-geojson.mjs

# 2. Servir la carpeta por HTTP (fetch() no funciona con file://)
python3 -m http.server 8000 --directory prototype
#    -> abrir http://localhost:8000
```

## Ficheros

- `build-geojson.mjs` — parsea `tmp/digital-twin.sql`, convierte cada celda H3 a su
  polígono (`h3-js`) y escribe `data/aragon-density.geojson` con todos los campos del
  Digital Twin por celda (land cover, combustible, densidad, bandas de edad, dist. a
  activo, histórico de fuego, municipio, lat/lon) + metadatos.
- `index.html` — mapa Leaflet (canvas): selector de capa de datos + selector de base +
  capas satélite GIBS, leyenda dinámica y panel de detalle al pasar el ratón.
- `data/aragon-density.geojson` — dataset generado y **versionado** (es el asset que
  sirve Pages). Se regenera con `npm run map:build`.
- `_headers`, `robots.txt`, `sitemap.xml`, `.assetsignore` — plomería de Cloudflare Pages
  (caché, seguridad, SEO; el build script y este README no se sirven). El favicon va
  inline como data-URI en `index.html` (el mismo que la landing).

## Despliegue (Cloudflare Pages)

Sitio estático desplegado como proyecto Pages **`geospatial-platform-map`**
(`https://geospatial-platform-map.pages.dev`). Los datos son un **snapshot estático**
del Digital Twin (D1 → `tmp/digital-twin.sql` → GeoJSON), servido desde el CDN con
Brotli (~0,8 MB) y caché de edge — **no** se consulta D1 en tiempo real.

```bash
# Refrescar el dato tras reconstruir el Digital Twin, y redesplegar:
npm run twin:build     # (si cambió el twin) D1/INE/CORINE/EFFIS -> tmp/digital-twin.sql
npm run map:build      # tmp/digital-twin.sql -> prototype/data/aragon-density.geojson
npm run map:deploy     # wrangler pages deploy prototype -> Cloudflare Pages
```

El subdominio final (p. ej. una ruta bajo `geospatial-platform.diegoromero.es`) se
enlaza/enruta desde la landing del proyecto; `canonical`/OG ya apuntan a `/mapa/`.

## Notas

- Leaflet, los tiles de CARTO y el basemap se cargan por CDN/red: requiere conexión.
- Las capas, cortes y paletas están en la constante `LAYERS` (y `D_/E_BREAKS`, `FUEL`)
  al inicio del `<script>` de `index.html` si quieres reencuadrar escalas o añadir capas.
