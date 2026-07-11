-- Phase 2 (cont.) — Canadian Forest Fire Weather Index (FWI) System.
-- Real fire-danger indices computed daily from the Open-Meteo grid, replacing
-- the RH-based fuel-moisture proxy and adding a drought signal (DC). The moisture
-- codes (FFMC/DMC/DC) accumulate day to day, so these columns carry state.

ALTER TABLE fire_weather ADD COLUMN ffmc REAL;  -- Fine Fuel Moisture Code
ALTER TABLE fire_weather ADD COLUMN dmc  REAL;  -- Duff Moisture Code
ALTER TABLE fire_weather ADD COLUMN dc   REAL;  -- Drought Code (drought indicator)
ALTER TABLE fire_weather ADD COLUMN isi  REAL;  -- Initial Spread Index
ALTER TABLE fire_weather ADD COLUMN bui  REAL;  -- Buildup Index
ALTER TABLE fire_weather ADD COLUMN fwi  REAL;  -- Fire Weather Index
