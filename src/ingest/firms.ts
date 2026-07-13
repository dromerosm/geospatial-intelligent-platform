// NASA FIRMS ingestion: pull active-fire hotspots for the region from a given
// near-real-time source, normalised to the Observation model. Raw CSV archival
// is handled by the caller (index.ts).
import { ARAGON_BBOX, FIRMS_CONFIDENCE, FIRMS_DAY_RANGE } from "../config.js";
import { cellFor, footprintPolygon } from "../lib/h3.js";
import type { Observation } from "../types.js";

export interface FirmsSource {
  id: string; // FIRMS source id, e.g. VIIRS_NOAA20_NRT
  sat: string; // short satellite label
  resM: number; // nominal pixel resolution (m)
}

/** Fetch the raw FIRMS CSV for one source over the region. */
export async function fetchFirmsCsv(mapKey: string, sourceId: string): Promise<string> {
  if (!mapKey) throw new Error("FIRMS_MAP_KEY is not set");
  const { west, south, east, north } = ARAGON_BBOX;
  const bbox = `${west},${south},${east},${north}`;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${sourceId}/${bbox}/${FIRMS_DAY_RANGE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FIRMS ${sourceId} ${res.status}: ${await res.text()}`);
  return res.text();
}

/** VIIRS confidence is a letter (l/n/h); MODIS is a 0-100 number. */
function parseConfidence(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const num = Number(raw);
  if (Number.isFinite(num)) return Math.min(1, Math.max(0, num / 100));
  return FIRMS_CONFIDENCE[raw.toLowerCase()] ?? null;
}

/** Parse a FIRMS CSV into normalised Observations for the given source. */
export function parseFirmsCsv(
  csv: string,
  source: FirmsSource,
  ingestedAt: string,
  rawR2Key: string,
): Observation[] {
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

    out.push({
      // Deterministic id (satellite + time + location) so re-fetches of the same
      // detection dedup via INSERT OR IGNORE instead of inflating persistence.
      id: `${source.sat}:${acquiredAt}:${lat.toFixed(5)},${lng.toFixed(5)}`,
      source: `FIRMS_${source.sat}`,
      acquiredAt,
      ingestedAt,
      h3Cell: cellFor(lat, lng),
      footprintGeojson: footprintPolygon(lat, lng, source.resM),
      nominalResolutionM: source.resM,
      geolocationUncertaintyM: source.resM,
      confidence: parseConfidence(col(row, "confidence")),
      rawR2Key,
      props: {
        lat,
        lng,
        frp: Number(col(row, "frp")),
        daynight: col(row, "daynight"),
        satellite: col(row, "satellite") ?? source.sat,
        source: source.id,
      },
    });
  }
  return out;
}
