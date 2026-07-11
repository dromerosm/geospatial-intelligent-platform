-- Phase 2.3 (cont.) — complete the age breakdown with the working-age band.
-- pop_child (0-14) + pop_adult (15-64) + pop_elderly (65+) = population, so the
-- full age structure is explicit rather than derived. Areally interpolated to H3
-- like the other bands. Nullable.

ALTER TABLE digital_twin_cell ADD COLUMN pop_adult INTEGER;  -- residents aged 15-64
