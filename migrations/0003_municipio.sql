-- Phase 2.2 — predominant municipality per cell.
-- Derived from the INE 2025 census sections (NMUN/NPRO) already fetched by the
-- Digital Twin build: each section is rasterised to H3 res-9 subcells and every
-- res-7 cell is labelled by the municipality covering most of it. Labelling only
-- (context/UI); it does not feed the deterministic score. Nullable — cells that
-- fall outside every section keep NULL.

ALTER TABLE digital_twin_cell ADD COLUMN municipio TEXT;
