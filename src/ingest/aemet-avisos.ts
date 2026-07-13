// AEMET avisos (CAP 1.2) ingestion — Spain's official adverse-weather warnings.
//
// AEMET OpenData `avisos_cap/ultimoelaborado/area/62` (62 = Aragón) returns a
// JSON pointer whose `datos` URL is an *uncompressed* POSIX tar containing one
// CAP 1.2 XML per phenomenon+level, each listing the affected Meteoalerta zones.
// We untar in-Worker (no deps) and pull the fields we need with light regex —
// CAP is flat enough that a full XML parser is overkill. These are the official
// fire-driving warnings (heat/wind/thunderstorm) the platform was missing.
import { AEMET_AVISOS_URL, AEMET_FIRE_PHENOMENA, ARAGON_BBOX } from "../config.js";
import type { HazardAlert } from "../types.js";

/** Resolve the `datos` payload URL from AEMET's two-step pointer response. */
export async function fetchAemetAvisosDatosUrl(area: string, key: string): Promise<string> {
  if (!key) throw new Error("AEMET_API_KEY is not set");
  const res = await fetch(AEMET_AVISOS_URL(area, key));
  if (!res.ok) throw new Error(`AEMET avisos pointer ${res.status}: ${await res.text()}`);
  const body = await res.json<{ estado?: number; datos?: string; descripcion?: string }>();
  if (!body.datos) throw new Error(`AEMET avisos: no datos (${body.estado} ${body.descripcion})`);
  return body.datos;
}

/** Fetch the tar payload as bytes. Caller archives it to R2. */
export async function fetchAemetAvisosTar(datosUrl: string): Promise<Uint8Array> {
  const res = await fetch(datosUrl);
  if (!res.ok) throw new Error(`AEMET avisos datos ${res.status}: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

// --- Minimal tar reader -----------------------------------------------------
// USTAR/GNU, uncompressed. Enough for AEMET's archive: 512-byte header blocks,
// octal size at [124,136), typeflag at 156. Handles GNU long names (type 'L').
interface TarEntry {
  name: string;
  data: Uint8Array;
}
export function untar(buf: Uint8Array): TarEntry[] {
  const dec = new TextDecoder();
  const readStr = (off: number, len: number) => dec.decode(buf.subarray(off, off + len)).replace(/\0.*$/, "").trim();
  const out: TarEntry[] = [];
  let pos = 0;
  let longName: string | null = null;
  while (pos + 512 <= buf.length) {
    const name = readStr(pos, 100);
    if (name === "") break; // end-of-archive (zero block)
    const sizeOct = readStr(pos + 124, 12);
    const size = parseInt(sizeOct, 8) || 0;
    const type = String.fromCharCode(buf[pos + 156]);
    const dataStart = pos + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    if (type === "L") {
      // GNU long name: this block's data is the real name of the NEXT entry.
      longName = dec.decode(data).replace(/\0.*$/, "").trim();
    } else if (type === "0" || type === "\0" || type === "") {
      out.push({ name: longName ?? name, data });
      longName = null;
    } else {
      longName = null; // directories, PAX headers, etc. — skip
    }
    pos = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

// --- CAP parsing ------------------------------------------------------------
const firstTag = (xml: string, tag: string): string | null => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1].trim()) : null;
};
const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** value of a CAP <eventCode>/<parameter> selected by its <valueName>. */
function namedValue(xml: string, valueName: string): string | null {
  const re = new RegExp(
    `<valueName>\\s*${valueName}\\s*</valueName>\\s*<value>([\\s\\S]*?)</value>`,
    "i",
  );
  const m = xml.match(re);
  return m ? decodeXml(m[1].trim()) : null;
}

/** AEMET Meteoalerta phenomenon code -> alert category. */
function categoryFor(code: string | null): string {
  switch (code) {
    case "AT": return "heat";
    case "BT": return "cold";
    case "VI": return "wind";
    case "TO": return "thunderstorm";
    case "NE": return "snow";
    case "PR":
    case "PLL": return "rain";
    case "CO": return "coastal";
    default: return "other";
  }
}

/** AEMET level -> normalised severity + [0,1]. Green = "no warning" baseline. */
const LEVEL_NUM: Record<string, number> = { verde: 0.1, amarillo: 0.5, naranja: 0.75, rojo: 1 };
const CAP_SEV: Record<string, string> = { verde: "minor", amarillo: "moderate", naranja: "severe", rojo: "extreme" };

/** Centroid of the first CAP <polygon> ("lat,lon lat,lon …"), or null. */
function polygonCentroid(xml: string): { lat: number; lng: number } | null {
  const m = xml.match(/<polygon>([\s\S]*?)<\/polygon>/);
  if (!m) return null;
  const pts = m[1].trim().split(/\s+/).map((p) => p.split(",").map(Number));
  const valid = pts.filter((c) => c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  if (valid.length === 0) return null;
  const lat = valid.reduce((a, c) => a + c[0], 0) / valid.length;
  const lng = valid.reduce((a, c) => a + c[1], 0) / valid.length;
  return { lat, lng };
}

const toUtc = (s: string | null): string | null => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString();
};

/** Parse one CAP XML document into a HazardAlert (null if not a usable alert). */
export function parseCap(xml: string, ingestedAt: string, rawR2Key: string | null): HazardAlert | null {
  const identifier = firstTag(xml, "identifier");
  if (!identifier) return null;
  const status = firstTag(xml, "status");
  if (status && status.toLowerCase() !== "actual") return null; // ignore Test/Exercise/Draft

  const phen = namedValue(xml, "AEMET-Meteoalerta fenomeno"); // "AT;Temperaturas máximas"
  const code = phen ? phen.split(";")[0].trim().toUpperCase() : null;
  const level = (namedValue(xml, "AEMET-Meteoalerta nivel") ?? "").toLowerCase() || null;

  // All <areaDesc> zones, de-duplicated, joined for a human summary.
  const zones = [...xml.matchAll(/<areaDesc>([\s\S]*?)<\/areaDesc>/g)].map((m) => decodeXml(m[1].trim()));
  const areaDesc = [...new Set(zones)].join(", ") || null;
  const centroid = polygonCentroid(xml);
  const region =
    centroid == null ||
    (centroid.lng > ARAGON_BBOX.west - 0.5 && centroid.lng < ARAGON_BBOX.east + 0.5 &&
     centroid.lat > ARAGON_BBOX.south - 0.5 && centroid.lat < ARAGON_BBOX.north + 0.5);

  return {
    id: `AEMET_CAP:${identifier}`,
    source: "AEMET_CAP",
    category: categoryFor(code),
    fireRelevant: code && (AEMET_FIRE_PHENOMENA as readonly string[]).includes(code) ? 1 : 0,
    severity: level ? CAP_SEV[level] ?? firstTag(xml, "severity")?.toLowerCase() ?? null : null,
    severityNum: level ? LEVEL_NUM[level] ?? null : null,
    levelLabel: level,
    headline: firstTag(xml, "event") ?? firstTag(xml, "headline"),
    areaDesc,
    inRegion: region ? 1 : 0,
    onset: toUtc(firstTag(xml, "onset") ?? firstTag(xml, "effective")),
    expires: toUtc(firstTag(xml, "expires")),
    lat: centroid?.lat ?? null,
    lng: centroid?.lng ?? null,
    url: firstTag(xml, "web"),
    rawR2Key,
    ingestedAt,
    props: { phenomenon: phen, code, zones },
  };
}

/** Untar + parse every CAP file in the payload into HazardAlerts. */
export function parseAemetAvisos(tar: Uint8Array, ingestedAt: string, rawR2Key: string | null): HazardAlert[] {
  const dec = new TextDecoder();
  const out: HazardAlert[] = [];
  for (const entry of untar(tar)) {
    if (!entry.name.toLowerCase().endsWith(".xml")) continue;
    const alert = parseCap(dec.decode(entry.data), ingestedAt, rawR2Key);
    if (alert) out.push(alert);
  }
  return out;
}
