-- Preserve observations and briefings; withdraw events outside the polygon-derived
-- regional H3 footprint. This is a coverage correction, not proof a fire ended.
-- Do nothing on an unpopulated twin (e.g. a fresh development database).
INSERT INTO audit_log (id, at, stage, event_id, detail_json)
SELECT 'coverage-fix-0012-' || e.id, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       'engine', e.id,
       json_object('reason', 'outside_territorial_coverage', 'cell', e.h3_cell, 'migration', '0012')
FROM event e
WHERE e.status = 'active'
  AND EXISTS (SELECT 1 FROM digital_twin_cell)
  AND NOT EXISTS (SELECT 1 FROM digital_twin_cell d WHERE d.h3_cell = e.h3_cell);

UPDATE event SET status = 'closed', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE status = 'active'
  AND EXISTS (SELECT 1 FROM digital_twin_cell)
  AND NOT EXISTS (SELECT 1 FROM digital_twin_cell d WHERE d.h3_cell = event.h3_cell);
