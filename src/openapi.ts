// OpenAPI 3.1 description of the read-only REST API, served at /openapi.json and
// rendered by Swagger UI at /docs. Hand-written (the API is small and stable) and
// kept in sync with src/index.ts. Servers use "/" so "Try it out" hits this host.
export function openApiSpec(): unknown {
  const jsonArray = (ref: string) => ({
    description: "OK",
    content: { "application/json": { schema: { type: "array", items: { $ref: `#/components/schemas/${ref}` } } } },
  });
  const jsonObj = (ref: string) => ({
    description: "OK",
    content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } },
  });
  const cellParam = {
    name: "cell", in: "query", required: false,
    description: "H3 res-7 cell index; returns just that cell instead of the summary/list.",
    schema: { type: "string", example: "8739738d3ffffff" },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Geospatial Intelligence Platform API",
      version: "1.0.0",
      description:
        "Read-only JSON API of the wildfire early-warning platform for Aragón (Spain). " +
        "Enriches authoritative public data (NASA FIRMS, Open-Meteo, GDACS, AEMET, INE, CORINE, EFFIS) " +
        "with an H3 territorial digital twin and an explainable deterministic decision engine; " +
        "above-threshold events carry an AI operational briefing. Not an official emergency system.",
      contact: { url: "https://geospatial-platform.diegoromero.es" },
    },
    servers: [{ url: "/", description: "This host" }],
    paths: {
      "/health": { get: { tags: ["status"], summary: "Service status", responses: { "200": jsonObj("Health") } } },
      "/observations": {
        get: { tags: ["data"], summary: "Latest satellite detections (FIRMS hotspots)", responses: { "200": jsonArray("Observation") } },
      },
      "/fire-weather": {
        get: {
          tags: ["data"], summary: "Per-cell fire weather (current + FWI + 3-day forecast)",
          parameters: [cellParam],
          responses: { "200": { description: "Array of cells, or one cell's full row when ?cell is set." } },
        },
      },
      "/digital-twin": {
        get: {
          tags: ["data"], summary: "Territorial digital-twin summary, or one cell's context",
          parameters: [cellParam],
          responses: { "200": { description: "Coverage stats, or one cell's context when ?cell is set." } },
        },
      },
      "/lightning": { get: { tags: ["data"], summary: "Active lightning watches", responses: { "200": jsonArray("LightningWatch") } } },
      "/alerts": {
        get: { tags: ["data"], summary: "Active external authoritative alerts (GDACS wildfire + AEMET avisos)", responses: { "200": jsonArray("HazardAlert") } },
      },
      "/events": {
        get: {
          tags: ["events"], summary: "Fire events with explainable score + AI briefing",
          parameters: [{
            name: "status", in: "query", required: false,
            description: "Lifecycle filter.", schema: { type: "string", enum: ["active", "closed", "all"], default: "active" },
          }],
          responses: { "200": jsonArray("Event") },
        },
      },
    },
    components: {
      schemas: {
        Health: {
          type: "object",
          properties: { ok: { type: "boolean" }, service: { type: "string" }, region: { type: "string", example: "aragon" } },
        },
        Observation: {
          type: "object", additionalProperties: true,
          description: "A normalised detection footprint — never claims more precision than the source.",
          properties: {
            id: { type: "string" }, source: { type: "string", example: "FIRMS_VIIRS_NOAA20" },
            acquired_at: { type: "string", format: "date-time" }, h3_cell: { type: "string" },
            confidence: { type: "number", nullable: true, example: 0.9 },
            nominal_resolution_m: { type: "integer", example: 375 },
            footprint_geojson: { type: "string", nullable: true, description: "GeoJSON Polygon string." },
          },
        },
        LightningWatch: {
          type: "object", additionalProperties: true,
          properties: {
            h3_cell: { type: "string" }, first_seen: { type: "string", format: "date-time" },
            last_strike: { type: "string", format: "date-time" }, strike_count: { type: "integer" },
            expires_at: { type: "string", format: "date-time" },
          },
        },
        HazardAlert: {
          type: "object", additionalProperties: true,
          properties: {
            source: { type: "string", enum: ["GDACS", "AEMET_CAP"] }, category: { type: "string", example: "wildfire" },
            fire_relevant: { type: "integer", enum: [0, 1] }, level_label: { type: "string", nullable: true },
            headline: { type: "string", nullable: true }, area_desc: { type: "string", nullable: true },
            in_region: { type: "integer", enum: [0, 1] }, expires: { type: "string", format: "date-time", nullable: true },
          },
        },
        Event: {
          type: "object", additionalProperties: true,
          description: "Created only by the deterministic engine. briefing_* present once the AI briefing is generated.",
          properties: {
            id: { type: "string" }, created_at: { type: "string", format: "date-time" },
            closed_at: { type: "string", format: "date-time", nullable: true },
            h3_cell: { type: "string" }, status: { type: "string", enum: ["candidate", "active", "closed"] },
            det_score: { type: "number", example: 0.66 }, det_confidence: { type: "number", example: 0.7 },
            score_breakdown_json: { type: "string", description: "Named contributions (explainable), JSON string." },
            observation_ids: { type: "string", description: "JSON array of observation ids." },
            briefing_json: { type: "string", nullable: true, description: "AI structured output (priority, actions, source-precision…), JSON string." },
            briefing_text: { type: "string", nullable: true, description: "Human-readable Spanish briefing." },
          },
        },
      },
    },
  };
}

// Swagger UI page (CDN assets, like the map's Leaflet). Points at /openapi.json;
// same-origin server means "Try it out" works directly.
const docsInfo = (openApiSpec() as { info: { title: string; description: string } }).info;
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Swagger UI's own info block is hidden and replaced by a static header, so the
// heading order is h1 > h2 > Swagger's h3 tags. The CSS overrides darken the
// method badges and links to reach WCAG AA contrast and give path links a 24 px
// tap target. The server picker is hidden: there is one server.
export const SWAGGER_UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <!-- Google Analytics 4 (shared diegoromero.es property): prototype/analytics.js. -->
  <script src="/mapa/analytics.js"></script>
  <title>API · Geospatial Intelligence Platform</title>
  <meta name="description" content="Interactive documentation of the read-only JSON API of the wildfire early-warning platform for Aragón: observations, fire weather, digital twin, lightning, alerts and events." />
  <link rel="canonical" href="https://geospatial-platform.diegoromero.es/docs" />
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1b1f24}
    .topbar,.swagger-ui .information-container,.swagger-ui .scheme-container{display:none}
    .docs-header{max-width:1460px;margin:0 auto;padding:24px 20px 0;box-sizing:border-box}
    .docs-header h1{margin:0 0 8px;font-size:28px}
    .docs-header p{margin:0 0 8px;max-width:72ch;line-height:1.5}
    .docs-header a{color:#1f5fae}
    .docs-header h2{margin:20px 0 0;font-size:20px}
    .swagger-ui a,.swagger-ui .info a{color:#1f5fae}
    .swagger-ui .opblock.opblock-get .opblock-summary-method{background:#1f5fae}
    .swagger-ui .opblock.opblock-post .opblock-summary-method{background:#1e7b4f}
    .swagger-ui .opblock.opblock-put .opblock-summary-method{background:#a35a00}
    .swagger-ui .opblock.opblock-delete .opblock-summary-method{background:#b3261e}
    .swagger-ui .opblock.opblock-patch .opblock-summary-method{background:#1c7c74}
    .swagger-ui .opblock-summary-path a.nostyle{display:inline-block;min-height:24px;line-height:24px}
  </style>
</head>
<body>
  <header class="docs-header">
    <h1>${escapeHtml(docsInfo.title)}</h1>
    <p>${escapeHtml(docsInfo.description)}</p>
    <p><a href="/">Project home</a> · <a href="/openapi.json">OpenAPI 3.1 spec</a> · <a href="https://diegoromero.es/en/cookies/" data-cookie-settings>Cookie settings</a></p>
    <h2>Endpoints</h2>
  </header>
  <div id="ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui", deepLinking: true });
  </script>
</body>
</html>`;
