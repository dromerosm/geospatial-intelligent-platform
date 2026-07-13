// AI briefing agent (Phase 4) — the "Explain" layer.
//
// A SINGLE OpenAI call turns one above-threshold event into a structured JSON
// assessment + a plain-language Spanish briefing for operators. It is called
// directly (no AI Gateway) from the decision engine, once per event.
//
// Hard boundary: the model DOES NOT detect fires and DOES NOT gate events. The
// deterministic engine already created the event; the model only reasons over
// its evidence and named score contributions. All facts come from our data —
// the prompt tells the model to never invent detections, coordinates or agency
// alerts. If the call fails or the key is unset, the event still stands with a
// null briefing (best-effort layer).
import { OPENAI_MODEL, OPENAI_REASONING_EFFORT, OPENAI_TIMEOUT_MS, OPENAI_URL } from "../config.js";

/** One observation's precision facts (never claim finer than the source). */
export interface BriefingObservation {
  source: string;
  nominalResolutionM: number | null;
  uncertaintyM: number | null;
  confidence: number | null;
  acquiredAt: string;
}

/** Everything the agent reasons over — assembled by the engine per event. */
export interface BriefingInput {
  cell: string;
  municipio: string | null;
  score: number;
  confidence: number;
  threshold: number;
  contributions: Record<string, number>; // named, normalised [0,1]
  weighted: Record<string, number>; // contribution × weight
  context: {
    detectionConfidence: number | null;
    persistenceCount: number;
    lightningActive: boolean;
    fwi: number | null;
    triple30: 0 | 1 | null;
    fuelType: string | null;
    slopeDeg: number | null;
    populationDensity: number | null;
    popElderly: number | null;
    distAssetM: number | null;
    officialWildfireAlert: boolean;
    officialFireWeatherLevel: number | null;
  };
  observations: BriefingObservation[];
}

export interface BriefingResult {
  json: {
    priority: "low" | "medium" | "high" | "critical";
    confidence_assessment: string;
    conflicting_evidence: string[];
    recommended_actions: string[];
    source_precision_statement: string;
    briefing_text: string;
  };
  usage: unknown;
  model: string;
}

// Forced Structured Output. strict:true requires every property listed in
// `required` and additionalProperties:false. Enums keep `priority` machine-usable.
const RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "wildfire_briefing",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
        confidence_assessment: { type: "string", description: "How solid is the evidence that this is a real, active fire — in Spanish." },
        conflicting_evidence: { type: "array", items: { type: "string" }, description: "Signals that argue against a real fire or add uncertainty. Empty if none. Spanish." },
        recommended_actions: { type: "array", items: { type: "string" }, description: "Concrete operational next steps, most important first. Spanish." },
        source_precision_statement: { type: "string", description: "Must echo detecting source(s), nominal resolution (m), geolocation uncertainty (m) and confidence. Never imply finer precision than the source." },
        briefing_text: { type: "string", description: "3-6 sentence plain-language operational briefing in Spanish." },
      },
      required: ["priority", "confidence_assessment", "conflicting_evidence", "recommended_actions", "source_precision_statement", "briefing_text"],
    },
  },
} as const;

const SYSTEM_PROMPT = `Eres el analista de guardia de una plataforma de alerta temprana de incendios forestales en Aragón (España). Redactas informes operativos breves y accionables para bomberos y protección civil.

REGLAS INQUEBRANTABLES
1. NO DETECTAS INCENDIOS. Un motor determinista ya creó este evento a partir de datos de satélite y del gemelo digital del territorio. Tu única función es interpretar y comunicar esa evidencia, nunca generar detecciones, coordenadas ni alertas nuevas.
2. Usa EXCLUSIVAMENTE los datos de la entrada. No inventes cifras, localidades, focos ni avisos de agencias. Si un dato falta ("n/d"), decláralo como desconocido; no lo estimes.
3. El motor determinista es la autoridad. Si la evidencia es débil o contradictoria, dilo con claridad y modera la urgencia. No exageres.
4. Precisión de la fuente: la salida nunca puede implicar mayor precisión espacial que la del sensor. El enunciado de precisión debe citar sensor(es), resolución nominal (m), incertidumbre de geolocalización (m) y confianza tal como llegan en la entrada.
5. Escribe en español, tono profesional, conciso y sin adornos.

CÓMO ASIGNAR "priority" (elige el nivel más alto que se cumpla):
- critical: confianza alta (≳0.8) Y (exposición alta —población densa, mayores, o activo crítico cercano— O meteo de incendio extrema —FWI alto o Regla 30-30-30— O corroboración oficial GDACS activa).
- high: confianza sólida (≳0.65) con condiciones favorables al fuego o exposición relevante, aún sin corroboración oficial.
- medium: evidencia moderada, mixta o sin contexto agravante; requiere verificación antes de movilizar.
- low: evidencia débil o probable falso positivo (una sola pasada, baja confianza, combustible escaso, meteo desfavorable al fuego).

CONTENIDO DE CADA CAMPO
- confidence_assessment: 1-2 frases sobre cuán sólida es la evidencia de un fuego real y activo, apoyándote en persistencia (nº pasadas), confianza del sensor y corroboración.
- conflicting_evidence: lista de señales concretas que restan certeza (p. ej. "una sola pasada satelital", "FWI bajo", "combustible escaso", "sin corroboración oficial"). Vacía si no hay ninguna.
- recommended_actions: pasos operativos concretos y realistas, ordenados de mayor a menor prioridad (p. ej. verificación en campo, cruce con cámaras/próximas pasadas, preavisar al parque de bomberos más cercano). Prioriza siempre la seguridad del personal.
- source_precision_statement: una frase que resuma fuente(s), resolución nominal, incertidumbre y confianza.
- briefing_text: 3-5 frases que respondan QUÉ se ha observado, POR QUÉ importa (contexto territorial y meteorológico) y QUÉ hacer ahora. Coherente con "priority".`;

/** Compact, human-readable evidence block the model reasons over. */
function buildUserPrompt(i: BriefingInput): string {
  const c = i.context;
  const pct = (v: number | null | undefined) => (v == null ? "n/d" : `${Math.round(v * 100)}%`);
  const num = (v: number | null | undefined, suffix = "") => (v == null ? "n/d" : `${v}${suffix}`);
  const obs = i.observations.length
    ? i.observations
        .map((o) => `  - ${o.source}: resolución nominal ${num(o.nominalResolutionM, " m")}, incertidumbre ${num(o.uncertaintyM, " m")}, confianza ${pct(o.confidence)}, adquirido ${o.acquiredAt}`)
        .join("\n")
    : "  - (sin observaciones individuales disponibles)";

  return (
    `EVENTO ${i.cell}${i.municipio ? ` — ${i.municipio}` : ""}\n` +
    `Puntuación determinista: score=${i.score} · confianza=${i.confidence} (umbral=${i.threshold}).\n\n` +
    `Contribuciones nombradas (normalizadas 0–1 / ponderadas):\n` +
    Object.keys(i.contributions)
      .map((k) => `  - ${k}: ${i.contributions[k]} (aporta ${i.weighted[k] ?? 0})`)
      .join("\n") +
    `\n\nContexto del gemelo digital y meteo:\n` +
    `  - Persistencia (nº pasadas satélite): ${c.persistenceCount}\n` +
    `  - Confianza de detección (máx): ${pct(c.detectionConfidence)}\n` +
    `  - FWI (índice meteorológico de incendio): ${num(c.fwi)}${c.triple30 ? " · Regla 30-30-30 activa" : ""}\n` +
    `  - Combustible: ${c.fuelType ?? "n/d"} · pendiente: ${num(c.slopeDeg, "°")}\n` +
    `  - Densidad de población: ${num(c.populationDensity, " hab/km²")} · mayores de 65: ${num(c.popElderly)} · distancia a activo crítico: ${num(c.distAssetM, " m")}\n` +
    `  - Vigilancia por rayos activa: ${c.lightningActive ? "sí" : "no"}\n` +
    `  - Corroboración oficial: alerta GDACS de incendio ${c.officialWildfireAlert ? "activa" : "no"}` +
    `${c.officialFireWeatherLevel != null ? ` · nivel aviso AEMET ${pct(c.officialFireWeatherLevel)}` : ""}\n\n` +
    `Observaciones (fuente · precisión):\n${obs}\n\n` +
    `Redacta el informe estructurado.`
  );
}

/**
 * Call OpenAI directly and return the parsed structured briefing. Throws on any
 * transport/parse error — the caller treats briefing generation as best-effort.
 */
export async function generateBriefing(apiKey: string, input: BriefingInput): Promise<BriefingResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OPENAI_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        reasoning_effort: OPENAI_REASONING_EFFORT,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(input) },
        ],
        response_format: RESPONSE_SCHEMA,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json<any>();
    const content = body?.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");
    return { json: JSON.parse(content), usage: body.usage ?? null, model: body.model ?? OPENAI_MODEL };
  } finally {
    clearTimeout(timer);
  }
}
