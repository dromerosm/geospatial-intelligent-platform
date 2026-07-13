# Geospatial Intelligence Platform

AI-powered geospatial intelligence for **wildfire early warning**, built entirely on
**Cloudflare**. It enriches authoritative public data (NASA FIRMS, weather) with a
territorial *Digital Twin*, scores events with an **explainable deterministic engine**,
and — only above a confidence threshold — generates an operational briefing with an LLM.

> **MVP scope:** one hazard (wildfire), one region (**Aragón, Spain**), two live feeds
> (NASA FIRMS VIIRS + Open-Meteo). Full vision and design: [`specs/`](specs/Geospatial_Intelligence_Platform_Master_Document.md).

Production domain: **https://geospatial-platform.diegoromero.es**

## Architecture (one line per layer)

| Layer | What | Cloudflare primitive |
|------|------|----------------------|
| Ingest | Pull FIRMS + weather on a schedule, normalise to the Observation model | **Cron Workers**, **R2** (raw archive) |
| Store | Observations, fire weather, events, audit | **D1** (SQLite) |
| Twin | Precomputed per-cell context, keyed by **H3** | D1 (Phase 2) |
| Decide | Explainable deterministic scoring — authoritative for events | Worker (Phase 3) |
| Explain | Single LLM briefing, above threshold only | **Groq `gpt-oss-120b`, direct** (Phase 4) |
| Operate | Map + REST + **Telegram alerts** (high/critical) | **Pages** + Worker + Bot API (Phase 5) |

No PostGIS: spatial joins are by **H3 cell key**; geometry math runs in the Worker
(`h3-js`). See [`docs/architecture.md`](docs/architecture.md).

## Repository layout

```
specs/            Living master document (vision + spec + blueprint)
migrations/       D1 schema (wrangler d1 migrations)
src/
  index.ts        Worker entry: scheduled() ingestion + fetch() REST
  config.ts       Region bbox, H3 resolution, feed constants (edit to re-point)
  types.ts        Env bindings + Observation / FireWeather models
  db.ts           Small D1 access layer
  ingest/firms.ts NASA FIRMS pull + CSV -> Observation
  ingest/weather.ts Open-Meteo fire weather -> per-cell rows
  ingest/gdacs.ts GDACS wildfire alerts (GeoJSON) -> HazardAlert
  ingest/aemet-avisos.ts AEMET avisos CAP (tar of XML) -> HazardAlert
  lib/h3.ts       H3 cell + footprint helpers
docs/             Architecture notes
```

## What runs today (Phases 1–5)

- Every 15 min: FIRMS VIIRS hotspots for Aragón → normalised → D1 (`observation`), raw CSV → R2.
- Every 3 h: Open-Meteo fire weather sampled over a grid → D1 (`fire_weather`), Triple-30 flagged.
- 00/06/12/18Z: AEMET lightning strikes → `lightning_watch` monitoring windows.
- **Official authoritative alerts** → D1 (`hazard_alert`), pruned on expiry:
  - Hourly: **GDACS** wildfire alerts (JRC/UN) for Spain + Aragón — the engine corroborates its events against them.
  - Every 6 h: **AEMET avisos** (CAP 1.2, area 62 = Aragón) — official heat/wind/thunderstorm warnings that raise the engine's fire-weather floor.
- **Digital Twin**: ~9.4k H3 res-7 cells for Aragón — terrain (slope/aspect), **INE Censo
  Anual 2025 population + density + full age breakdown (children 0-14, adults 15-64, elderly
  65+), by census section**, **CORINE land cover → fuel class**, **EFFIS fire history**, and distance-to-asset.
  Built offline via `npm run twin:build` (see [`docs/deploy.md`](docs/deploy.md)).
- **Deterministic engine** (every FIRMS pass): clusters detections by H3 cell, enriches with
  the Twin + nearest fire weather + lightning + official corroboration, scores explainably,
  and creates an event only above the confidence threshold (weights/threshold tunable in KV).
- **AI briefing** (Phase 4): for each above-threshold event, one direct LLM call (Groq
  `gpt-oss-120b`, ~1.5 s; provider-swappable) produces a Spanish operational briefing +
  structured JSON (priority, conflicting evidence, actions, source-precision statement).
  Explains, never detects — see [`docs/ai-briefing.md`](docs/ai-briefing.md).
- **Telegram alerts** (Phase 5): each new high/critical event is pushed to an operations
  chat with its briefing + a deep link to the map (`/mapa/?event=<h3>`), once per event
  (deduped, best-effort). See [`docs/telegram-alerts.md`](docs/telegram-alerts.md).
- Read API: `GET /health`, `/observations`, `/fire-weather`, `/digital-twin[?cell=<h3>]`, `/lightning`, `/alerts`, `/events` (with the AI briefing).
- Every ingestion writes an `audit_log` row.

## One-time setup

Prerequisites: Node 20+, a Cloudflare account (`npx wrangler login`), a free
[FIRMS map key](https://firms.modaps.eosdis.nasa.gov/api/map_key/).

```bash
npm install

# Create the Cloudflare resources, then paste the returned ids into wrangler.jsonc
npx wrangler d1 create geospatial-db          # -> database_id
npx wrangler kv namespace create CONFIG       # -> id
npx wrangler r2 bucket create geospatial-raw

# Apply the schema
npm run db:apply:remote      # add --local for the local dev DB

# Secrets
cp .dev.vars.example .dev.vars    # put your FIRMS_MAP_KEY here for local dev
npx wrangler secret put FIRMS_MAP_KEY   # for production
npx wrangler secret put AEMET_API_KEY   # lightning + avisos feeds
npx wrangler secret put GROQ_API_KEY    # Phase 4 AI briefing (active provider; optional)
# npx wrangler secret put OPENAI_API_KEY # only if AI_PROVIDER="openai" in src/config.ts
npx wrangler secret put TELEGRAM_BOT_TOKEN # Phase 5 alerts (optional)
npx wrangler secret put TELEGRAM_CHAT_ID   # Phase 5 alerts target chat
```

## Develop & deploy

```bash
npm run dev            # local Worker; visit /health
# trigger ingestion locally (cron isn't hit in the browser):
#   /dev/ingest/firms   /dev/ingest/weather

npm run typecheck
npm run deploy         # deploy Worker; provisions the custom domain on first run
```

The custom domain requires the `diegoromero.es` zone on the same Cloudflare account.

Full deploy, verification and rollback procedures: [`docs/deploy.md`](docs/deploy.md).
Phases 1–5 are **live** at https://geospatial-platform.diegoromero.es.

## Roadmap

Phases 0–5 (bootstrap + ingest + Digital Twin + deterministic engine + AI briefing +
Telegram alerts) are implemented. Next (Phase 6 fast-follow): event lifecycle/closing,
Durable Objects, MTG/Copernicus, Vectorize RAG. See the
[master document](specs/Geospatial_Intelligence_Platform_Master_Document.md#part-vii--build-plan-phased).
