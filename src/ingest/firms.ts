// NASA FIRMS ingestion: pull VIIRS hotspots for the region, normalise to the
// Observation model. Raw CSV archival is handled by the caller (index.ts).
import {
  ARAGON_BBOX,
  FIRMS_CONFIDENCE,
  FIRMS_DAY_RANGE,
  FIRMS_NOMINAL_RESOLUTION_M,
  FIRMS_SOURCE,
} from "../config.js";
import { cellFor, footprintPolygon } from "../lib/h3.js";
import type { Observation } from "../types.js";

/** Fetch the raw FIRMS CSV for the region (returns the CSV text). */
export async function fetchFirmsCsv(mapKey: string): Promise<string> {
  if (!mapKey) throw new Error("FIRMS_MAP_KEY is not set");
  const { west, south, east, north } = ARAGON_BBOX;
  const bbox = `${west},${south},${east},${north}`;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${FIRMS_SOURCE}/${bbox}/${FIRMS_DAY_RANGE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FIRMS ${res.status}: ${await res.text()}`);
  return res.text();
}

/** Parse FIRMS CSV into normalised Observations. */
export function parseFirmsCsv(csv: string, ingestedAt: string, rawR2Key: string): Observation[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const col = (row: string[], name: string) => row[header.indexOf(name)];

  const out: Observation[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",");
    const lat = Number(col(row, "latitude"));
    const lng = Number(col(row, "longitude"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    // acq_date=YYYY-MM-DD, acq_time=HHMM -> ISO UTC.
    const date = col(row, "acq_date");
    const time = (col(row, "acq_time") ?? "0000").padStart(4, "0");
    const acquiredAt = `${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:00Z`;

    const confLetter = (col(row, "confidence") ?? "n").toLowerCase();
    const confidence = FIRMS_CONFIDENCE[confLetter] ?? null;

    out.push({
      id: crypto.randomUUID(),
      source: "FIRMS_VIIRS",
      acquiredAt,
      ingestedAt,
      h3Cell: cellFor(lat, lng),
      footprintGeojson: footprintPolygon(lat, lng, FIRMS_NOMINAL_RESOLUTION_M),
      nominalResolutionM: FIRMS_NOMINAL_RESOLUTION_M,
      geolocationUncertaintyM: FIRMS_NOMINAL_RESOLUTION_M,
      confidence,
      rawR2Key,
      props: {
        lat,
        lng,
        brightTi4: Number(col(row, "bright_ti4")),
        frp: Number(col(row, "frp")),
        daynight: col(row, "daynight"),
        satellite: col(row, "satellite"),
      },
    });
  }
  return out;
}
