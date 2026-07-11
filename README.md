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
| Explain | Single LLM briefing, above threshold only | **OpenAI via AI Gateway** (Phase 4) |
| Operate | Map + REST + Telegram alerts | **Pages** + Worker (Phase 5) |

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
  lib/h3.ts       H3 cell + footprint helpers
docs/             Architecture notes
```

## What runs today (Phases 1–2)

- Every 15 min: FIRMS VIIRS hotspots for Aragón → normalised → D1 (`observation`), raw CSV → R2.
- Hourly: Open-Meteo fire weather sampled over a grid → D1 (`fire_weather`), Triple-30 flagged.
- **Digital Twin**: ~9.4k H3 res-7 cells for Aragón with terrain (slope/aspect) and
  infrastructure (distance-to-asset, nearby population). Built offline via
  `npm run twin:build` (see [`docs/deploy.md`](docs/deploy.md)).
- Read API: `GET /health`, `/observations`, `/fire-weather`, `/digital-twin[?cell=<h3>]`.
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
Phases 1–2 are **live** at https://geospatial-platform.diegoromero.es.

## Roadmap

Phases 0–2 (bootstrap + ingest + Digital Twin) are implemented. Next: **Phase 3**
deterministic engine, **Phase 4** LLM briefing via AI Gateway, **Phase 5** map +
Telegram. See the [master document](specs/Geospatial_Intelligence_Platform_Master_Document.md#part-vii--build-plan-phased).
