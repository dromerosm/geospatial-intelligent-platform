// Worker entrypoint.
//
// scheduled(): cron-driven ingestion (Phase 1).
//   */15 * * * *  -> FIRMS hotspots     0 * * * *  -> Open-Meteo fire weather
// fetch(): minimal read-only REST for verification and the map (Phase 5 grows it).
//
// Phase 1 writes straight to D1/R2. The Queue from the blueprint is introduced
// in Phase 3, when processing (scoring + AI) becomes heavy enough to decouple.
import { currentFireWeather, digitalTwinCell, digitalTwinStats, fireWeatherCell, fireWeatherForFwi, insertObservations, pruneFireWeather, recentObservations, updateFwi, upsertFireWeather, writeAudit } from "./db.js";
import { fetchFirmsCsv, parseFirmsCsv } from "./ingest/firms.js";
import { fetchFireWeather } from "./ingest/weather.js";
import { computeFwi, FWI_START } from "./lib/fwi.js";
import type { Env } from "./types.js";
import LANDING from "./landing.html";

async function runFirms(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const csv = await fetchFirmsCsv(env.FIRMS_MAP_KEY);
  const rawKey = `firms/${now}.csv`;
  await env.RAW.put(rawKey, csv); // archive raw payload for replay/audit
  const obs = parseFirmsCsv(csv, now, rawKey);
  const written = await insertObservations(env, obs);
  await writeAudit(env, "ingest", { feed: "FIRMS_VIIRS", detections: obs.length, written, rawKey });
  console.log(`FIRMS: ${obs.length} detections, ${written} stored`);
}

async function runWeather(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const rows = await fetchFireWeather(now);
  const written = await upsertFireWeather(env, rows);
  await pruneFireWeather(env, now); // drop points from any previous grid
  const triple30 = rows.filter((r) => r.triple30).length;
  await writeAudit(env, "ingest", { feed: "OPEN_METEO", cells: written, triple30 });
  console.log(`Weather: ${written} cells, ${triple30} in Triple-30`);
}

// Advance the FWI System one day per grid point, from today's noon forecast and
// yesterday's accumulated moisture codes (startup defaults on the first run).
async function runFwi(env: Env): Promise<void> {
  const rows = await fireWeatherForFwi(env);
  const month = new Date().getUTCMonth() + 1;
  const NOON = 12; // forecast_json starts at today 00:00 (hourly)
  const updates = [];
  for (const r of rows) {
    if (!r.forecast_json) continue;
    const f = JSON.parse(r.forecast_json);
    const temp = f.temp_c?.[NOON];
    const rh = f.rh_pct?.[NOON];
    const wind = f.wind_kmh?.[NOON];
    if (temp == null || rh == null || wind == null) continue;
    const rain = (f.rain_mm ?? []).slice(0, 24).reduce((a: number, b: number) => a + (b || 0), 0);
    const out = computeFwi({
      temp, rh, wind, rain, month,
      ffmc0: r.ffmc ?? FWI_START.ffmc, dmc0: r.dmc ?? FWI_START.dmc, dc0: r.dc ?? FWI_START.dc,
    });
    updates.push({ cell: r.h3_cell, ...out });
  }
  const n = await updateFwi(env, updates);
  await writeAudit(env, "fwi", { cells: n, month });
  console.log(`FWI: ${n} cells advanced`);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    // Dynamic API: never let the edge cache these responses.
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600, s-maxage=3600",
    },
  });
}

function text(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}

const ROBOTS_TXT = `User-agent: *
Allow: /
`;

// llms.txt — machine-readable site summary for AI agents (llmstxt.org).
const LLMS_TXT = `# Geospatial Intelligence Platform

> Wildfire early-warning platform for Aragón (Spain), built entirely on Cloudflare. It enriches authoritative public data with an H3 territorial digital twin and an explainable, deterministic decision engine.

## API (read-only, JSON)
- [Health](https://geospatial-platform.diegoromero.es/health): service status
- [Digital Twin](https://geospatial-platform.diegoromero.es/digital-twin): territorial digital-twin summary (append ?cell=<h3> for one cell)
- [Observations](https://geospatial-platform.diegoromero.es/observations): latest satellite detections
- [Fire weather](https://geospatial-platform.diegoromero.es/fire-weather): per-cell fire weather

## Pages
- [Landing](https://geospatial-platform.diegoromero.es/): project status, data sources and architecture
- [Map](https://geospatial-platform.diegoromero.es/mapa): interactive digital-twin map

## Data sources
NASA FIRMS (hotspots), Open-Meteo (fire weather), INE Censo Anual 2025 (population by census section), CORINE Land Cover (fuel), EFFIS (fire history), OpenStreetMap and Open-Elevation.
`;

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job =
      controller.cron === "0 12 * * *" ? runFwi(env)
      : controller.cron === "0 */3 * * *" ? runWeather(env)
      : runFirms(env);
    ctx.waitUntil(job.catch((err) => console.error("scheduled error:", err)));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    // The interactive map is a separate Cloudflare Pages project. This hostname
    // belongs to the Worker, so serve the map at /mapa by reverse-proxying to
    // Pages (strip the /mapa prefix; relative asset URLs resolve under /mapa/).
    if (pathname === "/mapa") {
      return Response.redirect(`${url.origin}/mapa/`, 308); // so relative assets resolve
    }
    if (pathname.startsWith("/mapa/")) {
      const target = `https://geospatial-platform-map.pages.dev${pathname.slice("/mapa".length)}${url.search}`;
      return fetch(new Request(target, req));
    }

    // Hard rate limit (per client IP) on the API + dev endpoints while testing.
    // Static pages (/, robots, llms, /mapa) are intentionally not limited.
    if (
      pathname === "/health" || pathname === "/observations" ||
      pathname === "/fire-weather" || pathname === "/digital-twin" ||
      pathname.startsWith("/dev/")
    ) {
      const ip = req.headers.get("CF-Connecting-IP") ?? "anon";
      const { success } = await env.API_RL.limit({ key: ip });
      if (!success) {
        return new Response(JSON.stringify({ error: "rate limit exceeded — slow down" }), {
          status: 429,
          headers: { "content-type": "application/json; charset=utf-8", "retry-after": "60", "cache-control": "no-store" },
        });
      }
    }

    switch (pathname) {
      case "/":
        return html(LANDING);
      case "/robots.txt":
        return text(ROBOTS_TXT);
      case "/llms.txt":
        return text(LLMS_TXT);
      case "/health":
        return json({ ok: true, service: "geospatial-platform", region: env.REGION });
      case "/observations":
        return json(await recentObservations(env));
      case "/fire-weather": {
        // ?cell=<h3> returns one sample's full row incl. 3-day forecast.
        const cell = url.searchParams.get("cell");
        return json(cell ? await fireWeatherCell(env, cell) : await currentFireWeather(env));
      }
      case "/digital-twin": {
        // ?cell=<h3> returns one cell's context; otherwise coverage stats.
        const cell = url.searchParams.get("cell");
        return json(cell ? await digitalTwinCell(env, cell) : await digitalTwinStats(env));
      }
      // Manual trigger for local testing (cron can't be invoked from the browser).
      case "/dev/ingest/firms":
        await runFirms(env);
        return json({ ran: "firms" });
      case "/dev/ingest/weather":
        await runWeather(env);
        return json({ ran: "weather" });
      case "/dev/compute/fwi":
        await runFwi(env);
        return json({ ran: "fwi" });
      default:
        return json({ error: "not found" }, 404);
    }
  },
};
