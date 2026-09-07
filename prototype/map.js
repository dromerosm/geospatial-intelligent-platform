import { createTerrain } from './terrain.js';
    const fmt = (n) => Math.round(n).toLocaleString("es-ES");
    const NODATA = "#3a3d44";

    // Pick the colour for a value from ascending break lower-bounds.
    function breakColor(v, breaks, colors) {
      for (let i = breaks.length - 1; i >= 0; i--) if (v >= breaks[i]) return colors[i];
      return colors[0];
    }
    // Build legend rows (top = highest class) from breaks + colours + labels.
    function breakLegend(colors, labels) {
      return colors.map((c, i) => ({ color: c, label: labels[i] })).reverse();
    }

    // --- Population density (hab/km²) — hand-set breaks, YlOrRd ------------------
    const D_BREAKS = [0, 1, 5, 10, 25, 50, 100, 250, 1000];
    const D_COLORS = ["#ffffcc","#ffeda0","#fed976","#feb24c","#fd8d3c","#fc4e2a","#e31a1c","#bd0026","#800026"];
    const D_LABELS = ["< 1","1 – 5","5 – 10","10 – 25","25 – 50","50 – 100","100 – 250","250 – 1000","≥ 1000"];

    // --- % population 65+ — BuPu; uninhabited cells greyed out ------------------
    const E_BREAKS = [0, 15, 20, 25, 30, 40];
    const E_COLORS = ["#edf8fb","#b3cde3","#8c96c6","#8856a7","#810f7c","#4d004b"];
    const E_LABELS = ["< 15 %","15 – 20 %","20 – 25 %","25 – 30 %","30 – 40 %","≥ 40 %"];

    // --- Fuel class (CORINE-derived, ordinal) — warm fire-risk ramp ------------
    const FUEL = [
      { key: "very_high", color: "#800026", label: "Muy alto" },
      { key: "high",      color: "#e31a1c", label: "Alto" },
      { key: "medium",    color: "#fd8d3c", label: "Medio" },
      { key: "low",       color: "#fed976", label: "Bajo" },
      { key: "none",      color: "#6b7076", label: "Nulo (agua/urbano)" },
    ];
    const FUEL_COLOR = Object.fromEntries(FUEL.map((f) => [f.key, f.color]));
    const FUEL_LABEL = Object.fromEntries(FUEL.map((f) => [f.key, f.label]));

    // --- Air temperature 2 m (°C) — cool→warm; nearest fire-weather point ------
    const T_BREAKS = [-100, 10, 20, 25, 30, 35];
    const T_COLORS = ["#4575b4","#91bfdb","#e0f3f8","#fee090","#fc8d59","#d73027"];
    const T_LABELS = ["< 10","10 – 20","20 – 25","25 – 30","30 – 35","≥ 35"];

    // --- Fire Weather Index (Canadian FWI) — EFFIS danger classes -------------
    const FWI_BREAKS = [0, 5.2, 11.2, 21.3, 38, 50];
    const FWI_COLORS = ["#1a9850","#91cf60","#fee08b","#fc8d59","#d73027","#7f0000"];
    const FWI_LABELS = ["Muy bajo","Bajo","Moderado","Alto","Muy alto","Extremo"];

    // Layers: colorOf(properties) -> fill; legend rows; legend title.
    const LAYERS = {
      density: {
        label: "Densidad",
        legendTitle: "Habitantes / km²",
        colorOf: (p) => breakColor(p.density, D_BREAKS, D_COLORS),
        legend: breakLegend(D_COLORS, D_LABELS),
      },
      elderly: {
        label: "% mayores 65+",
        legendTitle: "% población 65+",
        colorOf: (p) => (p.population > 0 ? breakColor(p.pct_elderly, E_BREAKS, E_COLORS) : NODATA),
        legend: breakLegend(E_COLORS, E_LABELS).concat([{ color: NODATA, label: "sin población" }]),
      },
      fuel: {
        label: "Combustible",
        legendTitle: "Clase de combustible",
        colorOf: (p) => FUEL_COLOR[p.fuel_type] ?? NODATA,
        legend: FUEL.map((f) => ({ color: f.color, label: f.label })).concat([{ color: NODATA, label: "sin dato" }]),
      },
      // Air temperature: nearest fire-weather point, computed on demand.
      temp: {
        label: "Temperatura",
        legendTitle: "Temperatura aire 2 m (°C)",
        needs: "weather",
        colorOf: (p) => (p._temp == null ? NODATA : breakColor(p._temp, T_BREAKS, T_COLORS)),
        legend: breakLegend(T_COLORS, T_LABELS).concat([{ color: NODATA, label: "sin dato" }]),
      },
      // Fire Weather Index (danger): same nearest-point fill, EFFIS classes.
      fwi: {
        label: "Peligro (FWI)",
        legendTitle: "Índice FWI · clases EFFIS",
        needs: "weather",
        colorOf: (p) => (p._fwi == null ? NODATA : breakColor(p._fwi, FWI_BREAKS, FWI_COLORS)),
        legend: breakLegend(FWI_COLORS, FWI_LABELS).concat([{ color: NODATA, label: "sin dato" }]),
      },
    };

// One MapLibre style owns the base and all project layers. Base switches only
// change visibility, so selections and loaded data survive satellite switches.
const $ = (id) => document.getElementById(id);
const status = (message = '') => { $('map-status').textContent = message; };
const collection = (features = []) => ({ type: 'FeatureCollection', features });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let terrain;
let map, FC, ACT = LAYERS.density;
let baseIds = [], weatherPromise, h3Promise, wxReady = false;
const selected = new Set();
const groups = new Map();
const eventMarkers = new Map();
const layerButtons = {};
const baseButtons = {};
const projectButtons = {};

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function pressed(button, on) {
  button.classList.toggle('active', on);
  button.setAttribute('aria-pressed', String(on));
}
function button(container, label, action) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; b.disabled = true;
  pressed(b, false);
  b.onclick = async () => {
    b.disabled = true;
    status();
    try { await action(b); } catch (err) { status(`${label}: no se pudo cargar (${err.message}). Pulsa de nuevo para reintentar.`); }
    finally { b.disabled = false; }
  };
  $(container).appendChild(b);
  return b;
}
function visibility(ids, on) {
  for (const id of ids) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
function addGeo(id, data, paint, linePaint) {
  map.addSource(id, { type: 'geojson', data });
  const ids = [id];
  map.addLayer({ id, type: 'fill', source: id, paint, layout: { visibility: 'none' } });
  if (linePaint) {
    ids.push(`${id}-line`);
    map.addLayer({ id: `${id}-line`, type: 'line', source: id, paint: linePaint, layout: { visibility: 'none' } });
  }
  return { show: (on) => visibility(ids, on) };
}
function markerGroup(markers) {
  return { show: (on) => markers.forEach((m) => on ? m.addTo(map) : (m.getPopup()?.remove(), m.remove())) };
}

$('panel-toggle').onclick = () => {
  const open = $('title').classList.toggle('open');
  $('panel-toggle').setAttribute('aria-expanded', String(open));
  $('panel-toggle').textContent = open ? '✕ Cerrar' : '☰ Capas';
};

// Preserve the five original scales. Precompute static colours once; changing
// a layer is a paint expression, not a re-upload of 9,408 polygons.
function renderLegend() {
  $('legend-title').textContent = ACT.legendTitle;
  $('legend-rows').innerHTML = ACT.legend.map((r) => `<div class="lg-row"><i style="background:${r.color}"></i><span class="lg-label">${r.label}</span></div>`).join('');
}
async function selectLayer(key) {
  ACT = LAYERS[key];
  Object.entries(layerButtons).forEach(([k, b]) => pressed(b, key === k));
  renderLegend();
  map.setPaintProperty('cells', 'fill-color', ['coalesce', ['get', `color_${key}`], NODATA]);
  if (ACT.needs === 'weather' && !wxReady) {
    const w = await loadWeather();
    for (const f of FC.features) {
      const { lat, lng } = f.properties;
      const kx = Math.cos(lat * Math.PI / 180);
      let best = Infinity, near = null;
      for (const p of w.pts) {
        const d = (lat - p.lat) ** 2 + ((lng - p.lng) * kx) ** 2;
        if (d < best) { best = d; near = p.row; }
      }
      f.properties._temp = near?.temp_c ?? null;
      f.properties._fwi = near?.fwi ?? null;
      f.properties.color_temp = LAYERS.temp.colorOf(f.properties);
      f.properties.color_fwi = LAYERS.fwi.colorOf(f.properties);
    }
    map.getSource('cells').setData(FC);
    wxReady = true;
  }
}
Object.entries(LAYERS).forEach(([key, layer]) => {
  layerButtons[key] = button('seg', layer.label, () => selectLayer(key));
});
pressed(layerButtons.density, true);
renderLegend();

const GIBS_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi';
const EUMET_WMS = 'https://view.eumetsat.int/geoserver/wms';
const SENSORS = [
  { tc: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', fc: 'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1', label: 'VIIRS SNPP' },
  { tc: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', fc: 'VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1', label: 'VIIRS NOAA-20' },
  { tc: 'MODIS_Terra_CorrectedReflectance_TrueColor', fc: 'MODIS_Terra_CorrectedReflectance_Bands721', label: 'MODIS Terra' },
];
const wmts = (id, date) => `${GIBS_WMTS}/${id}/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
function wms(endpoint, layer, date, transparent = true) {
  const query = new URLSearchParams({ service: 'WMS', request: 'GetMap', version: '1.1.1', layers: layer, styles: '', format: transparent ? 'image/png' : 'image/jpeg', transparent: String(transparent), srs: 'EPSG:3857', width: '256', height: '256' });
  if (date) query.set('time', date);
  return `${endpoint}?${query}&bbox={bbox-epsg-3857}`;
}
let gibsPromise;
function ensureGibsDate() {
  if (gibsPromise) return gibsPromise;
  gibsPromise = (async () => {
    // Keep the existing bounded date/sensor fallback, but verify both products.
    // Probe only after a user asks for GIBS, and share concurrent requests.
    $('sat-note').textContent = 'Buscando la imagen más reciente…';
    const deadline = Date.now() + 45000;
    for (let back = 1; back <= 16 && Date.now() < deadline; back++) {
      const date = new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
      for (const sensor of SENSORS) {
        const available = await Promise.all([sensor.tc, sensor.fc].map(async (id) => {
          try {
            const r = await fetch(wmts(id, date).replace('{z}/{y}/{x}', '3/4/2'), { signal: AbortSignal.timeout(4000) });
            if (!r.ok || !r.headers.get('content-type')?.startsWith('image/')) return false;
            const bitmap = await createImageBitmap(await r.blob()); bitmap.close();
            return true;
          } catch { return false; }
        }));
        if (available.every(Boolean)) return { date, sensor };
        if (Date.now() >= deadline) break;
      }
    }
    throw new Error('GIBS no ofrece imágenes recientes de ambos productos');
  })().catch((err) => { gibsPromise = null; $('sat-note').textContent = err.message; throw err; });
  return gibsPromise;
}
const BASES = { oscuro: 'Oscuro', satelite: 'Satélite', geocolour: 'Geo Colour', falso: 'Falso color' };
const OVERLAYS = {
  firesSNPP: { label: 'Focos VIIRS SNPP', product: 'VIIRS_SNPP_Thermal_Anomalies_375m_All' },
  firesN20: { label: 'Focos VIIRS N20', product: 'VIIRS_NOAA20_Thermal_Anomalies_375m_All' },
  firesMODIS: { label: 'Focos MODIS', product: 'MODIS_Terra_Thermal_Anomalies_All' },
};
function addRaster(id, tiles, attribution, before, maxzoom = 19) {
  if (map.getLayer(id)) return;
  map.addSource(id, { type: 'raster', tiles: [tiles], tileSize: 256, maxzoom, attribution });
  map.addLayer({ id, type: 'raster', source: id, layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } }, before);
}
let baseRequest = 0;
async function selectBase(key) {
  const request = ++baseRequest;
  let note = '';
  if (key === 'satelite' || key === 'falso') {
    const { date, sensor } = await ensureGibsDate();
    if (request !== baseRequest) return;
    addRaster(key, wmts(key === 'satelite' ? sensor.tc : sensor.fc, date), 'Imagery © NASA EOSDIS GIBS', map.getLayer('terrain-shade') ? 'terrain-shade' : 'cells', 9);
    note = `${BASES[key]}: ${sensor.label} · ${date}`;
  } else if (key === 'geocolour') {
    addRaster(key, wms(EUMET_WMS, 'mtg_fd:rgb_geocolour', null, false), 'Imagery © EUMETSAT', map.getLayer('terrain-shade') ? 'terrain-shade' : 'cells');
    note = 'Satélite: MTG Geo Colour · último fotograma disponible · © EUMETSAT';
  }
  visibility(baseIds, key === 'oscuro');
  for (const k of ['satelite', 'falso', 'geocolour']) if (map.getLayer(k)) visibility([k], k === key);
  Object.entries(baseButtons).forEach(([k, b]) => pressed(b, k === key));
  $('sat-note').textContent = note;
  terrain.setBase(key);
}
Object.entries(BASES).forEach(([key, label]) => { baseButtons[key] = button('base-seg', label, () => selectBase(key)); });
pressed(baseButtons.oscuro, true);
Object.entries(OVERLAYS).forEach(([key, ov]) => {
  button('ov-seg', ov.label, async (b) => {
    const on = !selected.has(key);
    if (on && !map.getLayer(key)) {
      const { date } = await ensureGibsDate();
      addRaster(key, wms(GIBS_WMS, ov.product, date), 'Imagery © NASA EOSDIS GIBS', 'effis');
      $('sat-note').textContent = `Focos GIBS: ${date}`;
    }
    visibility([key], on);
    on ? selected.add(key) : selected.delete(key);
    pressed(b, on);
  });
});

function ensureH3() {
  if (!h3Promise) h3Promise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/h3-js@4.1.0/dist/h3-js.umd.js';
    s.onload = () => resolve(window.h3);
    s.onerror = () => { s.remove(); h3Promise = null; reject(new Error('h3-js no disponible')); };
    document.head.appendChild(s);
  });
  return h3Promise;
}
function loadWeather() {
  if (!weatherPromise) weatherPromise = Promise.all([ensureH3(), getJson('/fire-weather')]).then(([h3, rows]) => {
    if (!Array.isArray(rows) || !rows.length) throw new Error('no hay datos meteorológicos');
    const pts = rows.map((row) => { const [lat, lng] = h3.cellToLatLng(row.h3_cell); return { lat, lng, row }; });
    const t30 = rows.filter((r) => r.triple30).length;
    $('meteo-note').textContent = `Meteo: ${pts.length} puntos · ${t30} en Triple-30`;
    return { pts, t30 };
  }).catch((err) => { weatherPromise = null; throw err; });
  return weatherPromise;
}
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
async function loadMeteo() {
  const w = await loadWeather();
  return markerGroup(w.pts.map(({ lat, lng, row: r }) => {
    const el = document.createElement('div'); el.className = 'wind-arrow';
    el.title = `${r.temp_c}°C · HR ${r.rh_pct}% · viento ${r.wind_kmh} km/h ${COMPASS[Math.round(r.wind_dir_deg / 45) % 8]}${r.triple30 ? ' · ⚠ Triple-30' : ''}`;
    const color = r.triple30 ? '#ff3b30' : r.wind_kmh >= 30 ? '#ff8c00' : r.wind_kmh >= 15 ? '#ffd11a' : '#8fd0ff';
    el.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22">${r.triple30 ? '<circle cx="11" cy="11" r="9.5" fill="none" stroke="#ff3b30" stroke-width="2"/>' : ''}<g><path d="M11 4 V17 M11 4 L8 8 M11 4 L14 8" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round"/></g></svg>`;
    el.setAttribute('role', 'img'); el.setAttribute('aria-label', el.title);
    return new maplibregl.Marker({ element: el, rotation: (Number(r.wind_dir_deg) + 180) % 360, rotationAlignment: 'map', pitchAlignment: 'map', opacityWhenCovered: 0.3 }).setLngLat([lng, lat]);
  }));
}
async function loadFirms() {
  const rows = await getJson('/observations');
  if (!Array.isArray(rows)) throw new Error('respuesta FIRMS no válida');
  const features = [];
  for (const o of rows) {
    try { features.push({ type: 'Feature', geometry: JSON.parse(o.footprint_geojson), properties: { acquired_at: o.acquired_at, confidence: o.confidence } }); } catch { /* Skip malformed footprints. */ }
  }
  const group = addGeo('firms', collection(features), { 'fill-color': '#ffa500', 'fill-opacity': .6 }, { 'line-color': '#ff8c00', 'line-width': 1 });
  const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  map.on('mousemove', 'firms', (e) => {
    const p = e.features[0].properties;
    tip.setLngLat(e.lngLat).setText(`FIRMS · ${p.acquired_at} · conf ${p.confidence}`).addTo(map);
  });
  map.on('mouseleave', 'firms', () => tip.remove());
  $('firms-note').textContent = features.length ? `FIRMS: ${features.length} focos recientes` : 'FIRMS: sin focos recientes';
  return { show: (on) => { group.show(on); if (!on) tip.remove(); } };
}
const PRIO = { critical: '#e5484d', high: '#ff8c00', medium: '#e2b53d', low: '#6b7280' };
async function loadEvents() {
  const [h3, rows] = await Promise.all([ensureH3(), getJson('/events')]);
  if (!Array.isArray(rows)) throw new Error('respuesta de eventos no válida');
  const markers = rows.map((e) => {
    const [lat, lng] = h3.cellToLatLng(e.h3_cell);
    let b; try { b = JSON.parse(e.briefing_json); } catch { /* Pending briefing. */ }
    const prio = b?.priority || 'medium';
    const actions = (b?.recommended_actions || []).map((a) => `<li>${esc(a)}</li>`).join('');
    const body = b ? `<div>${esc(b.briefing_text)}</div><details style="margin-top:6px"><summary>Acciones y precisión</summary><ul>${actions}</ul><p>${esc(b.source_precision_statement)}</p></details>` : '<div>Sin briefing todavía (se genera en la próxima pasada del motor).</div>';
    const popup = new maplibregl.Popup({ maxWidth: '300px', offset: 12 }).setHTML(`<div style="font:13px/1.4 system-ui"><strong style="color:${PRIO[prio] || PRIO.medium}">${esc(prio)}</strong><div>${esc(e.h3_cell)} · score ${esc(e.det_score)} · conf ${esc(e.det_confidence)}</div>${body}</div>`);
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'event-marker'; el.style.backgroundColor = PRIO[prio] || PRIO.medium;
    el.setAttribute('aria-label', `Evento ${e.h3_cell} · ${prio}`);
    // MapLibre toggles on keypress; suppress the button's second native click.
    el.addEventListener('keypress', (event) => {
      if (event.code === 'Enter' || event.code === 'Space') event.preventDefault();
    });
    const marker = new maplibregl.Marker({ element: el, opacityWhenCovered: 0.3 }).setLngLat([lng, lat]).setPopup(popup);
    eventMarkers.set(e.h3_cell, marker);
    return marker;
  });
  $('events-note').textContent = rows.length ? `Eventos: ${rows.length} activo(s) · pulsa un punto para el briefing` : 'Eventos: ninguno activo ahora';
  return markerGroup(markers);
}
const PROJECTS = {
  eventos: { label: 'Eventos + IA', load: loadEvents },
  effis: { label: 'EFFIS histórico', load: () => groups.get('effis') },
  firms: { label: 'FIRMS focos', load: loadFirms },
  meteo: { label: 'Meteo (viento)', load: loadMeteo },
};
async function toggleProject(key, on = !selected.has(key)) {
  if (!groups.has(key)) groups.set(key, await PROJECTS[key].load());
  groups.get(key).show(on);
  on ? selected.add(key) : selected.delete(key);
  pressed(projectButtons[key], on);
  if (key === 'meteo' && on) await selectLayer('temp');
}
Object.entries(PROJECTS).forEach(([key, ov]) => { projectButtons[key] = button('proj-seg', ov.label, () => toggleProject(key)); });
    const info = document.getElementById("info");
    const set = (id, v) => (document.getElementById(id).textContent = v);
    const band = (n, pop) => `${fmt(n)} (${pop > 0 ? Math.round((n / pop) * 100) : 0} %)`;
    function showInfo(p) {
      set("in-muni", p.municipio || "Sin municipio");
      set("in-dens", fmt(p.density) + " hab/km²");
      set("in-pop", fmt(p.population) + " hab");
      set("in-child", band(p.pop_child, p.population));
      set("in-adult", band(p.pop_adult, p.population));
      set("in-eld2", band(p.pop_elderly, p.population));
      set("in-lc", p.land_cover || "—");
      set("in-fuel", FUEL_LABEL[p.fuel_type] || "—");
      set("in-slope", p.slope_deg != null ? p.slope_deg.toFixed(1) + "°" : "—");
      set("in-dist", p.dist_asset_m != null ? fmt(p.dist_asset_m) + " m" : "—");
      set("in-fire", p.hist_fire ? "Sí" : "No");
      set("in-ll", p.lat != null ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : "—");
      set("in-h3", p.h3);
      info.style.display = "block";
    }


async function start() {
  if (!window.maplibregl) throw new Error('No se pudo cargar MapLibre. Revisa la conexión y recarga la página.');
  // Start the basemap from a tiny manifest while the territorial payload loads.
  const dataPromise = getJson('data/aragon-density.geojson').then(
    (data) => ({ data }), (error) => ({ error }));
  const [style, metadata] = await Promise.all([getJson('styles/dark.json'), getJson('data/map-metadata.json')]);
  baseIds = style.layers.map((l) => l.id);
  const padding = { top: 24, bottom: 30, left: innerWidth > 640 ? 350 : 24, right: 24 };
  map = new maplibregl.Map({ container: 'map', style, bounds: metadata.bounds, fitBoundsOptions: { padding }, maxZoom: 19, maxPitch: 0, pitchWithRotate: true, attributionControl: false });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.on('error', (e) => {
    if (terrain?.handleError(e)) return;
    console.error('Map resource error:', e.error);
    status('No se ha podido cargar un recurso del mapa. Puedes cambiar de fondo o recargar la página.');
  });
  await new Promise((resolve) => map.once('load', resolve));
  const result = await dataPromise;
  if (result.error) throw result.error;
  const fc = result.data;
  FC = fc;
  for (let i = 0; i < fc.features.length; i++) {
    const f = fc.features[i];
    for (const [key, layer] of Object.entries(LAYERS)) f.properties[`color_${key}`] = layer.colorOf(f.properties);
    // Let input and paint run between batches on slower phones.
    if (i % 500 === 499) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  map.addSource('cells', { type: 'geojson', data: FC, promoteId: 'h3' });
  map.addLayer({ id: 'cells', source: 'cells', type: 'fill', paint: { 'fill-color': ['get', 'color_density'], 'fill-opacity': .75 } });
  map.addLayer({ id: 'cell-lines', source: 'cells', type: 'line', paint: { 'line-color': '#000', 'line-width': .15 } });
  map.addLayer({ id: 'cell-hover', source: 'cells', type: 'line', paint: { 'line-color': '#fff', 'line-width': 1.2 }, filter: ['==', ['get', 'h3'], ''] });
  terrain = createTerrain(map, ({ state, available, message }) => {
    $('terrain-3d').disabled = !available || state === 'loading';
    pressed($('terrain-3d'), state !== 'flat');
    $('terrain-note').textContent = message || (available
      ? (state === 'flat' ? 'Inclina con dos dedos o Mayús + ↑/↓. Gira con Mayús + ←/→.' : 'Relieve 3D · alturas reales')
      : 'Selecciona una base satélite para explorar el relieve.');
  });
  $('terrain-3d').onclick = () => terrain.enable();
  $('terrain-2d').onclick = () => terrain.reset();
  $('terrain-2d').disabled = false;
  terrain.setBase('oscuro');
  function inspect(e) {
    const f = e.features?.[0]; if (!f) return;
    showInfo(f.properties);
    map.setFilter('cell-hover', ['==', ['get', 'h3'], f.properties.h3]);
  }
  map.on('mousemove', 'cells', inspect);
  map.on('click', 'cells', inspect); // touch users can inspect a cell too
  map.on('mouseleave', 'cells', () => { info.style.display = 'none'; map.setFilter('cell-hover', ['==', ['get', 'h3'], '']); });
  groups.set('effis', addGeo('effis', collection(fc.features.filter((f) => f.properties.hist_fire === 1)), { 'fill-color': '#ff4d4d', 'fill-opacity': .35 }, { 'line-color': '#ff4d4d', 'line-width': 1 }));
  const m = fc.metadata || {};
  set('st-cells', fmt(m.cells ?? fc.features.length)); set('st-pop', fmt(m.populationTotal ?? 0));
  set('st-eld', (m.populationTotal ? Math.round(m.elderlyTotal / m.populationTotal * 100) : 0) + ' %');

  for (const id of ['seg', 'base-seg', 'ov-seg', 'proj-seg']) for (const b of $(id).children) b.disabled = false;
  $('map').setAttribute('aria-label', `Mapa de Aragón · ${fc.features.length} celdas`);
  const focusCell = new URLSearchParams(location.search).get('event');
  if (focusCell) {
    await toggleProject('eventos', true);
    const marker = eventMarkers.get(focusCell);
    if (marker) { map.jumpTo({ center: marker.getLngLat(), zoom: 10 }); marker.togglePopup(); }
    else $('events-note').textContent = 'Eventos: el evento del enlace ya no está activo';
  }
}
start().catch((err) => { console.error(err); status(`No se pudo cargar el mapa: ${err.message}`); });
