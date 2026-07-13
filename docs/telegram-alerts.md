# Telegram operational alerts (Phase 5 — "Operate")

The output channel. When the deterministic engine creates a **new** event whose AI
briefing priority meets the threshold, the Worker pushes it to an operations chat via
the Telegram Bot API. Code: [`src/notify/telegram.ts`](../src/notify/telegram.ts),
wired from [`src/engine/engine.ts`](../src/engine/engine.ts).

## Hard boundary

Telegram is a **relay, not a decision-maker**. It never creates or changes events; it
only forwards what the deterministic engine already decided, with the AI briefing text.
The alert restates the source-precision statement (Part VI — never imply finer precision
than the source) and carries the "demo, not an official system — call 112" disclaimer.

## What triggers an alert

- Only events **≥ confidence threshold** (created by the engine) whose **briefing priority
  ≥ `min_priority`** (default **`high`**, so only high/critical). Tune live via KV
  `notify_config` `{"min_priority":"medium"}` — no redeploy.
- **Once per event.** Deduped by `event.notified_at` (migration 0010). The priority gate is
  local, so sub-threshold events cost no API call and stay un-notified (a later escalation
  could still alert).

## Message

HTML `sendMessage` with: priority (emoji + label), municipio/cell, the briefing text, the
source-precision statement, score/confidence, a **deep link** `…/mapa/?event=<h3>` that opens
the event's popup on the map, and the 112 disclaimer.

## Resilience & limits

- **Best-effort & self-healing.** The event stands regardless; a failed/timed-out send just
  leaves `notified_at` NULL and is **retried next pass** (audited, `stage='notify'`).
- **Back-off on 429.** `sendTelegram` carries the HTTP status + `Retry-After`; on a rate limit
  the engine stops notifying for the rest of the pass (like the briefing). Capped at
  `MAX_NOTIFICATIONS_PER_RUN`. Telegram's limits (~30 msg/s) are far above our volume.
- If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is unset, the engine runs and skips alerts.

## Config & secrets

- Secrets: **`TELEGRAM_BOT_TOKEN`** (from @BotFather) and **`TELEGRAM_CHAT_ID`** (the target
  chat). Local: `.dev.vars`. Prod: `wrangler secret put`.
- **Getting the chat id:** message the bot (DM) or add it to the ops group and post there,
  then read `https://api.telegram.org/bot<token>/getUpdates` — `result[].message.chat.id`
  (group ids are negative).
- Threshold / caps / origin live in [`src/config.ts`](../src/config.ts).

## Testing

```
# local (wrangler dev), with the two secrets in .dev.vars
curl "localhost:8787/dev/notify/test"                                          # sample alert -> chat
curl "localhost:8787/dev/observe/test?lat=42.5&lng=0.1&confidence=0.9&count=3" # inject
curl "localhost:8787/dev/engine/run"                                           # brief + (high/critical) notify
# open the deep link the alert contains: …/mapa/?event=<h3>
```
