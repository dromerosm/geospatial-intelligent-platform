-- Geospatial Intelligence Platform — initial schema.
-- SQLite (Cloudflare D1). No spatial extension: spatial joins are done by H3
-- cell key, geometry math runs in the Worker (h3-js / turf.js). See specs.
-- Timestamps are UTC ISO-8601 strings.

-- Normalised detections from any feed (Phase 1 writes here).
CREATE TABLE IF NOT EXISTS observation (
  id                        TEXT PRIMARY KEY,
  source                    TEXT NOT NULL,          -- 'FIRMS_VIIRS' | 'MTG' | ...
  acquired_at               TEXT NOT NULL,
  ingested_at               TEXT NOT NULL,
  h3_cell                   TEXT NOT NULL,          -- analytical cell (res 7)
  footprint_geojson         TEXT,                   -- observation footprint polygon
  nominal_resolution_m      INTEGER NOT NULL,
  geolocation_uncertainty_m INTEGER,
  confidence                REAL,                   -- source-reported [0,1]
  raw_r2_key                TEXT,                   -- pointer to archived payload
  props_json                TEXT                    -- source-specific (frp, brightness...)
);
CREATE INDEX IF NOT EXISTS idx_obs_cell ON observation(h3_cell);
CREATE INDEX IF NOT EXISTS idx_obs_time ON observation(acquired_at);

-- Precomputed territorial context, one row per cell (Phase 2 batch job).
CREATE TABLE IF NOT EXISTS digital_twin_cell (
  h3_cell           TEXT PRIMARY KEY,
  land_cover        TEXT,
  fuel_type         TEXT,
  slope_deg         REAL,
  aspect_deg        REAL,
  population_nearby INTEGER,
  dist_asset_m      INTEGER,
  hist_fire_flag    INTEGER DEFAULT 0
);

-- Latest fire weather per cell (Phase 1 upserts here, hourly).
CREATE TABLE IF NOT EXISTS fire_weather (
  h3_cell             TEXT PRIMARY KEY,
  updated_at          TEXT NOT NULL,
  temp_c              REAL,
  rh_pct              REAL,
  wind_kmh            REAL,
  wind_dir_deg        REAL,
  rain_mm             REAL,
  fuel_moisture_proxy REAL,
  triple30            INTEGER
);

-- Events — created ONLY by the deterministic engine (Phase 3).
CREATE TABLE IF NOT EXISTS event (
  id                   TEXT PRIMARY KEY,
  created_at           TEXT NOT NULL,
  h3_cell              TEXT NOT NULL,
  status               TEXT NOT NULL,               -- 'candidate'|'active'|'closed'
  det_score            REAL NOT NULL,
  det_confidence       REAL NOT NULL,
  score_breakdown_json TEXT NOT NULL,               -- named contributions
  observation_ids      TEXT NOT NULL,               -- json array
  briefing_json        TEXT,                        -- AI structured output (Phase 4)
  briefing_text        TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_cell ON event(h3_cell);

-- Immutable audit log for every decision (incl. sub-threshold rejects).
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  stage       TEXT NOT NULL,                        -- 'ingest'|'score'|'ai'|'notify'
  event_id    TEXT,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
