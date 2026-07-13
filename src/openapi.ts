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
export const SWAGGER_UI_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API · Geospatial Intelligence Platform</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>body{margin:0}.topbar{display:none}</style>
</head>
<body>
  <div id="ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui", deepLinking: true });
  </script>
</body>
</html>`;
