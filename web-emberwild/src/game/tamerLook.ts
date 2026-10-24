import { assetFiles, composeLook, decodePart, lookKey, resolveLook, SPRITE_H, SPRITE_W, validatePart, validateRegistry, type AssetFile, type PartMap, type TamerLook } from "./appearance";

/**
 * Browser side of the rival appearance system: loads the region-indexed part
 * PNGs once, validates each against the registry, and caches composed
 * sprites per look. Composition happens once per distinct look (not per
 * frame); the map just blits the cached canvas.
 *
 * Failure policy: a part that fails to load or validate is treated as
 * missing. The compositor skips missing layers; if the body itself is
 * unavailable `getLookSprite` returns null and the map keeps its simple
 * fallback figure. Nothing here throws into the render loop.
 */

type PartState = { map: PartMap } | "loading" | "failed";

const parts = new Map<string, PartState>();
const listeners = new Set<() => void>();
const cache = new Map<string, HTMLCanvasElement | null>();
const CACHE_MAX = 48;
let started = false;
let pending = 0;
const problems: string[] = [];

function notify(): void {
  // looks composed from a partial part set are re-composed once more parts arrive
  cache.clear();
  for (const l of listeners) l();
}

function loadPart(f: AssetFile): void {
  parts.set(f.src, "loading");
  pending++;
  const img = new Image();
  img.decoding = "async";
  const done = (state: PartState): void => {
    parts.set(f.src, state);
    pending--;
    notify();
  };
  img.onload = () => {
    try {
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const c = cv.getContext("2d", { willReadFrequently: true });
      if (!c) return done("failed");
      c.drawImage(img, 0, 0);
      const data = c.getImageData(0, 0, cv.width, cv.height).data;
      const dec = decodePart(cv.width, cv.height, data);
      const errs = validatePart(f, cv.width, cv.height, dec);
      if (errs.length) {
        problems.push(...errs);
        console.warn(`[emberwild] tamer part rejected: ${errs.join("; ")}`);
        return done("failed");
      }
      done({ map: dec.map });
    } catch (e) {
      problems.push(`${f.src}: ${(e as Error).message}`);
      done("failed");
    }
  };
  img.onerror = () => {
    problems.push(`${f.src}: failed to load`);
    console.warn(`[emberwild] tamer part missing: ${f.src}`);
    done("failed");
  };
  img.src = f.src;
}

/** Start loading every registered part (idempotent; called lazily on first use). */
export function preloadTamerParts(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  const errs = validateRegistry();
  if (errs.length) console.warn(`[emberwild] tamer appearance registry problems: ${errs.join("; ")}`);
  for (const f of assetFiles()) loadPart(f);
}

/** Subscribe to part arrivals (the map repaints when sprites become available). */
export function onTamerLookReady(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function partOf(src: string): PartMap | null {
  const p = parts.get(src);
  return p && typeof p === "object" ? p.map : null;
}

/**
 * The composed 32×48 sprite for a look, or null while its body part is
 * still loading or unavailable (draw the fallback figure then). Invalid or
 * missing looks resolve to a safe registered look first.
 */
export function getLookSprite(raw: TamerLook | undefined | null): HTMLCanvasElement | null {
  preloadTamerParts();
  if (typeof document === "undefined") return null;
  const look = resolveLook(raw).look;
  const key = lookKey(look);
  const hit = cache.get(key);
  if (hit !== undefined) {
    // refresh LRU order
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const c = composeLook(look, partOf);
  const bodyMissing = c.layer.every((l) => l !== "body");
  if (bodyMissing) {
    // still loading: don't cache a null while parts are in flight
    if (pending > 0) return null;
    cache.set(key, null);
    return null;
  }
  const cv = document.createElement("canvas");
  cv.width = SPRITE_W;
  cv.height = SPRITE_H;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(c.rgba), SPRITE_W, SPRITE_H), 0, 0);
  if (pending === 0) {
    cache.set(key, cv);
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return cv;
}

/** Loader diagnostics (dev preview / console). */
export function tamerLookProblems(): readonly string[] {
  return problems;
}
