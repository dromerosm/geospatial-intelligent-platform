// Read-only deployment checks. Browser checks are still required for rendered tiles.
import assert from 'node:assert/strict';
const base = new URL(process.argv[2] || 'http://127.0.0.1:8000/mapa/');
async function get(path) {
  const r = await fetch(new URL(path, base), { signal: AbortSignal.timeout(20000), cache: 'no-store' });
  assert.equal(r.status, 200, `${path}: HTTP ${r.status}`);
  return r;
}
const html = await (await get('')).text();
assert.match(html, /maplibre-gl@5\.24\.0/);
assert.doesNotMatch(html, /leaflet|cartocdn/i);
const js = await (await get('map.js')).text();
assert.doesNotMatch(js, /\bL\.(map|tileLayer)|cartocdn/);
const style = await (await get('styles/dark.json')).json();
assert.equal(style.version, 8);
assert.equal(style.sources.openmaptiles.url, 'https://tiles.openfreemap.org/planet');
const fc = await (await get('data/aragon-density.geojson')).json();
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
