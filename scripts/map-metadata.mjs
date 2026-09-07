// Small startup manifest; derived from the same versioned cells as the renderer.
import { readFile, writeFile } from 'node:fs/promises';
const fc = JSON.parse(await readFile('prototype/data/aragon-density.geojson', 'utf8'));
const bounds = [[Infinity, Infinity], [-Infinity, -Infinity]];
for (const f of fc.features) for (const [x, y] of f.geometry.coordinates[0]) {
  bounds[0][0] = Math.min(bounds[0][0], x); bounds[0][1] = Math.min(bounds[0][1], y);
  bounds[1][0] = Math.max(bounds[1][0], x); bounds[1][1] = Math.max(bounds[1][1], y);
}
await writeFile('prototype/data/map-metadata.json', JSON.stringify({ ...fc.metadata, bounds }) + '\n');
