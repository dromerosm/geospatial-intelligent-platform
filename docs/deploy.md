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

## Updating a secret

```bash
printf '%s' "<value>" | npx wrangler secret put FIRMS_MAP_KEY
# future phases: OPENAI_API_KEY, TELEGRAM_BOT_TOKEN
```

## Post-deploy verification (smoke test)

```bash
BASE=https://geospatial-platform.diegoromero.es

curl -s $BASE/health                 # {"ok":true,...}
curl -s $BASE/dev/ingest/weather     # {"ran":"weather"}
curl -s $BASE/dev/ingest/firms       # {"ran":"firms"}
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
