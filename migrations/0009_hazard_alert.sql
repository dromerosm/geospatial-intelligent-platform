-- Phase 3 (cont.) — Hazard Alerts (external authoritative warnings).
-- Until now the platform only *detected* fire and scored it itself. This table
-- ingests official alerts/warnings issued by other agencies, so the engine can
-- corroborate its own decisions and the map can show the official picture:
--   • GDACS (JRC/UN) — significant wildfire events, alert level Green/Orange/Red.
--   • AEMET avisos (CAP 1.2) — Spain's official adverse-weather warnings for
--     Aragón (area 62): heat, wind, thunderstorm… the fire-driving weather.
-- One row per alert (GDACS event, or one AEMET CAP file per phenomenon+level).
-- Discrete + expiring, unlike the per-cell grids (fire_weather, digital_twin).

CREATE TABLE IF NOT EXISTS hazard_alert (
  id             TEXT PRIMARY KEY,      -- deterministic: source + native id (dedup re-fetches)
  source         TEXT NOT NULL,         -- GDACS | AEMET_CAP
  category       TEXT NOT NULL,         -- wildfire | heat | wind | thunderstorm | cold | rain | snow | coastal | other
  fire_relevant  INTEGER NOT NULL,      -- 1 if it represents/drives fire risk (wildfire, heat, wind, thunderstorm)
  severity       TEXT,                  -- normalised: minor | moderate | severe | extreme
  severity_num   REAL,                  -- [0,1], for ranking + engine priors
  level_label    TEXT,                  -- native label: verde/amarillo/naranja/rojo or Green/Orange/Red
  headline       TEXT,
  area_desc      TEXT,                  -- affected zones (human readable)
  in_region      INTEGER NOT NULL DEFAULT 0, -- 1 if it overlaps the Aragón bbox
  onset          TEXT,                  -- ISO-8601 UTC, start of validity (nullable)
  expires        TEXT,                  -- ISO-8601 UTC, end of validity (nullable)
  lat            REAL,                  -- representative point / centroid (nullable)
  lng            REAL,
  url            TEXT,
  raw_r2_key     TEXT,
  ingested_at    TEXT NOT NULL,
  props_json     TEXT                   -- source-specific extras (native codes, zones, scores)
);

CREATE INDEX IF NOT EXISTS idx_hazard_expires ON hazard_alert(expires);
CREATE INDEX IF NOT EXISTS idx_hazard_source  ON hazard_alert(source);
CREATE INDEX IF NOT EXISTS idx_hazard_fire    ON hazard_alert(fire_relevant, in_region);
