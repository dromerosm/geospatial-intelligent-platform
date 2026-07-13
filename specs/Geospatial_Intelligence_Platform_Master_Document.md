# Geospatial Intelligence Platform — Master Document

> Living document: Product Vision, MVP Technical Specification and Cloudflare Architecture Blueprint.
> Target stack: **Cloudflare (Workers platform)** for everything, **Claude API via Cloudflare AI Gateway** for reasoning.

---

# Part 0 — MVP Scope (read this first)

The goal is a **fast, relevant, shippable MVP**, not the full platform. Everything below is scoped so a small team can deploy an end-to-end wildfire early-warning slice on Cloudflare in weeks, then extend.

### The one MVP user story

> *An emergency operator opens a map for one region. A wildfire hotspot is detected from satellite data, correlated with fire-weather and the local context (fuel, terrain, nearby people/infrastructure), scored deterministically, and — only if it crosses a confidence threshold — turned into a plain-language operational briefing delivered to Telegram and visible on the map, with the source, resolution and uncertainty always stated.*

### In scope for v1

| # | Capability | Concrete v1 decision |
|---|-----------|----------------------|
| 1 | **One hazard** | Wildfire only. |
| 2 | **One bounded region** | **Aragón** (Spain, ~47,700 km²). Bounded autonomous community → small, cheap Digital Twin; strong wildfire relevance. |
| 3 | **Two live feeds** | NASA FIRMS (VIIRS 375 m hotspots, free CSV/JSON API) + Open-Meteo (free, no-key fire-weather). |
| 4 | **Digital Twin, 4 context layers** | Land cover / fuel, elevation→slope, population density, distance-to-critical-asset. Precomputed per H3 cell. |
| 5 | **Deterministic Decision Engine** | Persistence, Triple-30 fire-weather flag, asset-proximity, H3 clustering, confidence threshold, full audit trail. Authoritative for event creation. |
| 6 | **One AI reasoning agent** | Single Claude call → structured JSON briefing + human-readable text. Not five specialists. |
| 7 | **Ops surface** | MapLibre web app (Cloudflare Pages) + REST API (Worker) + Telegram alert + audit log. |

### Explicitly deferred (fast-follow, not v1)

- **Data backlog** (noted for the future): the live **lightning feed** (mechanism is built — see Lightning Watch), extra Digital Twin **context layers** (protected areas, water, power lines, roads via OSM), **Meteosat MTG** and **Copernicus** operational products (harder access/auth), and a real **fuel-load / Scott & Burgan fuel model**.
- Multi-agent AI specialists, Teams/Email channels, multi-region, other hazards (floods/storms/etc.).
- Vectorize/RAG over historical incidents (add when there is history to retrieve).

### Confirmed decisions (v1)

1. **Region:** **Aragón** (Spain). Digital Twin preload sources, all clipped to the Aragón boundary: elevation→slope (Open-Elevation); **population + density from the original INE Censo Anual 2025 by census section** (geometry via INE OGC API, population via per-province jaxiT3 tables, areally interpolated to H3); **CORINE Land Cover 2018 → fuel class** (Copernicus/EEA Identify); **EFFIS burnt-area history**; and OSM infrastructure for distance-to-asset.
2. **LLM provider:** **OpenAI via Cloudflare AI Gateway** — `gpt-5.5-terra` for briefings, `gpt-5-nano` for cheap pre-classification. *(Provider chosen for v1 economics; the reasoning layer is provider-agnostic — AI Gateway lets us swap to Claude when we scale, no app change.)*
3. **Primary alert channel:** **Telegram** (bot + webhook).

---

# Part I — Product Vision

## Mission

Build an **AI-powered Geospatial Intelligence Platform** that transforms authoritative public geospatial data into actionable operational intelligence. First vertical: **wildfire early warning**; the core is designed to extend to floods, storms, landslides, drought, environmental and critical-infrastructure monitoring.

## Positioning

The platform **does not compete** with Copernicus, EFFIS, GWIS or NASA FIRMS. It **enriches, correlates and operationalises** their authoritative datasets.

## Strategic Objectives

- Cloud-native and low-cost (serverless, scale-to-zero).
- Explainable decisions (deterministic scores are the record of truth; AI explains, never decides detection).
- AI-assisted operational support.
- Territory-specific Digital Twins.
- Reusable multi-hazard core.

---

# Part II — MVP Technical Specification

## Layer 1 — Dynamic Data Ingestion

**v1 feeds:** NASA FIRMS VIIRS + Open-Meteo fire-weather.
**Mechanism:** a Cloudflare **Cron-triggered Worker** pulls each feed on a schedule (FIRMS ~10–15 min, weather hourly), normalises every record into the **Observation model** (see Part VI) and pushes it to a **Cloudflare Queue**. Raw payloads are archived to **R2** for replay/audit.

Refresh cadence follows source cadence — never claim fresher data than the source provides.

## Layer 2 — Territorial Digital Twin

An **offline, precomputed** geospatial knowledge base, **indexed by H3 cell** (no live spatial SQL — see the PostGIS note in Part III).

**v1 stores 4 layers per cell** (not the full 18):

- **Static ignition context** — land cover / fuel type, elevation→slope, historical-fire flag (if available).
- **Exposure context** — resident population & density plus at-risk age bands (children 0-14, elderly 65+) from INE Censo Anual 2025 by census section, and distance to nearest critical asset (settlement, road, power line, substation, fire station, water source).
- **Dynamic fire-weather** (updated per ingestion, not static) — temperature, RH, wind speed/direction, rainfall, a drought/fuel-moisture proxy.

The classic **Triple-30** heuristic (T >30 °C, wind >30 km/h, RH <30 %) is one operational indicator, **not** the sole criterion.

> Digital Twin generation is a **build-time batch job**, not runtime. See Part V.

## Layer 3 — Decision Engine

### Deterministic Engine (authoritative)

Pure TypeScript in a Worker (fully unit-testable, no external calls):

- event correlation & clustering (H3 neighbourhood),
- persistence analysis (repeat detections in the same cell across passes),
- contextual enrichment (join detection → Digital Twin cell),
- explainable weighted scoring with named contributions,
- confidence thresholds (below threshold → no event, logged),
- full audit trail written to D1.

**This is the only component that creates events.**

### Frontier AI Reasoning Layer (explains, never detects)

A **single LLM agent** (OpenAI `gpt-5.5-terra`) invoked only for events above threshold. Inputs: the observation(s), Digital Twin context, fire-weather, deterministic score with its named contributions, and operational rules. Outputs: structured JSON (`priority`, `confidence_assessment`, `conflicting_evidence`, `recommended_actions`) **plus** a human-readable briefing. Called through **Cloudflare AI Gateway** for caching, rate-limiting, cost and prompt/response logging. The reasoning layer is provider-agnostic — swappable to Claude at scale without app changes.

## Layer 4 — Operations

- Interactive **MapLibre GL** web app on **Cloudflare Pages** (hotspots as observation footprints, not points).
- Event timeline + audit view.
- **Telegram** alert (v1). Teams/Email deferred.
- REST API (Worker).

## Lightning Watch (mechanism implemented; feed pending)

Cloud-to-ground lightning as a first-class event. Each strike opens (or refreshes) a **configurable 24–72 h monitoring window** on its H3 cell; later detections are correlated against active watches in Phase 3 (a strike shortly before a hotspot suggests a lightning-caused ignition).

**Implemented** as a **D1 `lightning_watch` table** with an `expires_at` window (default 48 h) rather than a Durable Object — the correlation is a cheap indexed query and needs no per-cell coordination, so D1 is simpler for the MVP (a DO would only be warranted if watches needed active alarms/coordination). `ingestLightning()` opens/refreshes/prunes watches; `hasActiveLightningWatch(cell)` is ready for the deterministic engine. `GET /lightning` lists active watches; `/dev/lightning/test` injects a strike.

**Pending — the lightning feed.** No free, clean, Worker-friendly lightning API exists for the region: Blitzortung is free but only via an obfuscated real-time WebSocket (fragile, would need a Durable Object holding the connection); OpenWeather/DTN/Xweather are reliable but paid (API key). The ingestion is feed-agnostic (`ingestLightning(strikes[])`), so wiring a chosen source is small.

## Event Flow

```text
Cron Worker (FIRMS + weather)
        ↓  normalise → Observation
Cloudflare Queue
        ↓
Consumer Worker → Digital Twin lookup (H3) → Deterministic Engine (D1)
        ↓  (only if score ≥ threshold)
Claude Reasoning (via AI Gateway)
        ↓
Event + Briefing persisted (D1) → Telegram + Map + REST API
```

---

# Part III — Cloudflare Architecture Blueprint

## Component → Cloudflare primitive mapping

| Concern | Cloudflare primitive | Notes |
|--------|----------------------|-------|
| Scheduled ingestion | **Workers + Cron Triggers** | one cron per feed; scale-to-zero. |
| Decoupling / backpressure | **Queues** | ingestion → processing; retries + DLQ. |
| Events, audit, watches, Digital Twin index | **D1 (SQLite)** | relational, cheap; schema in Part IV. |
| Raw payloads, rasters, snapshots, briefings | **R2** | zero-egress object store; replay & audit. |
| Config, thresholds, feature flags, hot lookups | **KV** | Triple-30 thresholds, region bbox, tunables. |
| Stateful time windows (Lightning Watch, event coordination) | **Durable Objects + Alarms** | one DO per watch/event; self-expiring. |
| LLM reasoning | **OpenAI API via AI Gateway** | `gpt-5.5-terra` / `gpt-5-nano`; caching, rate-limit, cost + full observability; provider-swappable. |
| Embeddings (fast-follow RAG) | **Workers AI** + **Vectorize** | on-platform, no external key. |
| Web app | **Pages** (MapLibre GL) | static + calls REST Worker. |
| API | **Worker** (Hono router) | REST, auth via API token in KV/Secrets. |
| Observability | **Workers Analytics Engine + Logpush + Workers Observability** | metrics, structured logs. |
| Secrets | **Workers Secrets / Secrets Store** | OpenAI key, feed keys (FIRMS map key), Telegram bot token. |

## The PostGIS constraint (design-shaping)

Cloudflare has **no PostGIS and D1 has no spatial SQL**. Therefore:

- **Spatial joins are done by H3 cell key**, not by geometry queries. Every observation is resolved to its H3 cell(s) on ingest; the Digital Twin is keyed by the same cells; joining is an indexed equality lookup.
- **Geometry math** (footprint polygons, buffers, distance, containment) runs **in the Worker with `h3-js` + `@turf/turf`**, on demand, around active events only.
- Context rasters/vectors stay in **native format in R2**; only the derived per-cell summary lands in D1. This matches the "keep sources in native format" rule and keeps D1 small.

## Architectural Principles

API-first · modular · cloud-native · event-driven · explainable by default · deterministic evidence is authoritative · AI reasons over evidence, never replaces it · **never imply higher precision than the source** (Part VI).

## Future Verticals

Same core; only these change per hazard: **ingestion connectors · Digital Twin enrichments · deterministic rules · the AI reasoning prompt/schema**. Core (Queues, D1, DO, AI Gateway, map, API, audit) stays stable.

---

# Part IV — Data Model (D1)

Minimal, auditable schema. Timestamps UTC ISO-8601.

```sql
-- Normalised detections from any feed
CREATE TABLE observation (
  id              TEXT PRIMARY KEY,        -- ulid
  source          TEXT NOT NULL,           -- 'FIRMS_VIIRS' | 'MTG' | ...
  acquired_at     TEXT NOT NULL,
  ingested_at     TEXT NOT NULL,
  h3_cell         TEXT NOT NULL,           -- res ~7 analytical cell
  footprint_geojson TEXT,                  -- observation footprint polygon
  nominal_resolution_m INTEGER NOT NULL,
  geolocation_uncertainty_m INTEGER,
  confidence      REAL,                    -- source-reported [0,1]
  raw_r2_key      TEXT,                    -- pointer to archived payload
  props_json      TEXT                     -- source-specific (frp, brightness…)
);
CREATE INDEX idx_obs_cell ON observation(h3_cell);
CREATE INDEX idx_obs_time ON observation(acquired_at);

-- Precomputed territorial context, one row per cell
CREATE TABLE digital_twin_cell (
  h3_cell         TEXT PRIMARY KEY,
  land_cover      TEXT,
  fuel_type       TEXT,
  slope_deg       REAL,
  aspect_deg      REAL,
  population        INTEGER,        -- resident population in cell (INE 2025)
  population_density REAL,           -- people/km²
  pop_child         INTEGER,        -- residents aged 0-14
  pop_adult         INTEGER,        -- residents aged 15-64 (working-age)
  pop_elderly       INTEGER,        -- residents aged 65+  (child+adult+elderly = population)
  dist_asset_m    INTEGER,                 -- nearest critical asset
  hist_fire_flag  INTEGER DEFAULT 0
);

-- Latest fire-weather per cell (upserted each ingest)
CREATE TABLE fire_weather (
  h3_cell    TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  temp_c REAL, rh_pct REAL, wind_kmh REAL, wind_dir_deg REAL,
  rain_mm REAL, fuel_moisture_proxy REAL, triple30 INTEGER
);

-- Events created ONLY by the deterministic engine
CREATE TABLE event (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  h3_cell         TEXT NOT NULL,
  status          TEXT NOT NULL,           -- 'candidate'|'active'|'closed'
  det_score       REAL NOT NULL,
  det_confidence  REAL NOT NULL,
  score_breakdown_json TEXT NOT NULL,      -- named contributions (explainable)
  observation_ids TEXT NOT NULL,           -- json array
  briefing_json   TEXT,                    -- AI structured output
  briefing_text   TEXT                     -- AI human-readable
);

-- Immutable audit log for every decision (incl. sub-threshold rejects)
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, at TEXT NOT NULL,
  stage TEXT NOT NULL,                      -- 'ingest'|'score'|'ai'|'notify'
  event_id TEXT, detail_json TEXT NOT NULL
);
```

---

# Part V — Deterministic Engine & AI Agent

## Deterministic scoring (explainable, in-Worker)

Weighted sum of **named contributions**, each written to `score_breakdown_json`:

| Contribution | Signal | Rationale |
|-------------|--------|-----------|
| `persistence` | # passes detecting the same cell/neighbourhood | filters single-pixel noise |
| `source_confidence` | feed-reported confidence | respects the sensor |
| `fire_weather` | Triple-30 + fuel-moisture proxy | conditions favour spread |
| `fuel_terrain` | fuel type × slope from Digital Twin | susceptibility |
| `exposure` | population_density, pop_elderly / pop_child, dist_asset_m | operational priority & vulnerability |

`det_score` = Σ(weight × contribution); weights live in **KV** (tunable without redeploy). If `det_score < threshold` → no event, but write an `audit_log` row (transparency about non-events). Clustering merges detections within an H3 k-ring into one event.

## AI reasoning agent (single LLM call)

- **Trigger:** only for events ≥ threshold.
- **Model:** `gpt-5.5-terra` (briefings), `gpt-5-nano` (cheap pre-classification if needed). Provider-agnostic — AI Gateway allows a later swap to Claude with no app change.
- **Transport:** OpenAI API **through Cloudflare AI Gateway** (cache identical contexts, rate-limit, log every prompt/response for audit and cost).
- **Contract:** Structured Outputs / `response_format` JSON schema (forced):

```json
{
  "priority": "low|medium|high|critical",
  "confidence_assessment": "string",
  "conflicting_evidence": ["..."],
  "recommended_actions": ["..."],
  "source_precision_statement": "MTG/VIIRS, nominal Xm, uncertainty Ym, confidence Z"
}
```

- **Guardrails:** the prompt states explicitly the model **does not detect fires**; it reasons over the deterministic score and evidence. The `source_precision_statement` is mandatory and must echo Part VI. The deterministic score, never the model, gates event creation.

---

# Part VI — Spatial Resolution and Uncertainty Principle

**The platform must never imply a higher spatial precision than the originating source.** Internal indexing (H3) may be finer than observation resolution, but **operational outputs always respect the source's resolution and geolocation uncertainty.**

### Key Rules

- Use the finest available *contextual* datasets (land cover, DEM, infrastructure).
- Never reduce an event's uncertainty below the detecting sensor's.
- Treat detections as **observation footprints**, not exact coordinates.
- Every briefing must state observation source, nominal resolution and confidence.

### Observation model (every ingested record)

`source · acquisition_time · nominal_spatial_resolution · geolocation_uncertainty · confidence · footprint_polygon (where available) · processing_latency`

```json
{
  "source": "MTG",
  "geometry": "pixel_polygon",
  "nominal_resolution_m": 2000,
  "geolocation_uncertainty_m": 500,
  "confidence": 0.72
}
```

### Progressive Refinement

Refine an event as evidence improves — MTG coarse footprint → VIIRS higher-res hotspot → future local sensors/drones/field reports. Reported precision always reflects the **best available** evidence at each stage.

### Internal Resolution Strategy

- National analytical layer: **~500 m cells ≈ H3 res 7–8**.
- High-resolution analysis: **on demand** around active events (in-Worker turf.js).
- Context datasets stay in native raster/vector in R2; only per-cell summaries go to D1.

---

# Part VII — Build Plan (phased)

| Phase | Deliverable | Cloudflare pieces |
|------|-------------|-------------------|
| **0. Bootstrap** ✅ | Repo, `wrangler.jsonc`, D1 schema, KV config, R2 bucket, Pages skeleton | Wrangler, D1, KV, R2, Pages |
| **1. Ingest** ✅ | Cron Worker pulls FIRMS + Open-Meteo (+ FWI, AEMET lightning) → D1/R2 | Cron, D1, R2 |
| **2. Digital Twin** ✅ | Batch job builds `digital_twin_cell` for the region (H3 res 7) | offline script → D1 |
| **3. Decide** ✅ | Worker: cluster → enrich → explainable scoring + confidence gate + audit; weights/threshold in KV | Worker, D1, KV |
| **4. Explain** ⬅ next | LLM briefing via AI Gateway on ≥threshold events | AI Gateway, Secrets |
| **5. Operate** | MapLibre map (footprints) + REST API + Telegram alert | Pages, Worker, DO(optional) |
| **6. Fast-follow** | Lightning Watch (DO), MTG/Copernicus, Vectorize RAG, Teams/Email | DO, Workers AI, Vectorize |

## Cost model (order of magnitude, v1)

Serverless scale-to-zero: Workers + Cron + Queues + D1 + KV + R2 comfortably in low-cost/free tiers for Aragón-scale volume. **The only variable cost is OpenAI tokens**, bounded because the model is called *only* for above-threshold events and AI Gateway caches identical contexts. Budget target: **< a few USD/day** at MVP volume; enforce with an AI Gateway rate limit + a daily token cap.

---

## Open engineering questions

- Exact H3 resolution for the analytical grid (7 vs 8) — trade storage vs granularity over Aragón's ~47,700 km².
- FIRMS access tier (near-real-time vs standard) and its latency budget; obtain a FIRMS MAP_KEY.
- Fuel-moisture proxy formula for v1 (simple RH/rain-based index vs a published FWI component — Aragón sits in the EFFIS domain, so EFFIS/FWI is a natural reference).
- Confirm `gpt-5.5-terra` / `gpt-5-nano` exact model IDs and Structured Outputs support when wiring AI Gateway.
