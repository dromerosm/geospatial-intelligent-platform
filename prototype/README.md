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
- **Temperatura** (aire 2 m, °C) — rampa cool→warm. Se calcula on-demand: cada celda toma
  el `temp_c` del punto de `/fire-weather` **más cercano** (nearest-neighbor equirect. en
  cliente, ~213 puntos → 9.408 celdas). Al activar **"Meteo (viento)"** esta capa se
  **auto-selecciona** (ver el viento colorea las celdas por temperatura, con las flechas
  encima). Sin datos → gris; solo carga en `/mapa` (mismo-origin).
- **Peligro (FWI)** — Índice canadiense de peligro (`fwi` de `/fire-weather`) con las
  **clases de peligro EFFIS** (muy bajo <5,2 · bajo · moderado · alto · muy alto · extremo
  ≥50), rampa verde→rojo. Mismo relleno nearest-neighbor y misma carga de meteo que
  Temperatura; integra temp, HR, viento y lluvia en un solo número. Sin datos → gris.

(El histórico de incendios EFFIS ya no es una CAPA: está como overlay "EFFIS histórico"
en *Capas del proyecto*.)

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

> Nota: se probó una capa de aerosol/humo (`MODIS_Combined_Value_Added_AOD`) pero
> es un producto coarse (~10 km, tile-matrix Level6) que a escala regional se ve como
> bloques enormes, así que se retiró. El humo se aprecia mejor en las bases true-color /
> falso color. GIBS no ofrece un raster de humo diario de alta resolución.

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

## Capas del proyecto (dinámicas, en vivo)

Sección "Capas del proyecto" — leen la API del Worker **mismo-origin** (solo funcionan
en `/mapa`, no en `.pages.dev`/local, donde degradan sin romper):

- **EFFIS histórico** — celdas quemadas (`hist_fire`) del propio dataset estático,
  resaltadas en rojo. No hace red.
- **FIRMS focos** — focos VIIRS en vivo desde `/observations` (polígonos
  `footprint_geojson`), carga perezosa al activar.
- **Meteo (viento)** — ~213 puntos de `/fire-weather` (grid uniforme en superficie
  ~15 km **recortado al límite de Aragón**, `src/weather-points.json`, cadencia 3 h).
  Flechas orientadas por `wind_dir_deg` (apuntan a dónde va el viento), coloreadas por
  velocidad (azul <15, amarillo 15–30, naranja ≥30 km/h) y con anillo rojo en
  **Triple-30** (temp>30 · viento>30 · HR<30). Las filas solo traen `h3_cell`, así que se
  carga **h3-js perezosamente** (jsDelivr, solo al activar la capa) para geolocalizar los
  puntos con `cellToLatLng` — sin penalizar la carga por defecto ni tocar el Worker.

### Meteo — pendiente para el futuro

Las CAPAs **Temperatura** y **Peligro (FWI)** (aire 2 m / índice FWI, relleno
nearest-neighbor) ya están — ver la sección de capas. Ideas para mejorarlas o extender,
por orden de valor:

- **Corrección por altitud (*lapse rate*)** — es el límite de calidad real, no NN vs IDW.
  El NN por distancia horizontal ignora la cota; en montaña (Pirineo/Ibérica) puede sesgar.
  Exponiendo la elevación por celda en el GeoJSON (el twin ya la tiene) y guardando la cota
  de cada punto de meteo, un IDW + corrección de ~6,5 °C/km daría un campo más fiel. En la
  práctica el sesgo hoy es suave porque las muestras de Open-Meteo ya llevan su altitud.
- **Otras variables como campo** (HR, viento) — mismo patrón NN sobre `rh_pct` / `wind_kmh`.
- **Previsión a 3 días (hover)** — la ingesta guarda `forecast_json` (72 pasos horarios) por
  punto, pero `currentFireWeather` lo **excluye** de `/fire-weather` (~213 filas × 72 pasos =
  respuesta pesada). Para un sparkline al pinchar un punto haría falta un endpoint pequeño,
  p. ej. `GET /fire-weather?cell=<h3>` que devuelva el `forecast_json` de ese punto (cambio
  mínimo + deploy del Worker).

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
