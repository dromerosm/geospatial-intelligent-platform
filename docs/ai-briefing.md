# AI briefing agent (Phase 4 — "Explain")

The reasoning layer. For every event the deterministic engine creates (confidence ≥
threshold), a **single LLM call** turns the evidence into a plain-language Spanish
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

- **Direct call, no AI Gateway** — no extra moving parts or cost. Both providers below
  expose an OpenAI-compatible endpoint + strict Structured Outputs, so the layer is
  provider-swappable via the single `AI_PROVIDER` flag in
  [`src/config.ts`](../src/config.ts); the rest of `briefing.ts` is unchanged.
- **Active provider: Groq `gpt-oss-120b`** (`https://api.groq.com/openai/v1/...`),
  `reasoning_effort: "low"`. Fallback: OpenAI `gpt-5-mini` (`reasoning_effort: "minimal"`).
  Structured Outputs (`response_format` json_schema, strict) on both.
- **Why Groq (validated 2026-07-13).** Head-to-head on the same prompt + schema: Groq
  `gpt-oss-120b` median **~1.5 s** vs OpenAI `gpt-5-mini` **~7 s** (and far tighter latency
  variance), at equal or better structured quality — Groq reliably populates
  `conflicting_evidence`, which gpt-5-mini often left empty. Only Groq's `gpt-oss-*` models
  support strict `json_schema` (llama-3.3 / qwen3 return 400).
- **Reasoning stays low/minimal on purpose.** The engine already did the analysis, so the
  model only needs to phrase it well; an explicit prompt (priority rubric + per-field
  guidance) carries the load. Bump the effort in `config.ts` if briefings need deeper synthesis.

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
- **Rate limits (Groq gpt-oss-120b free tier): 1,000 requests/day (RPD) and 8,000
  tokens/minute (TPM).** A briefing is ~2,000 tokens, so `MAX_BRIEFINGS_PER_RUN = 3` (~6k)
  stays under TPM within a pass, and passes are ≥15 min apart — normal operation never
  approaches either limit (above-threshold events are rare). If a 429 does occur (e.g. a
  burst), the engine **stops briefing for the rest of that pass** and retries the remainder
  next pass, so it never hammers the API while limited; the 429 + any `Retry-After` are audited.
- If the active provider's key is unset the engine still runs and simply skips briefings.

## Config & secret

Secret is the active provider's key — **`GROQ_API_KEY`** by default (OpenAI path uses
`OPENAI_API_KEY`). Set locally in `.dev.vars`, in prod via `wrangler secret put GROQ_API_KEY`.
Provider / model / effort / timeout live in `src/config.ts` (`AI_PROVIDER`).

## Testing

```
# local (wrangler dev)
curl "localhost:8787/dev/observe/test?lat=42.5&lng=0.1&confidence=0.9&count=3"  # inject
curl "localhost:8787/dev/engine/run"                                           # score + brief
curl "localhost:8787/events"                                                   # briefing_json present
```
