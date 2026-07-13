-- Phase 6: event lifecycle. An active event is closed once its cell has had no
-- detection within the staleness window (the fire is no longer observed). Keeps
-- the operational /events view to what is currently burning; closed rows stay for
-- audit/history. closed_at records when the transition happened.
ALTER TABLE event ADD COLUMN closed_at TEXT;
