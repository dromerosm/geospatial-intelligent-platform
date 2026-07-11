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
- `index.html` — mapa Leaflet (canvas), selector de capa, leyenda dinámica, panel de
  detalle al pasar el ratón y basemap oscuro de CARTO.
- `data/aragon-density.geojson` — generado; no se versiona (ver `.gitignore`).

## Notas

- Leaflet, los tiles de CARTO y el basemap se cargan por CDN/red: requiere conexión.
- Las capas, cortes y paletas están en la constante `LAYERS` (y `D_/E_BREAKS`, `FUEL`)
  al inicio del `<script>` de `index.html` si quieres reencuadrar escalas o añadir capas.
