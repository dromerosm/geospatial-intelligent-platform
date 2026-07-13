// GDACS ingestion — Global Disaster Alert and Coordination System (JRC / UN).
//
// GDACS aggregates significant disasters worldwide; the EVENTS4APP endpoint
// returns a GeoJSON FeatureCollection. We pull wildfires (eventtypes=WF) and
// keep the ones for Spain (or overlapping Aragón), normalised to HazardAlert.
// This is the "second opinion": an official wildfire alert overlapping a cell
// corroborates our own detection (raises engine confidence, see engine.ts).
import { ARAGON_BBOX, GDACS_KEEP_ISO3 } from "../config.js";
import type { HazardAlert } from "../types.js";

/** GDACS alertlevel -> normalised [0,1] + CAP-style severity word. */
const GDACS_LEVEL: Record<string, { num: number; sev: string }> = {
  green: { num: 0.3, sev: "minor" },
  orange: { num: 0.6, sev: "severe" },
  red: { num: 0.9, sev: "extreme" },
};

interface GdacsFeature {
  properties: {
    eventid: number;
    episodeid?: number;
    eventtype: string;
    name?: string;
    description?: string;
    alertlevel?: string;
    iscurrent?: string | boolean;
    country?: string;
    iso3?: string;
    fromdate?: string;
    todate?: string;
    url?: { report?: string; details?: string } | string;
    coordinates?: [number, number]; // [lon, lat]
    severitydata?: { severity?: number; severitytext?: string; severityunit?: string };
  };
  geometry?: { type: string; coordinates: [number, number] };
}

const inAragon = (lat: number, lng: number) =>
  lng > ARAGON_BBOX.west && lng < ARAGON_BBOX.east &&
  lat > ARAGON_BBOX.south && lat < ARAGON_BBOX.north;

/** Fetch the raw GDACS wildfire GeoJSON. Caller archives it to R2. */
export async function fetchGdacsWildfires(url: string): Promise<string> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GDACS ${res.status}: ${await res.text()}`);
  return res.text();
}

/**
 * Parse GDACS GeoJSON into HazardAlerts. Keeps wildfire events whose country is
 * in GDACS_KEEP_ISO3 or whose point falls inside Aragón. `ingestedAt` and the
 * raw R2 key come from the caller (mirrors the FIRMS ingest contract).
 */
export function parseGdacs(body: string, ingestedAt: string, rawR2Key: string | null): HazardAlert[] {
  let fc: { features?: GdacsFeature[] };
  try {
    fc = JSON.parse(body);
  } catch {
    return [];
  }
  const out: HazardAlert[] = [];
  for (const f of fc.features ?? []) {
    const p = f.properties;
    if (!p || p.eventtype !== "WF") continue;

    // Coordinates are [lon, lat] on the property or the geometry.
    const coord = p.coordinates ?? f.geometry?.coordinates;
    const lng = coord ? Number(coord[0]) : null;
    const lat = coord ? Number(coord[1]) : null;
    const region = lat != null && lng != null && inAragon(lat, lng);

    const iso3 = (p.iso3 ?? "").toUpperCase();
    if (!(GDACS_KEEP_ISO3 as readonly string[]).includes(iso3) && !region) continue;

    const lvl = GDACS_LEVEL[(p.alertlevel ?? "").toLowerCase()] ?? { num: 0.3, sev: "minor" };
    const url = typeof p.url === "string" ? p.url : p.url?.report ?? p.url?.details ?? null;

    out.push({
      // Event + episode so an escalating event updates in place instead of duplicating.
      id: `GDACS:${p.eventid}:${p.episodeid ?? 0}`,
      source: "GDACS",
      category: "wildfire",
      fireRelevant: 1,
      severity: lvl.sev,
      severityNum: lvl.num,
      levelLabel: p.alertlevel ?? null,
      headline: p.name ?? p.description ?? "Wildfire",
      areaDesc: p.country ?? null,
      inRegion: region ? 1 : 0,
      onset: p.fromdate ? isoUtc(p.fromdate) : null,
      expires: p.todate ? isoUtc(p.todate) : null,
      lat,
      lng,
      url,
      rawR2Key,
      ingestedAt,
      props: {
        eventid: p.eventid,
        iso3,
        alertlevel: p.alertlevel,
        iscurrent: p.iscurrent,
        severity: p.severitydata?.severity ?? null,
        severitytext: p.severitydata?.severitytext ?? null,
        severityunit: p.severitydata?.severityunit ?? null,
      },
    });
  }
  return out;
}

/** GDACS dates come without a zone ("2026-07-13T00:00:00"); treat as UTC. */
function isoUtc(s: string): string {
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
}
