import { describe, it, expect } from 'vitest';
import { latLngToCell, cellToLatLng } from 'h3-js';
import { buildMessage } from './telegram.js';
const cell = latLngToCell(41.65, -0.88, 7);
const args = { cell, municipio: 'Zaragoza', score: 0.7, confidence: 0.8,
  briefing: { priority: 'high', briefing_text: 'Check <fire>', source_precision_statement: '375 m' } };
describe('Telegram location', () => {
  it('includes municipality, approximate cell centre and the event link', () => {
    const text = buildMessage(args);
    const [lat, lng] = cellToLatLng(cell);
    expect(text).toContain('Zaragoza · Aragón');
    expect(text).toContain(`Centro aproximado de la celda: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    expect(text).toContain(`/mapa/?event=${cell}`);
    expect(text).toContain('Check &lt;fire&gt;');
  });
  it('retains coordinates when municipality is absent instead of showing only H3', () => {
    const text = buildMessage({ ...args, municipio: '  ' });
    expect(text).toContain('municipio no disponible');
    expect(text).toContain('Centro aproximado');
  });
  it('escapes municipality HTML', () => {
    expect(buildMessage({ ...args, municipio: 'A < B & C' })).toContain('A &lt; B &amp; C');
  });
});
