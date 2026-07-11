// AEMET lightning ("rayos") ingestion.
//
// AEMET OpenData exposes cloud-to-ground strikes only as a pre-rendered McIDAS
// GIF (the /red/rayos/mapa product) — there is no vector feed. We recover
// approximate strike locations by decoding the GIF and reading the coloured
// cross markers, then mapping pixel -> lon/lat with a calibrated affine.
//
// Precision ~5-15 km. This is image scraping: if AEMET changes the frame or
// palette it breaks, so callers should sanity-check the frame (see assertFrame).
import { GifReader } from "omggif";

// --- Georeference (calibrated) ---------------------------------------------
// Equirectangular McIDAS frame, ~1/30 deg/px. Control-point residual <=6 km
// (Balearic centroids + Cabo da Roca + Cantabrian coast). Frame interior:
//   lon -13.02..+7.05 E, lat 34.13..44.92 N  (x 19..619, y 19..422).
const px2lon = (x: number) => 0.033449 * x - 13.6531;
const px2lat = (y: number) => -0.026762 * y + 45.4284;

// Map drawing area, excluding the header (title) and the bottom legend rows.
const MAP = { x0: 20, x1: 619, y0: 28, y1: 418 } as const;

// Lightning marker colours in the AEMET palette. Each colour is a 2-hour time
// bin within the plotted period; we treat them all as strikes. Pure indexed
// colours (no anti-aliasing), so exact RGB matching is safe.
const STRIKE_COLOURS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 255, 255], // cyan
  [255, 255, 0], // yellow
  [0, 255, 0],   // green
  [0, 0, 255],   // blue
  [255, 0, 0],   // red
  [255, 255, 255], // white
];
const isStrike = (r: number, g: number, b: number) =>
  STRIKE_COLOURS.some((c) => c[0] === r && c[1] === g && c[2] === b);

export interface Strike {
  lat: number;
  lng: number;
  at: string; // ISO UTC
}

/** Decode the single GIF frame to RGBA. Separated so callers can time it. */
export function decodeRayosGif(gif: ArrayBuffer | Uint8Array): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  const bytes = gif instanceof Uint8Array ? gif : new Uint8Array(gif);
  const reader = new GifReader(bytes);
  const width = reader.width;
  const height = reader.height;
  const rgba = new Uint8Array(width * height * 4);
  reader.decodeAndBlitFrameRGBA(0, rgba);
  return { width, height, rgba };
}

/**
 * Cheap integrity check: the magenta plot frame must sit where we calibrated.
 * If AEMET restyles the map this fails fast instead of emitting garbage coords.
 */
export function assertFrame(rgba: Uint8Array, W: number, H: number): void {
  const magentaAt = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return rgba[i] === 255 && rgba[i + 1] === 0 && rgba[i + 2] === 255;
  };
  let hits = 0;
  for (let x = 100; x < 500; x += 20) {
    if (magentaAt(x, 19)) hits++; // top neatline
    if (magentaAt(x, 422)) hits++; // bottom neatline
  }
  if (W !== 640 || H !== 480 || hits < 30) {
    throw new Error(`AEMET rayos frame check failed (W=${W} H=${H} hits=${hits})`);
  }
}

/**
 * Detect coloured markers and cluster them into strike locations.
 * Greedy single-pass merge (markers are a few hundred sparse px).
 */
export function extractStrikes(rgba: Uint8Array, W: number, H: number, at: string): Strike[] {
  const foci: { sx: number; sy: number; n: number }[] = [];
  for (let y = MAP.y0; y < MAP.y1; y++) {
    const row = y * W;
    for (let x = MAP.x0; x < MAP.x1; x++) {
      const i = (row + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      if (r + g + b < 200) continue; // background
      if (r === 255 && g === 0 && b === 255) continue; // magenta borders
      if (!isStrike(r, g, b)) continue;
      let merged = false;
      for (const f of foci) {
        if (Math.abs(f.sx / f.n - x) < 5 && Math.abs(f.sy / f.n - y) < 5) {
          f.sx += x; f.sy += y; f.n++; merged = true; break;
        }
      }
      if (!merged) foci.push({ sx: x, sy: y, n: 1 });
    }
  }
  return foci.map((f) => ({
    lng: +px2lon(f.sx / f.n).toFixed(3),
    lat: +px2lat(f.sy / f.n).toFixed(3),
    at,
  }));
}

/**
 * Two-step AEMET OpenData fetch: metadata endpoint -> `datos` URL -> GIF bytes.
 * The two-step redirect fails transiently now and then; retry the whole
 * sequence with a short backoff so a blip doesn't drop a scheduled window.
 * The missing-key guard is outside the loop — a permanent error fails fast.
 */
export async function fetchAemetRayosGif(apiKey: string, retries = 2): Promise<ArrayBuffer> {
  if (!apiKey) throw new Error("AEMET_API_KEY is not set");
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1))); // 300ms, 600ms
    try {
      const meta = await fetch(
        `https://opendata.aemet.es/opendata/api/red/rayos/mapa?api_key=${apiKey}`,
      ).then((r) => r.json<{ estado: number; descripcion: string; datos: string }>());
      if (meta.estado !== 200 || !meta.datos) {
        throw new Error(`AEMET rayos meta: estado ${meta.estado} (${meta.descripcion})`);
      }
      const res = await fetch(meta.datos);
      if (!res.ok) throw new Error(`AEMET rayos datos ${res.status}`);
      return await res.arrayBuffer();
    } catch (err) {
      lastErr = err;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`AEMET rayos fetch failed after ${retries + 1} attempts: ${msg}`);
}
