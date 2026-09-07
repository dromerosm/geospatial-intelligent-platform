import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import * as db from '../db.js';
import * as ai from '../ai/briefing.js';
import * as telegram from '../notify/telegram.js';
import { runDecisionEngine } from './engine.js';
vi.mock('../db.js', () => ({
  observationsSince: vi.fn(), activeWildfireAlert: vi.fn(), officialFireWeatherLevel: vi.fn(),
  digitalTwinCell: vi.fn(), fireWeatherCell: vi.fn(), hasActiveLightningWatch: vi.fn(),
  activeEventByCell: vi.fn(), insertEvent: vi.fn(), updateEvent: vi.fn(),
  updateEventBriefing: vi.fn(), markNotified: vi.fn(), writeAudit: vi.fn(), closeStaleEvents: vi.fn(),
}));
vi.mock('../ai/briefing.js', () => ({ aiApiKey: vi.fn(), generateBriefing: vi.fn() }));
vi.mock('../notify/telegram.js', () => ({ buildMessage: vi.fn(), sendTelegram: vi.fn() }));
const env = { CONFIG: { get: vi.fn().mockResolvedValue(null) } } as unknown as Env;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.closeStaleEvents).mockResolvedValue(0);
  vi.mocked(db.digitalTwinCell).mockResolvedValue(null);
  vi.mocked(ai.aiApiKey).mockReturnValue(undefined);
});
describe('regional event gate', () => {
  it('rejects the four production cells outside the twin before scoring or external calls', async () => {
    vi.mocked(db.observationsSince).mockResolvedValue(
      ['8739666d6ffffff', '87397101affffff', '873973319ffffff', '873975918ffffff'].map((h3_cell) => ({
        id: h3_cell, h3_cell, confidence: 1, acquired_at: new Date().toISOString(),
        source: 'FIRMS_SNPP', nominal_resolution_m: 375, geolocation_uncertainty_m: 375,
      })));
    const result = await runDecisionEngine(env);
    expect(result.events).toBe(0);
    expect(db.fireWeatherCell).not.toHaveBeenCalled();
    expect(db.insertEvent).not.toHaveBeenCalled();
    expect(db.updateEvent).not.toHaveBeenCalled();
    expect(ai.generateBriefing).not.toHaveBeenCalled();
    expect(telegram.sendTelegram).not.toHaveBeenCalled();
    expect(db.writeAudit).toHaveBeenCalledWith(env, 'engine', expect.objectContaining({ outsideCoverage: 4 }));
  });
  it('continues normal event processing for a covered cell', async () => {
    const cell = '8739708d2ffffff';
    vi.mocked(db.observationsSince).mockResolvedValue([{
      id: 'inside', h3_cell: cell, confidence: 1, acquired_at: new Date().toISOString(),
      source: 'FIRMS_SNPP', nominal_resolution_m: 375, geolocation_uncertainty_m: 375,
    }]);
    vi.mocked(db.digitalTwinCell).mockResolvedValue({ h3_cell: cell, municipio: 'Zaragoza' });
    vi.mocked(db.activeEventByCell).mockResolvedValue(null);
    vi.mocked(db.hasActiveLightningWatch).mockResolvedValue(true);
    const result = await runDecisionEngine(env);
    expect(db.fireWeatherCell).toHaveBeenCalled();
    expect(result.events).toBe(1);
    expect(db.insertEvent).toHaveBeenCalledWith(env, expect.objectContaining({ cell }));
    expect(db.writeAudit).toHaveBeenCalledWith(env, 'engine', expect.objectContaining({ outsideCoverage: 0 }));
  });
});
