// Read-only deployment checks. Browser checks are still required for rendered tiles.
import assert from 'node:assert/strict';
const base = new URL(process.argv[2] || 'http://127.0.0.1:8000/mapa/');
async function get(path) {
  const r = await fetch(new URL(path, base), { signal: AbortSignal.timeout(20000), cache: 'no-store' });
  assert.equal(r.status, 200, `${path}: HTTP ${r.status}`);
  return r;
}
const html = await (await get('')).text();
assert.match(html, /vendor\/maplibre-gl-5\.24\.0/);
assert.doesNotMatch(html, /leaflet|cartocdn/i);
const js = await (await get('map.js')).text();
assert.doesNotMatch(js, /\bL\.(map|tileLayer)|cartocdn/);
assert.match(html, /map.js" type="module"/);
const terrain = await (await get('terrain.js')).text();
assert.match(terrain, /encoding: 'terrarium'/);
assert.match(terrain, /maxzoom: 12/);
const style = await (await get('styles/dark.json')).json();
assert.equal(style.version, 8);
assert.equal(style.sources.openmaptiles.url, 'https://tiles.openfreemap.org/planet');
const fc = await (await get('data/aragon-density.geojson')).json();
const metadata = await (await get('data/map-metadata.json')).json();
assert.equal(metadata.cells, fc.metadata.cells);
assert.equal(metadata.populationTotal, fc.metadata.populationTotal);
const bounds = [[Infinity, Infinity], [-Infinity, -Infinity]];
for (const f of fc.features) for (const [x, y] of f.geometry.coordinates[0]) {
  bounds[0][0] = Math.min(bounds[0][0], x); bounds[0][1] = Math.min(bounds[0][1], y);
  bounds[1][0] = Math.max(bounds[1][0], x); bounds[1][1] = Math.max(bounds[1][1], y);
}
assert.deepEqual(metadata.bounds, bounds, 'Startup extent does not match the territorial data');
assert.equal(fc.type, 'FeatureCollection');
assert.equal(fc.features.length, fc.metadata.cells);
assert.equal(new Set(fc.features.map(f => f.properties.h3)).size, fc.features.length);
assert.ok(fc.features.length > 9000, 'Territorial dataset is incomplete');
console.log(`Map assets: OK (${fc.features.length} unique cells)`);
for (const route of ['/fire-weather', '/observations', '/events']) {
  const data = await (await get(route)).json();
  assert.ok(Array.isArray(data), `${route}: expected array`);
  if (route === '/fire-weather') {
    assert.ok(data.length > 0, 'Weather grid is empty');
    const newest = Math.max(...data.map(r => Date.parse(r.updated_at)));
    assert.ok(Date.now() - newest < 7 * 3600000, 'Weather is more than seven hours old');
  }
  console.log(`${route}: OK (${data.length} rows)`);
}
console.log('HTTP/data smoke checks passed. Inspect all backgrounds in a browser; HTTP 200 alone cannot detect image watermarks.');
