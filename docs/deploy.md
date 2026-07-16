# Deployment & operations

How to (re)deploy and verify the platform. For architecture, see
[`architecture.md`](architecture.md); for the roadmap, see the [master spec](../specs/Geospatial_Intelligence_Platform_Master_Document.md).

## Live environment

| Item | Value |
|------|-------|
| Worker | `geospatial-platform` |
| Cloudflare account | `DiegoRomero` (`d5656b9379d46301d0d6b85d04a0a773`) |
| Production URL | https://geospatial-platform.diegoromero.es |
| D1 database | `geospatial-db` — `0b3e27e1-d4dc-4e49-ad7b-ffdb293ee5a2` (WEUR) |
| KV namespace | `CONFIG` — `ad963de3572743359d0b39e4a12542bb` |
| R2 bucket | `geospatial-raw` |
| Crons | `*/15 * * * *` (FIRMS), `0 * * * *` (weather) |

Resource ids live in `wrangler.jsonc` (safe to commit — they are not secrets).

## Prerequisites

- `CLOUDFLARE_API_TOKEN` in the environment (already configured on this machine).
  Verify with `npx wrangler whoami`.
- Secret `FIRMS_MAP_KEY` set on the Worker (already done). Local dev reads it from
  `.dev.vars` (git-ignored).
- `npm install` done.

## Routine redeploy

For a normal code change (no new resources):

```bash
npm run typecheck            # must pass
npx wrangler deploy --dry-run   # optional: validate bundle
npm run deploy               # deploy to production
```

`wrangler deploy` uploads a new immutable version and shifts 100% traffic to it. The
custom domain and cron triggers are reconciled automatically.

## Applying a new DB migration

Add a file to `migrations/` (e.g. `0002_*.sql`), then:

```bash
npm run db:apply:local       # test against the local dev DB first
npm run db:apply:remote      # apply to production
```

Migrations are append-only and tracked by wrangler; already-applied files are skipped.

## Rebuilding the Digital Twin (Phase 2)

A one-off batch job — re-run only when the region or its data sources change. Pulls
elevation (Open-Elevation), INE census-section population (2025), CORINE land cover,
EFFIS fire history and OSM assets. The two slow point-query steps are checkpointed and
resumable — elevation to `tmp/elevations.json`, land cover to `tmp/landcover.json` — so
re-runs are fast. First full run ~30–40 min (land cover is ~9.4k point queries).

```bash
npm run twin:build           # -> tmp/digital-twin.sql (~9.4k cells for Aragón)
npm run twin:apply:remote    # apply to production D1 (idempotent, INSERT OR REPLACE)
# npm run twin:apply:local   # same against the local dev DB
```

When the schema changes (e.g. new columns), apply pending migrations first:
`npm run db:apply:remote`.

Verify:

```bash
curl -s https://geospatial-platform.diegoromero.es/digital-twin        # coverage stats
curl -s "https://geospatial-platform.diegoromero.es/digital-twin?cell=<h3>"  # one cell
```

## Updating a secret

```bash
printf '%s' "<value>" | npx wrangler secret put FIRMS_MAP_KEY
# others: AEMET_API_KEY, GROQ_API_KEY / OPENAI_API_KEY,
#         TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DEV_TOKEN
```

## Dev / manual-trigger endpoints (gated)

The `/dev/*` routes manually fire the ingest/engine/notify jobs that normally run on
cron. They **mutate D1 and spend paid quota** (external feeds, the LLM briefing, the
Telegram ops chat), so they are gated by a shared secret and must never be open on the
public deployment:

- **`DEV_TOKEN` unset** → every `/dev/*` route returns `404 {"error":"not found"}`
  (the routes are invisible — the default and safe state in production).
- **`DEV_TOKEN` set** → callers must send a matching `X-Dev-Token` header; any mismatch
  or missing header also gets `404` (never `401`, so the routes stay unadvertised).

The guard lives in `src/index.ts`, ahead of the rate limiter. To enable the endpoints
in production:

```bash
# use a long random value, e.g. `openssl rand -hex 32`
printf '%s' "<random-token>" | npx wrangler secret put DEV_TOKEN
npm run deploy                       # gating changes take effect only on redeploy
```

Then call any dev route with the header:

```bash
BASE=https://geospatial-platform.diegoromero.es
curl -s -H "X-Dev-Token: $DEV_TOKEN" $BASE/dev/ingest/firms      # {"ran":"firms"}
curl -s -H "X-Dev-Token: $DEV_TOKEN" $BASE/dev/engine/run
```

Locally (`wrangler dev`), `DEV_TOKEN` comes from `.dev.vars`; leave it set there so the
smoke test below works against localhost too.

## Post-deploy verification (smoke test)

```bash
BASE=https://geospatial-platform.diegoromero.es

curl -s $BASE/health                 # {"ok":true,...}
# /dev/* are gated (see above): pass the token, or they 404. Skip these two if
# DEV_TOKEN is not set in prod — cron drives ingestion anyway.
curl -s -H "X-Dev-Token: $DEV_TOKEN" $BASE/dev/ingest/weather   # {"ran":"weather"}
curl -s -H "X-Dev-Token: $DEV_TOKEN" $BASE/dev/ingest/firms     # {"ran":"firms"}
curl -s $BASE/fire-weather | head    # 9 cells with data
curl -s $BASE/observations           # hotspots (may be [] if no active fires)
```

Confirm ingestion was recorded in the audit log:

```bash
npx wrangler d1 execute geospatial-db --remote \
  --command "SELECT at, stage, detail_json FROM audit_log ORDER BY at DESC LIMIT 5"
```

> `/observations` returning `[]` is normal — it means FIRMS reported no active
> hotspots in Aragón at that moment, not a failure. The FIRMS `detections` count and
> the archived R2 key are in the audit row either way.

Check an archived raw payload in R2:

```bash
npx wrangler d1 execute geospatial-db --remote \
  --command "SELECT detail_json FROM audit_log WHERE stage='ingest' ORDER BY at DESC LIMIT 1"
# copy the rawKey, then:
npx wrangler r2 object get "geospatial-raw/<rawKey>" --file /tmp/raw.csv --remote
```

## Logs & observability

```bash
npx wrangler tail geospatial-platform          # live logs (incl. cron runs)
npx wrangler tail geospatial-platform --format pretty
```

Structured logs + metrics also appear in the Cloudflare dashboard (observability is
enabled in `wrangler.jsonc`). Cron invocations show under the Worker's *Triggers* /
*Cron Events*.

## Rollback

```bash
npx wrangler versions list geospatial-platform      # find the previous version id
npx wrangler rollback geospatial-platform [<version-id>]
```

Rollback reverts code/config but **not** D1 data or applied migrations — write
backwards-compatible migrations.

## First-time setup on a fresh account (reference)

Only needed if recreating the environment from scratch:

```bash
npx wrangler d1 create geospatial-db          # paste database_id into wrangler.jsonc
npx wrangler kv namespace create CONFIG       # paste id into wrangler.jsonc
npx wrangler r2 bucket create geospatial-raw
npm run db:apply:remote
printf '%s' "<firms-key>" | npx wrangler secret put FIRMS_MAP_KEY
npm run deploy
```

The custom domain requires the `diegoromero.es` zone on the account; the first deploy
provisions the hostname and TLS certificate.

## Verified: Phase 1 (2026-07-11)

Deployed and smoke-tested in production: health OK on the custom domain, weather
ingestion wrote 9 cells with Triple-30 computed, FIRMS ingestion ran cleanly (0
hotspots at the time) and archived the raw CSV to R2, both runs recorded in
`audit_log`, cron triggers registered.
