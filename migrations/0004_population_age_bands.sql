-- Phase 2.3 — population at risk by age band.
-- Wildfire evacuation risk skews to dependent ages; disaggregate the INE 2025
-- census-section population (both sexes) into the two dependency bands, areally
-- interpolated to H3 like `population`. Adults (15-64) = population - the two.
-- Nullable; cells outside every section keep NULL.

ALTER TABLE digital_twin_cell ADD COLUMN pop_child INTEGER;    -- residents aged 0-14
ALTER TABLE digital_twin_cell ADD COLUMN pop_elderly INTEGER;  -- residents aged 65+
