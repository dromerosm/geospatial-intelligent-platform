-- Phase 5: dedup for Telegram operational alerts. One notification per event;
-- notified_at is set once the alert is delivered. Best-effort + self-healing:
-- if delivery fails, this stays NULL and the next engine pass retries.
ALTER TABLE event ADD COLUMN notified_at TEXT;
