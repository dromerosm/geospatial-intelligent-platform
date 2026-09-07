import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrain } from '../prototype/terrain.js';
function fixture() {
  const sources = new Map(), layers = new Map(), handlers = {};
  let pitch = 0, terrain, update;
  const gesture = { enable() {}, disable() {}, enableRotation() {}, disableRotation() {} };
  const map = {
    on: (event, fn) => { handlers[event] = fn; },
    stop() {}, setTerrain: (value) => { terrain = value; },
    jumpTo: (v) => { pitch = v.pitch; }, easeTo: (v) => { pitch = v.pitch; },
    getPitch: () => pitch, setMaxPitch() {}, dragRotate: gesture, touchZoomRotate: gesture, touchPitch: gesture,
    addSource: (id, value) => sources.set(id, value), getSource: (id) => sources.get(id), removeSource: (id) => sources.delete(id),
    addLayer: (value) => layers.set(value.id, value), getLayer: (id) => layers.get(id), removeLayer: (id) => layers.delete(id),
  };
  const control = createTerrain(map, (v) => { update = v; });
  return { control, sources, layers, handlers, map, get update() { return update; }, get terrain() { return terrain; } };
}
test('initial 2D and dark base never load elevation', () => {
  const f = fixture(); f.control.setBase('oscuro'); f.control.enable();
  assert.equal(f.sources.size, 0); assert.equal(f.update.available, false);
});
test('3D uses real heights; Geo Colour removes only hillshade; cancel ignores late data', () => {
  const f = fixture(); f.control.setBase('satelite'); f.control.enable();
  assert.equal(f.terrain.exaggeration, 1); assert.equal(f.sources.size, 2);
  f.handlers.sourcedata({ sourceId: 'terrain-dem', sourceDataType: 'metadata' });
  assert.equal(f.update.state, 'loading');
  f.handlers.sourcedata({ sourceId: 'terrain-dem', sourceDataType: 'content', tile: { state: 'loaded' } });
  assert.equal(f.update.state, 'active');
  f.control.setBase('geocolour'); assert.equal(f.sources.size, 1);
  f.control.setBase('falso'); assert.equal(f.layers.size, 1);
  f.control.reset(); assert.equal(f.sources.size, 0); assert.equal(f.terrain, null);
  f.handlers.sourcedata({ sourceId: 'terrain-dem', sourceDataType: 'content', tile: { state: 'loaded' } });
  assert.equal(f.update.state, 'flat');
});
test('provider error restores 2D, leaves other errors alone, and allows retry', () => {
  const f = fixture(); f.control.setBase('satelite'); f.control.enable();
  assert.equal(f.control.handleError({ sourceId: 'cells' }), false);
  assert.equal(f.control.handleError({ sourceId: 'terrain-dem' }), true);
  assert.equal(f.sources.size, 0); assert.equal(f.map.getPitch(), 0);
  assert.match(f.update.message, /reintentar/);
  f.control.enable(); assert.equal(f.update.state, 'loading'); f.control.setBase('oscuro');
  assert.equal(f.sources.size, 0);
});
test('keyboard or touch pitch activates terrain without changing gesture pitch', () => {
  const f = fixture(); f.control.setBase('falso'); f.map.jumpTo({ pitch: 20 }); f.handlers.pitch();
  assert.equal(f.map.getPitch(), 20); assert.equal(f.update.state, 'loading'); f.control.reset();
});
test('a stalled DEM request times out to usable 2D', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.control.setBase('satelite'); f.control.enable();
  t.mock.timers.tick(15000);
  assert.equal(f.sources.size, 0); assert.equal(f.terrain, null);
  assert.equal(f.update.state, 'flat'); assert.match(f.update.message, /no disponible/);
});
