-- Phase 2 (cont.) — dynamic fire-weather forecast.
-- Store a compact 3-day hourly Open-Meteo forecast per sample point, alongside
-- the current-conditions columns. The grid is densified to ~225 points (see
-- src/config.ts), all fetched in a single bulk call.

ALTER TABLE fire_weather ADD COLUMN forecast_json TEXT;  -- 3-day hourly forecast (JSON)
