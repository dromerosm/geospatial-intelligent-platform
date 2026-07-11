-- Phase 2 (cont.) — Lightning Watch.
-- Cloud-to-ground lightning is a first-class event: each strike opens (or
-- refreshes) a monitoring window on its H3 cell. Later satellite detections are
-- correlated against active watches in Phase 3 (a strike shortly before a
-- hotspot suggests a lightning-caused ignition). One row per watched cell.

CREATE TABLE IF NOT EXISTS lightning_watch (
  h3_cell      TEXT PRIMARY KEY,
  first_seen   TEXT NOT NULL,
  last_strike  TEXT NOT NULL,
  strike_count INTEGER NOT NULL DEFAULT 1,
  expires_at   TEXT NOT NULL          -- last_strike + watch window (24-72 h)
);
CREATE INDEX IF NOT EXISTS idx_lw_expires ON lightning_watch(expires_at);
