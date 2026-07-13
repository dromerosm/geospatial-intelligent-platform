# AI briefing agent (Phase 4 — "Explain")

The reasoning layer. For every event the deterministic engine creates (confidence ≥
threshold), a **single OpenAI call** turns the evidence into a plain-language Spanish
briefing + structured JSON for operators. Code: [`src/ai/briefing.ts`](../src/ai/briefing.ts),
wired from [`src/engine/engine.ts`](../src/engine/engine.ts).

## Hard boundary

The model **does not detect fires and does not gate events**. The deterministic engine is
the authority: it already created the event from satellite detections + the Digital Twin.
The model only *interprets and communicates* that evidence. The prompt forbids inventing
detections, coordinates, figures or agency alerts, and requires the source-precision
statement to echo the sensor's nominal resolution and geolocation uncertainty (Part VI of
the master document — never imply finer precision than the source).

## Transport & model

- **Direct to OpenAI** (`https://api.openai.com/v1/chat/completions`) — no AI Gateway, no
  extra moving parts or cost. The reasoning layer stays provider-agnostic: swapping
  provider means editing only [`src/config.ts`](../src/config.ts) + `briefing.ts`.
- Model **`gpt-5-mini`**, **Structured Outputs** (`response_format` json_schema, strict).
- **Reasoning is off (`reasoning_effort: "minimal"`) for now.** High reasoning added ~50 s
  of latency per call for little operational gain — the engine already did the analysis, so
  the model only needs to phrase it well. A stronger, explicit prompt (priority rubric +
  per-field guidance) carries the load instead. Bump the effort in `config.ts` later if
  briefings need deeper synthesis. With minimal reasoning a call returns in a few seconds.

## Structured output

One call yields both the structured assessment and the prose:

```json
{
  "priority": "low|medium|high|critical",
  "confidence_assessment": "…",
  "conflicting_evidence": ["…"],
  "recommended_actions": ["…"],
  "source_precision_statement": "sensor, nominal res (m), uncertainty (m), confidence",
  "briefing_text": "3–5 sentence Spanish operational briefing"
}
```

Stored on the `event` row: `briefing_json` = the full object, `briefing_text` = the prose.
Surfaced via `GET /events` and the map's **Eventos + IA** overlay (marker coloured by
priority; popup shows the briefing + precision statement).

## Cost & resilience

- **Called once per event lifetime** — only when the event still has no briefing
  (`briefing_json IS NULL`). Rare in practice (0 events most passes), so token spend is
  bounded. Capped at `MAX_BRIEFINGS_PER_RUN` per engine pass to bound added latency.
- **Best-effort & self-healing.** The event is deterministic and already persisted; a
  failed/timed-out call just leaves the briefing null and is audited (`stage='ai'`). Because
  the engine only briefs events lacking one, the **next pass retries** automatically.
- If `OPENAI_API_KEY` is unset the engine still runs and simply skips briefings.

## Config & secret

`OPENAI_API_KEY` — set locally in `.dev.vars`, in prod via
`wrangler secret put OPENAI_API_KEY`. Model / effort / timeout live in `src/config.ts`.

## Testing

```
# local (wrangler dev)
curl "localhost:8787/dev/observe/test?lat=42.5&lng=0.1&confidence=0.9&count=3"  # inject
curl "localhost:8787/dev/engine/run"                                           # score + brief
curl "localhost:8787/events"                                                   # briefing_json present
```
