-- Phase 2.1 — replace the OSM population proxy with authoritative INE data.
-- population_nearby (OSM settlements within 10 km) -> population (resident
-- population within the cell, INE Censo Anual 2025 by census section, areally
-- interpolated to H3) plus population_density (people/km²).

ALTER TABLE digital_twin_cell RENAME COLUMN population_nearby TO population;
ALTER TABLE digital_twin_cell ADD COLUMN population_density REAL;
