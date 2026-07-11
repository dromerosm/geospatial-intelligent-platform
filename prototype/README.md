# Prototipo — Densidad de población de Aragón

Mapa estático local que dibuja las **9.408 celdas H3 (res-7, ~5 km²)** del Digital
Twin coloreadas por densidad de población (hab/km²). Los datos son los del INE
Censo Anual 2025 interpolados a H3 en la Fase 2.1 — los mismos que hay en D1.

No necesita Cloudflare, Worker ni D1: lee un único GeoJSON generado a partir de
`tmp/digital-twin.sql`.

## Uso

```bash
# 1. Generar el GeoJSON desde el SQL del Digital Twin (usa h3-js del repo)
node prototype/build-geojson.mjs

# 2. Servir la carpeta por HTTP (fetch() no funciona con file://)
python3 -m http.server 8000 --directory prototype
#    -> abrir http://localhost:8000
```

## Ficheros

- `build-geojson.mjs` — parsea `tmp/digital-twin.sql`, convierte cada celda H3 a
  su polígono (`h3-js`) y escribe `data/aragon-density.geojson` (población +
  densidad por celda, más metadatos: nº celdas, población total, rango de densidad).
- `index.html` — mapa Leaflet (canvas), choropleth YlOrRd con cortes fijos
  (la distribución es muy sesgada: de <1 hab/km² en la estepa a ~25.000 en el
  casco urbano de Zaragoza), leyenda, panel de info al pasar el ratón y basemap
  oscuro de CARTO.
- `data/aragon-density.geojson` — generado; no se versiona (ver `.gitignore`).

## Notas

- Leaflet, los tiles de CARTO y el basemap se cargan por CDN/red: requiere conexión.
- Los cortes de la leyenda y la paleta están en las constantes `BREAKS` / `COLORS`
  al inicio del `<script>` de `index.html` si quieres reencuadrar la escala.
