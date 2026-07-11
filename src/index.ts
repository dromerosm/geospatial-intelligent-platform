// Worker entrypoint.
//
// scheduled(): cron-driven ingestion (Phase 1).
//   */15 * * * *  -> FIRMS hotspots     0 * * * *  -> Open-Meteo fire weather
// fetch(): minimal read-only REST for verification and the map (Phase 5 grows it).
//
// Phase 1 writes straight to D1/R2. The Queue from the blueprint is introduced
// in Phase 3, when processing (scoring + AI) becomes heavy enough to decouple.
import { currentFireWeather, digitalTwinCell, digitalTwinStats, insertObservations, recentObservations, upsertFireWeather, writeAudit } from "./db.js";
import { fetchFirmsCsv, parseFirmsCsv } from "./ingest/firms.js";
import { fetchFireWeather } from "./ingest/weather.js";
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
  const triple30 = rows.filter((r) => r.triple30).length;
  await writeAudit(env, "ingest", { feed: "OPEN_METEO", cells: written, triple30 });
  console.log(`Weather: ${written} cells, ${triple30} in Triple-30`);
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

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = controller.cron === "0 * * * *" ? runWeather(env) : runFirms(env);
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

    switch (pathname) {
      case "/":
        return html(LANDING);
      case "/health":
        return json({ ok: true, service: "geospatial-platform", region: env.REGION });
      case "/observations":
        return json(await recentObservations(env));
      case "/fire-weather":
        return json(await currentFireWeather(env));
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
      default:
        return json({ error: "not found" }, 404);
    }
  },
};
