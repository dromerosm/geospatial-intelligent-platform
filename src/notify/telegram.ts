// Telegram operational alerts (Phase 5) — the "Operate" output channel.
//
// Pushes a new above-threshold event's AI briefing to an operations chat via the
// Telegram Bot API. Pure message building + one sendMessage call. The engine gates
// it (priority threshold + dedup) and treats it as best-effort: a failed send just
// leaves event.notified_at NULL and is retried on the next pass. It NEVER creates
// or changes events — it only relays what the deterministic engine already decided.
import { PUBLIC_ORIGIN, TELEGRAM_API, TELEGRAM_TIMEOUT_MS } from "../config.js";

/** The briefing fields an alert needs (subset of the stored briefing_json). */
export interface AlertBriefing {
  priority: string;
  briefing_text: string;
  source_precision_statement: string;
}

/** Same shape as the AI error: carries HTTP status so the engine can back off on 429. */
export type TelegramError = Error & { status?: number; retryAfter?: string | null };

const PRIORITY_EMOJI: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" };

/** Escape the five characters that matter for Telegram's HTML parse mode. */
function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/** Build the HTML message body for one event. */
export function buildMessage(args: {
  cell: string;
  municipio: string | null;
  score: number;
  confidence: number;
  briefing: AlertBriefing;
}): string {
  const { cell, municipio, score, confidence, briefing } = args;
  const emoji = PRIORITY_EMOJI[briefing.priority] ?? "🟠";
  const where = municipio ? esc(municipio) : esc(cell);
  const mapUrl = `${PUBLIC_ORIGIN}/mapa/?event=${encodeURIComponent(cell)}`;
  return (
    `${emoji} <b>${esc(briefing.priority.toUpperCase())}</b> — ${where}\n\n` +
    `${esc(briefing.briefing_text)}\n\n` +
    `<i>Precisión:</i> ${esc(briefing.source_precision_statement)}\n` +
    `Score ${score} · confianza ${confidence}\n` +
    `🗺 <a href="${mapUrl}">Ver en el mapa</a>\n\n` +
    `⚠️ <i>Trabajo de demostración — no es un sistema oficial. Ante una emergencia, llama al 112.</i>`
  );
}

/**
 * Send a message to the chat. Throws a TelegramError (carrying status) on any
 * non-2xx / transport error — the caller treats notification as best-effort.
 */
export async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const res = await fetch(TELEGRAM_API(token, "sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const err = new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 300)}`) as TelegramError;
      err.status = res.status;
      err.retryAfter = res.headers.get("retry-after");
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}
