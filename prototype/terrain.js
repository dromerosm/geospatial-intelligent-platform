// Elevation stays optional: no DEM source exists until the user tilts the map.
export function createTerrain(map, notify) {
  let base = 'oscuro', state = 'flat', timer;
  const source = {
    type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 12,
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    attribution: 'Terrain © <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Mapzen and data providers</a> · Copernicus EU-DEM · USGS · NOAA',
  };
  const publish = (message) => notify({ state, available: base !== 'oscuro', message });
  function reset(message = '') {
    state = 'flat'; clearTimeout(timer);
    map.stop();
    map.setTerrain(null);
    map.jumpTo({ pitch: 0, bearing: 0 });
    if (map.getLayer('terrain-shade')) map.removeLayer('terrain-shade');
    for (const id of ['terrain-dem', 'shade-dem']) if (map.getSource(id)) map.removeSource(id);
    publish(message);
  }
  function shade() {
    if (base === 'geocolour') {
      if (map.getLayer('terrain-shade')) map.removeLayer('terrain-shade');
      if (map.getSource('shade-dem')) map.removeSource('shade-dem');
    } else if (!map.getLayer('terrain-shade')) {
      // MapLibre recommends separate source instances for terrain and hillshade.
      map.addSource('shade-dem', { ...source });
      map.addLayer({ id: 'terrain-shade', type: 'hillshade', source: 'shade-dem', paint: {
        'hillshade-exaggeration': 0.2, 'hillshade-illumination-anchor': 'map',
      } }, 'cells');
    }
  }
  function enable(tilt = true) {
    if (base === 'oscuro' || state !== 'flat') return;
    state = 'loading'; publish('Cargando relieve…');
    timer = setTimeout(() => reset('Relieve no disponible. Se mantiene el mapa 2D; puedes reintentar.'), 15000);
    try {
      map.addSource('terrain-dem', { ...source });
      map.setTerrain({ source: 'terrain-dem', exaggeration: 1 });
      shade();
      if (tilt) map.easeTo({ pitch: 50, duration: 600 });
    } catch { reset('No se pudo activar el relieve. Puedes reintentar.'); }
  }
  map.on('sourcedata', (e) => {
    if (state === 'loading' && e.sourceId === 'terrain-dem' && e.tile?.state === 'loaded') {
      clearTimeout(timer); state = 'active'; publish('Relieve 3D · alturas reales · detalle limitado por la imagen satélite');
    }
  });
  map.on('pitch', () => { if (map.getPitch() > 1 && state === 'flat') enable(false); });
  return {
    enable, reset,
    setBase(key) {
      base = key;
      if (key === 'oscuro') reset();
      map.setMaxPitch(key === 'oscuro' ? 0 : 60);
      if (key === 'oscuro') {
        map.dragRotate.disable(); map.touchZoomRotate.disableRotation(); map.touchPitch.disable();
      } else {
        map.dragRotate.enable(); map.touchZoomRotate.enableRotation(); map.touchPitch.enable();
        if (state !== 'flat') shade();
      }
      publish();
    },
    handleError(e) {
      const id = e.sourceId;
      const elevation = ['terrain-dem', 'shade-dem'].includes(id) || String(e.error?.url || e.error?.message || '').includes('elevation-tiles-prod');
      if (!elevation) return false;
      if (state !== 'flat') reset('Relieve no disponible. Se mantiene el mapa 2D; puedes reintentar.');
      return true;
    },
  };
}
