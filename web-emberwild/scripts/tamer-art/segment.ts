/**
 * segment.ts — real illustrated part art → region-indexed PNGs.
 *
 * The raw sources (scripts/tamer-art/raw/*.png, see raw/urls.txt) are
 * AI-generated illustrations in the hero/townsfolk painterly pixel style:
 *   - bodies: headless mannequins in their exact garments
 *   - heads:  blank bald mannequin heads (four jaw shapes)
 *   - faces:  heads on a flat magenta field, features only (neutral / grin)
 *   - hair:   mannequin heads wearing the style in mid-brown
 *
 * This script segments each raw image into the registry's region slots by
 * color-keying against per-part key palettes (authoring-time keying — the
 * game itself only ever reads the emitted slot/shade pixels), normalizes
 * scale and anchors to the registry canvases (src/game/appearance.ts is the
 * source of truth), and writes the filenames the registry expects into
 * public/tamers/. It also emits scripts/tamer-art/preview.png: composed
 * looks rendered from the written files.
 *
 * `bun scripts/tamer-art/segment.ts` — exits non-zero on validation failure.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { decodePng, encodePng } from "./png";
import {
  BODIES,
  FACES,
  HAIRS,
  HEADS,
  SLOT,
  SHADES,
  assetFiles,
  colorDistance,
  composeLook,
  decodePart,
  generateLook,
  luma,
  validatePart,
  type Rgb,
} from "../../src/game/appearance";

const OUT_DIR = new URL("../../public/tamers/", import.meta.url);
const RAW_DIR = new URL("./raw/", import.meta.url);

// ── raw image helpers ───────────────────────────────────────────────────────

interface Img {
  w: number;
  h: number;
  rgba: Uint8Array;
}

const loadRaw = (name: string): Img => {
  const png = decodePng(new Uint8Array(readFileSync(new URL(`${name}.png`, RAW_DIR))));
  return { w: png.w, h: png.h, rgba: png.rgba };
};

const hexRgb = (hex: string): Rgb => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const SKIN_KEY = hexRgb("#c8956c");
const HAIR_KEY = hexRgb("#6b4a2c");
const OUTLINE_KEY: Rgb = [34, 23, 28];

const atA = (im: Img, x: number, y: number): number => (x < 0 || y < 0 || x >= im.w || y >= im.h ? 0 : im.rgba[(y * im.w + x) * 4 + 3]);
const opaque = (im: Img, x: number, y: number): boolean => atA(im, x, y) >= 100;
const colAt = (im: Img, x: number, y: number): Rgb => {
  const i = (y * im.w + x) * 4;
  return [im.rgba[i], im.rgba[i + 1], im.rgba[i + 2]];
};
const lumas = (im: Img): number[] => {
  const out = new Array<number>(im.w * im.h);
  for (let i = 0; i < im.w * im.h; i++) out[i] = luma([im.rgba[i * 4], im.rgba[i * 4 + 1], im.rgba[i * 4 + 2]]);
  return out;
};

/** 3×3 luma box blur (opaque neighbors only): the raw painterly texture is
 * high-frequency noise that reads as speckle after the 27× downscale. */
function blurLuma(im: Img, L: number[], passes = 1): number[] {
  let cur = L;
  for (let p = 0; p < passes; p++) {
    const out = new Array<number>(im.w * im.h);
    for (let y = 0; y < im.h; y++)
      for (let x = 0; x < im.w; x++) {
        const i = y * im.w + x;
        if (!opaque(im, x, y)) {
          out[i] = cur[i];
          continue;
        }
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= im.w || ny >= im.h || !opaque(im, nx, ny)) continue;
            sum += cur[ny * im.w + nx];
            n++;
          }
        out[i] = n ? sum / n : cur[i];
      }
    cur = out;
  }
  return cur;
}
/** HSV saturation (mx-normalized): outline ink is dull, hair/skin shadows are not. */
const satOf = (c: Rgb): number => {
  const mx = Math.max(...c), mn = Math.min(...c);
  return mx === 0 ? 0 : (mx - mn) / mx;
};

/** Bounding box of opaque pixels (inclusive). */
function trim(im: Img): [number, number, number, number] {
  let x0 = im.w, y0 = im.h, x1 = -1, y1 = -1;
  for (let y = 0; y < im.h; y++)
    for (let x = 0; x < im.w; x++)
      if (opaque(im, x, y)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) throw new Error("empty image");
  return [x0, y0, x1, y1];
}

function crop(im: Img, x0: number, y0: number, x1: number, y1: number): Img {
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * im.w + (x0 + x)) * 4;
      out.set(im.rgba.subarray(s, s + 4), (y * w + x) * 4);
    }
  return { w, h, rgba: out };
}

/** Box-filter resample: color = mean of opaque source px, alpha from coverage. */
function resample(im: Img, tw: number, th: number): Img {
  const out = new Uint8Array(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const sy0 = (ty * im.h) / th, sy1 = ((ty + 1) * im.h) / th;
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = (tx * im.w) / tw, sx1 = ((tx + 1) * im.w) / tw;
      let r = 0, g = 0, b = 0, n = 0, box = 0;
      for (let y = Math.floor(sy0); y < Math.min(im.h, Math.ceil(sy1)); y++)
        for (let x = Math.floor(sx0); x < Math.min(im.w, Math.ceil(sx1)); x++) {
          const area = Math.max(0, Math.min(x + 1, sx1) - Math.max(x, sx0)) * Math.max(0, Math.min(y + 1, sy1) - Math.max(y, sy0));
          if (area <= 0) continue;
          box += area;
          if (atA(im, x, y) < 100) continue;
          const c = colAt(im, x, y);
          r += c[0] * area;
          g += c[1] * area;
          b += c[2] * area;
          n += area;
        }
      const o = (ty * tw + tx) * 4;
      if (n > 0 && n / box >= 0.3) {
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
        out[o + 3] = 255;
      }
    }
  }
  return { w: tw, h: th, rgba: out };
}

/** Largest 4-connected component of `mask`; returns member mask + bbox. */
function largestBlob(im: Img, mask: boolean[]): { mask: boolean[]; bbox: [number, number, number, number]; size: number } {
  const seen = new Array(im.w * im.h).fill(false);
  let best: { mask: boolean[]; bbox: [number, number, number, number]; size: number } | null = null;
  const stack: number[] = [];
  for (let s = 0; s < im.w * im.h; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp: number[] = [];
    stack.length = 0;
    stack.push(s);
    seen[s] = true;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % im.w, y = (i / im.w) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= im.w || ny >= im.h) continue;
        const j = ny * im.w + nx;
        if (mask[j] && !seen[j]) {
          seen[j] = true;
          stack.push(j);
        }
      }
    }
    if (!best || comp.length > best.size) {
      let bx0 = im.w, by0 = im.h, bx1 = -1, by1 = -1;
      const cm = new Array(im.w * im.h).fill(false);
      for (const i of comp) {
        cm[i] = true;
        const x = i % im.w, y = (i / im.w) | 0;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
      best = { mask: cm, bbox: [bx0, by0, bx1, by1], size: comp.length };
    }
  }
  if (!best) throw new Error("no blob found");
  return best;
}

const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};

/** Remove a flat magenta field (#ff00ff) and despill its fringe. */
function unMagenta(im: Img): Img {
  const kill = new Array(im.w * im.h).fill(false);
  for (let i = 0; i < im.w * im.h; i++) {
    const r = im.rgba[i * 4], g = im.rgba[i * 4 + 1], b = im.rgba[i * 4 + 2];
    kill[i] = im.rgba[i * 4 + 3] < 100 || (r > 140 && b > 140 && g < Math.min(r, b) - 50);
  }
  for (let y = 0; y < im.h; y++)
    for (let x = 0; x < im.w; x++) {
      const i = y * im.w + x;
      if (kill[i]) continue;
      const near = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]].some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && ny >= 0 && nx < im.w && ny < im.h && kill[ny * im.w + nx];
      });
      if (!near) continue;
      const o = i * 4, r = im.rgba[o], g = im.rgba[o + 1], b = im.rgba[o + 2];
      if (r > g + 25 && b > g + 25) {
        im.rgba[o] = Math.round((r + g) / 2);
        im.rgba[o + 2] = Math.round((b + g) / 2);
      }
    }
  return im;
}

/** Skin blob of a mannequin (face+neck): bbox, center-x, bottom row. */
function skinRef(im: Img): { cx: number; bottom: number; width: number } {
  const mask = new Array(im.w * im.h).fill(false);
  for (let i = 0; i < im.w * im.h; i++) {
    const o = i * 4;
    if (im.rgba[o + 3] < 100) continue;
    mask[i] = colorDistance([im.rgba[o], im.rgba[o + 1], im.rgba[o + 2]], SKIN_KEY) < 80;
  }
  const blob = largestBlob(im, mask);
  const [x0, y0, x1, y1] = blob.bbox;
  return { cx: (x0 + x1 + 1) / 2, bottom: y1, width: x1 - x0 + 1 };
}

// ── slot assignment ─────────────────────────────────────────────────────────

interface Key {
  slot: number;
  rgb: Rgb;
  base: number; // luma of the key color = authored shade 4
}

/**
 * Classify every opaque pixel of `im` into `keys`; returns (slot, shade).
 *
 * Outline rule: a dark pixel becomes outline when it is near the silhouette
 * edge OR thin (not part of a solid dark block) — so dark garments (boots,
 * gloves) survive as their own slot while separatrix lines and silhouette
 * ink become outline.
 */
function classify(im: Img, keys: Key[]): { slot: Uint8Array; shade: Uint8Array } {
  const slot = new Uint8Array(im.w * im.h).fill(255);
  const outline = keys.find((k) => k.slot === SLOT.outline)!;
  const rest = keys.filter((k) => k.slot !== SLOT.outline);
  const L = lumas(im);
  const darkish = Array.from(L, (l) => l < 92);
  const nearEdge = (x: number, y: number): boolean => {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= im.w || ny >= im.h || !opaque(im, nx, ny)) return true;
      }
    return false;
  };
  for (let y = 0; y < im.h; y++)
    for (let x = 0; x < im.w; x++) {
      const i = y * im.w + x;
      if (!opaque(im, x, y)) continue;
      const c = colAt(im, x, y);
      let best: Key | null = null, bd = Infinity;
      for (const k of rest) {
        const d = colorDistance(c, k.rgb);
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      const thin = ![[0, -1], [0, 1], [-1, 0], [1, 0]].every(([dx, dy]) => darkish[(y + dy) * im.w + (x + dx)]);
      // outline ink: dark AND dull; near-black always counts as a candidate
      const outlineish = L[i] < 92 && (satOf(c) < 0.5 || L[i] < 40) && (colorDistance(c, outline.rgb) <= bd || L[i] < 50);
      const isOutline = outlineish && (nearEdge(x, y) || thin);
      slot[i] = (isOutline ? outline : best!).slot;
    }
  // kill isolated misassignments: a pixel whose 3×3 majority is elsewhere is
  // painterly noise that reads as speckle at 64×96
  for (let y = 0; y < im.h; y++)
    for (let x = 0; x < im.w; x++) {
      const i = y * im.w + x;
      if (slot[i] === 255) continue;
      const counts = new Map<number, number>();
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= im.w || ny >= im.h) continue;
          const s = slot[ny * im.w + nx];
          if (s === 255 || s === slot[i]) continue;
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
      let bestS = -1, bestN = 0;
      for (const [s, n] of counts) if (n > bestN) { bestN = n; bestS = s; }
      const sameN = 8 - (counts.get(255) ?? 0) - [...counts.values()].reduce((a, b) => a + b, 0);
      // majority elsewhere, or a width-1 island: boundary blend pixels
      if (bestN >= 4 || (sameN <= 1 && bestN >= 3)) slot[i] = bestS;
    }
  // blur only for shading — the raw field drives classification (a blur
  // erases the 1 px ink outlines)
  return { slot, shade: shades(im, keys, slot, blurLuma(im, L, 2)) };
}

/** Authoring shade: 4 = the key (base) color, darker → 0, lighter → 7. */
function shades(im: Img, keys: Key[], slot: Uint8Array, L: number[]): Uint8Array {
  const shade = new Uint8Array(im.w * im.h);
  for (const k of keys) {
    const devs: number[] = [];
    for (let i = 0; i < im.w * im.h; i++) if (slot[i] === k.slot) devs.push(L[i] - k.base);
    if (!devs.length) continue;
    const ref = Math.max(20, percentile(devs.map(Math.abs), 0.85));
    const seen = new Set<number>();
    for (let i = 0; i < im.w * im.h; i++) {
      if (slot[i] !== k.slot) continue;
      const s = Math.max(0, Math.min(SHADES - 1, Math.round(4 + (L[i] - k.base) * 2.2 / ref)));
      shade[i] = s;
      seen.add(s);
    }
    // flat art: guarantee at least three authored shades (tests require ≥2)
    if (seen.size < 3) {
      const idx: number[] = [];
      for (let i = 0; i < im.w * im.h; i++) if (slot[i] === k.slot) idx.push(i);
      idx.sort((a, b) => L[a] - L[b]);
      idx.forEach((i, r) => {
        shade[i] = r < idx.length / 3 ? 2 : r < (2 * idx.length) / 3 ? 4 : 6;
      });
    }
  }
  smoothShade(slot, shade, im.w, im.h, 2);
  return shade;
}

/**
 * Smooth shade speckle: adopt the dominant same-slot neighbor shade when the
 * pixel is an outlier (each pass settles local ridges; hair art needs more
 * passes than the flat span art).
 */
function smoothShade(slot: Uint8Array, shade: Uint8Array, w: number, h: number, passes: number): void {
  for (let pass = 0; pass < passes; pass++) {
    const next = Uint8Array.from(shade);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (slot[i] === 255) continue;
        const nbs: number[] = [];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = ny * w + nx;
            if (slot[n] === slot[i]) nbs.push(shade[n]);
          }
        if (nbs.length < 4) continue;
        const counts = new Map<number, number>();
        for (const n of nbs) counts.set(n, (counts.get(n) ?? 0) + 1);
        let mode = -1, modeN = 0;
        for (const [v, n] of counts) if (n > modeN) { modeN = n; mode = v; }
        if (modeN >= 4 && mode !== shade[i]) next[i] = mode;
      }
    shade.set(next);
  }
}

function emit(name: string, w: number, h: number, slot: Uint8Array, shade: Uint8Array): void {
  writeFileSync(new URL(`${name}.png`, OUT_DIR), Buffer.from(encodePng(w, h, rgbaOf(w, h, slot, shade))));
}

const rgbaOf = (w: number, h: number, slot: Uint8Array, shade: Uint8Array): Uint8Array => {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (slot[i] === 255) continue;
    rgba[i * 4] = slot[i] * 16 + 8;
    // outline ink is uniform (the compositor's outline ramp has 4 entries);
    // shades stay in the span-art range 1..6 (the top ramp entry is a
    // near-white the hand art never used — it reads as speckle)
    rgba[i * 4 + 1] =
      (slot[i] === SLOT.outline ? 3 : Math.max(1, Math.min(6, shade[i]))) * 32 + 16;
    rgba[i * 4 + 2] = 128;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
};

/** If a declared slot ended up empty, reassign the closest donor pixels. */
function repair(keys: Key[], slot: Uint8Array, im: Img): void {
  for (const k of keys) {
    if (k.slot === SLOT.outline) continue;
    if (slot.some((s) => s === k.slot)) continue;
    const scored: [number, number][] = [];
    for (let i = 0; i < im.w * im.h; i++) {
      if (slot[i] === 255 || slot[i] === SLOT.outline || slot[i] === k.slot) continue;
      scored.push([colorDistance(colAt(im, i % im.w, (i / im.w) | 0), k.rgb), i]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    if (!scored.length || scored[0][0] > 160) throw new Error(`slot ${k.slot}: no pixels and no plausible donors`);
    for (let n = 0; n < Math.min(40, scored.length); n++) slot[scored[n][1]] = k.slot;
  }
}

function blit(src: Img, dst: Img, ox: number, oy: number): void {
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const dx = ox + x, dy = oy + y;
      if (dx < 0 || dy < 0 || dx >= dst.w || dy >= dst.h || !opaque(src, x, y)) continue;
      dst.rgba.set(src.rgba.subarray((y * src.w + x) * 4, (y * src.w + x) * 4 + 4), (dy * dst.w + dx) * 4);
    }
}

/** Refine a seed key to the mean of its nearby pixels (2 k-means rounds). */
function refineKey(im: Img, seed: Rgb): Rgb {
  let c = seed;
  for (let round = 0; round < 2; round++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < im.w * im.h; i++) {
      const o = i * 4;
      if (im.rgba[o + 3] < 100) continue;
      const px: Rgb = [im.rgba[o], im.rgba[o + 1], im.rgba[o + 2]];
      if (colorDistance(px, c) < 90) {
        r += px[0];
        g += px[1];
        b += px[2];
        n++;
      }
    }
    if (n < 40) break;
    c = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }
  return c;
}

// ── bodies ──────────────────────────────────────────────────────────────────

/** Garment id → the key color the generator was asked for. */
const BODY_KEYS: Record<string, Record<string, string>> = {
  "body.trailwarden": { coat: "#a83232", shirt: "#e8dcc8", belt: "#6b4a2c", trousers: "#4a3826", boots: "#2a1f1a", metal: "#d4a843" },
  "body.brawler": { vest: "#2e7d76", wraps: "#e8dcc8", sash: "#a33327", trousers: "#5a4632", shoes: "#2a1f1a" },
  "body.wayfarer": { capelet: "#9a4a6a", dress: "#4a5a7a", belt: "#6b4a2c", leggings: "#3a3a4a", boots: "#4a342a", metal: "#d4a843" },
  "body.scout": { jacket: "#2f6f6a", top: "#e8dcc8", trousers: "#5a4632", gloves: "#3a2a20", boots: "#2a1f1a", satchel: "#8a6a3a", metal: "#d4a843" },
};

function buildBody(bodyId: string): void {
  const raw = loadRaw(bodyId.replace("body.", "body_"));
  const [x0, y0, x1, y1] = trim(raw);
  const cropped = crop(raw, x0, y0, x1, y1);
  const scale = Math.min(64 / cropped.h, 64 / cropped.w);
  const tw = Math.max(1, Math.round(cropped.w * scale)), th = Math.max(1, Math.round(cropped.h * scale));
  const canvas: Img = { w: 64, h: 64, rgba: new Uint8Array(64 * 64 * 4) };
  blit(resample(cropped, tw, th), canvas, 32 - (tw >> 1), 64 - th); // feet bottom-center

  const keys: Key[] = [
    { slot: SLOT.outline, rgb: OUTLINE_KEY, base: luma(OUTLINE_KEY) },
    { slot: SLOT.skin, rgb: SKIN_KEY, base: luma(SKIN_KEY) },
  ];
  for (const g of BODIES.find((b) => b.id === bodyId)!.garments ?? []) {
    const hex = BODY_KEYS[bodyId]?.[g.id];
    if (!hex) throw new Error(`${bodyId}: no key color for garment ${g.id}`);
    keys.push({ slot: g.slot, rgb: refineKey(raw, hexRgb(hex)), base: luma(hexRgb(hex)) });
  }
  if (BODY_KEYS[bodyId]?.metal && BODIES.find((b) => b.id === bodyId)!.slots.includes(SLOT.metal)) {
    const rgb = hexRgb(BODY_KEYS[bodyId].metal);
    keys.push({ slot: SLOT.metal, rgb: refineKey(raw, rgb), base: luma(rgb) });
  }
  const { slot, shade } = classify(canvas, keys);
  repair(keys, slot, canvas);
  emit(bodyId.replace(".", "_"), 64, 64, slot, shade);
}

// ── heads ───────────────────────────────────────────────────────────────────

interface HeadRef {
  cx: number;
  bottom: number;
  width: number;
}

function buildHead(headId: string): HeadRef {
  const raw = loadRaw(headId.replace("head.", "head_"));
  const [x0, y0, x1, y1] = trim(raw);
  const cropped = crop(raw, x0, y0, x1, y1);
  const scale = Math.min(30 / cropped.h, 32 / cropped.w);
  const tw = Math.max(1, Math.round(cropped.w * scale)), th = Math.max(1, Math.round(cropped.h * scale));
  const canvas: Img = { w: 32, h: 32, rgba: new Uint8Array(32 * 32 * 4) };
  blit(resample(cropped, tw, th), canvas, 16 - (tw >> 1), 32 - th); // neck bottom-center

  const keys: Key[] = [
    { slot: SLOT.outline, rgb: OUTLINE_KEY, base: luma(OUTLINE_KEY) },
    { slot: SLOT.skin, rgb: SKIN_KEY, base: luma(SKIN_KEY) },
  ];
  const { slot, shade } = classify(canvas, keys);
  repair(keys, slot, canvas);
  emit(headId.replace(".", "_"), 32, 32, slot, shade);

  const skinMask = Array.from(slot, (s) => s === SLOT.skin);
  const blob = largestBlob(canvas, skinMask);
  const [bx0, by0, bx1, by1] = blob.bbox;
  return { cx: (bx0 + bx1 + 1) / 2, bottom: by1, width: bx1 - bx0 + 1 };
}

// ── faces ───────────────────────────────────────────────────────────────────

const FACE_KEYS: Key[] = [
  { slot: SLOT.outline, rgb: OUTLINE_KEY, base: luma(OUTLINE_KEY) },
  { slot: SLOT.skin, rgb: SKIN_KEY, base: luma(SKIN_KEY) },
  { slot: SLOT.iris, rgb: hexRgb("#3a2618"), base: luma(hexRgb("#3a2618")) },
  { slot: SLOT.sclera, rgb: hexRgb("#f2ece2"), base: luma(hexRgb("#f2ece2")) },
  { slot: SLOT.mouth, rgb: hexRgb("#a85a50"), base: luma(hexRgb("#a85a50")) },
  { slot: SLOT.brow, rgb: hexRgb("#5a4030"), base: luma(hexRgb("#5a4030")) },
];

// ── faces — hand-authored feature sheets ────────────────────────────────────
// The AI face generations are unusable at 24×16: a 20 px eye white scales to
// under a pixel, so features wash out. These feature tables (ported from the
// original span builder) sit on top of the AI heads at the same face origin.

type Span = [number, number, string, number?];

const canvas = (w: number, h: number) => ({ w, h, slot: new Uint8Array(w * h).fill(255), hint: new Int8Array(w * h) });

function paint(c: { w: number; h: number; slot: Uint8Array; hint: Int8Array }, spans: Span[], legend: Record<string, number>, ox: number, oy: number): void {
  if (oy < 0 || oy >= c.h) throw new Error(`row out of bounds: ${oy}`);
  for (const [x0, x1, ch, delta] of spans) {
    const slot = legend[ch];
    if (slot === undefined) throw new Error(`unknown legend char '${ch}'`);
    for (let x = x0; x <= x1; x++) {
      const px = ox + x;
      if (px < 0 || px >= c.w) throw new Error(`col out of bounds: ${px} (row ${oy}, char '${ch}')`);
      const i = oy * c.w + px;
      c.slot[i] = slot;
      c.hint[i] = delta ?? 0;
    }
  }
}

const FACE: Record<string, number> = {
  s: SLOT.skin, S: SLOT.skin, x: SLOT.skin, w: SLOT.sclera,
  i: SLOT.iris, I: SLOT.iris, r: SLOT.brow, u: SLOT.mouth, O: SLOT.outline,
};

/** The open laughing grin reused as every face's second frame. */
const OPEN_GRIN: Span[][] = [
  [], [], [], [], [], [], [], [], [], [], [],
  [[7, 7, "x"], [16, 16, "x"]],
  [[8, 15, "u"]],
  [[8, 8, "u"], [9, 14, "w"], [15, 15, "u"]],
  [[9, 14, "u"]],
  [],
];

const FACE_FEATURES: Record<string, { brows: Span[][]; mouth: Span[][]; grin: Span[][] }> = {
  stern: {
    brows: [
      [], [],
      [[2, 7, "r"], [16, 21, "r"]],
      [[6, 8, "r"], [15, 17, "r"]],
    ],
    mouth: [
      [], [], [], [], [], [], [], [], [], [], [], [],
      [],
      [[7, 7, "x"], [8, 15, "u"], [16, 16, "x"]],
      [],
      [],
    ],
    grin: [
      [], [], [], [], [], [], [], [], [], [], [],
      [[7, 7, "x"], [16, 16, "x"]],
      [[8, 15, "u"]],
      [[8, 8, "u"], [9, 14, "w"], [15, 15, "u"]],
      [[9, 14, "u"]],
      [],
    ],
  },
  easy: {
    brows: [
      [], [],
      [[2, 8, "r"], [15, 21, "r"]],
      [],
    ],
    mouth: [
      [], [], [], [], [], [], [], [], [], [], [],
      [[7, 7, "u"], [16, 16, "u"]],
      [[8, 15, "u"]],
      [],
      [],
    ],
    grin: OPEN_GRIN,
  },
  bright: {
    brows: [
      [],
      [],
      [[3, 6, "r"], [17, 20, "r"]],
      [[2, 8, "r"], [15, 21, "r"]],
    ],
    mouth: [
      [], [], [], [], [], [], [], [], [], [], [],
      [[7, 7, "x"], [16, 16, "x"]],
      [[8, 15, "u"]],
      [[8, 8, "u"], [9, 14, "w"], [15, 15, "u"]],
      [[9, 14, "u"]],
      [],
    ],
    grin: OPEN_GRIN,
  },
  keen: {
    brows: [
      [], [],
      [[2, 8, "r"], [15, 21, "r"]],
      [[3, 4, "r"]],
    ],
    mouth: [
      [], [], [], [], [], [], [], [], [], [], [], [],
      [[15, 16, "u"]],
      [[8, 15, "u"]],
      [],
      [],
    ],
    grin: OPEN_GRIN,
  },
};

const EYES: Span[][] = [
  [], [],
  [],
  [[1, 7, "O"], [16, 22, "O"]],
  [[1, 1, "O"], [2, 2, "w"], [3, 3, "I"], [4, 5, "i"], [6, 6, "w"], [7, 7, "O"], [16, 16, "O"], [17, 17, "w"], [18, 18, "I"], [19, 20, "i"], [21, 21, "w"], [22, 22, "O"]],
  [[1, 1, "O"], [2, 2, "w"], [3, 5, "i"], [6, 6, "w"], [7, 7, "O"], [16, 16, "O"], [17, 17, "w"], [18, 20, "i"], [21, 21, "w"], [22, 22, "O"]],
  [[1, 1, "O"], [2, 3, "w"], [4, 5, "i"], [6, 6, "w"], [7, 7, "O"], [16, 16, "O"], [17, 18, "w"], [19, 20, "i"], [21, 21, "w"], [22, 22, "O"]],
  [[1, 7, "O"], [16, 22, "O"]],
  [],
];

// nose rows 10..11 + cheek highlights row 9
const NOSE: Span[][] = Array.from({ length: 16 }, (_, y) =>
  y === 9 ? [[3, 4, "S"], [19, 20, "S"]] : y === 10 ? [[11, 12, "x"]] : y === 11 ? [[10, 13, "x"]] : [],
);

function faceCanvas(id: string): { w: number; h: number; slot: Uint8Array; hint: Int8Array } {
  const f = FACE_FEATURES[id.replace("face.", "")];
  const c = canvas(48, 16);
  for (const [frame, mouth] of [[0, f.mouth], [1, f.grin]] as [number, Span[][]][]) {
    const rows: Span[][] = Array.from({ length: 16 }, () => []);
    const merge = (src: Span[][]): void => src.forEach((spans, y) => rows[y].push(...spans));
    merge(f.brows);
    merge(EYES);
    merge(NOSE);
    merge(mouth);
    rows.forEach((spans, y) => paint(c, spans, FACE, frame * 24, y));
  }
  return c;
}

function buildFace(faceId: string): void {
  const c = faceCanvas(faceId);
  const slot = new Uint8Array(48 * 16).fill(255);
  const shade = new Uint8Array(48 * 16);
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= 48 || y >= 16 ? 255 : c.slot[y * 48 + x]);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 48; x++) {
      const i = y * 48 + x;
      const s = c.slot[i];
      if (s === 255) continue;
      let d = 4 + c.hint[i];
      const diff = (n: number): boolean => n !== s;
      if (s === SLOT.sclera) d = 5;
      else if (s === SLOT.iris) d = 3;
      else if (s === SLOT.brow) d = 2;
      else if (s === SLOT.mouth) d = 4;
      else if (s === SLOT.outline) d = 3;
      else {
        if (diff(at(x, y - 1))) d += 2;
        else if (diff(at(x - 1, y))) d += 1;
        if (diff(at(x + 1, y))) d -= 1;
        if (diff(at(x, y + 1))) d -= 1;
      }
      slot[i] = s;
      shade[i] = Math.max(0, Math.min(7, d));
    }
  writeFileSync(new URL(`${faceId.replace(".", "_")}.png`, OUT_DIR), Buffer.from(encodePng(48, 16, rgbaOf(48, 16, slot, shade))));
}

// ── hair ────────────────────────────────────────────────────────────────────

/**
 * Per-style fit, measured by eye off the raw generations (grid overlay):
 * face-oval center x, chin y, cheek-to-cheek span — all in RAW source px.
 * The game target is a ~21 px cheek span with the chin at hair-canvas row 30.
 */
const HAIR_FIT: Record<string, { cx: number; chin: number; cheekL: number; cheekR: number }> = {
  // cx/chin measured programmatically off the mannequin's face blob
  // (scripts/tamer-art/measure_fit.ts); crop keeps its hand-measured cheek
  // span because its ears sit inside the measured band.
  crop: { cx: 428, chin: 794, cheekL: 255, cheekR: 635 },
  tousled: { cx: 489, chin: 882, cheekL: 279, cheekR: 699 },
  bob: { cx: 440, chin: 805, cheekL: 209, cheekR: 670 },
  shag: { cx: 467, chin: 867, cheekL: 277, cheekR: 657 },
  mane: { cx: 391, chin: 529, cheekL: 265, cheekR: 517 },
  braid: { cx: 341, chin: 655, cheekL: 172, cheekR: 509 },
};

/** Per-style visual tuning: nudge the layer down and tweak scale. The AI art
 *  wears big volumes — without a shrink the styles swallow the head. */
const HAIR_TUNE: Record<string, { dy?: number; shrink?: number }> = {
  crop: { shrink: 0.95 },
  tousled: { shrink: 0.9 },
  bob: { shrink: 0.88 },
  shag: { shrink: 0.88 },
  mane: { shrink: 0.8 },
  braid: { shrink: 0.78 },
};

function buildHair(styleId: string, scale: number, headRef: HeadRef, dy: number): void {
  const raw = loadRaw(`${styleId.replace("hair.", "hair_")}_front`);
  const [x0, y0, x1, y1] = trim(raw);
  const head = crop(raw, x0, y0, x1, y1);
  const scaled = resample(head, Math.max(1, Math.round(head.w * scale)), Math.max(1, Math.round(head.h * scale)));
  // anchor: place the measured chin at hair-canvas row 30 (the game head's chin row)
  const fit = HAIR_FIT[styleId.replace("hair.", "")];

  // classify: hair pixels vs mannequin skin (dropped) vs outline ink.
  // This art's outline is a very dark red-brown (luma ≈ 15); hair shadows
  // sit around luma ≈ 50, so darkness alone separates them.
  const L = lumas(scaled); // raw field drives classification (blur erases 1 px ink)
  const Lb = blurLuma(scaled, L, 2); // blurred field drives shading
  const hairish = new Array(scaled.w * scaled.h).fill(false);
  for (let i = 0; i < scaled.w * scaled.h; i++) {
    const o = i * 4;
    if (scaled.rgba[o + 3] < 100) continue;
    const px: Rgb = [scaled.rgba[o], scaled.rgba[o + 1], scaled.rgba[o + 2]];
    if (colorDistance(px, SKIN_KEY) < 70) continue;
    if (colorDistance(px, HAIR_KEY) < 150) hairish[i] = true;
  }
  const outlinePx = new Array(scaled.w * scaled.h).fill(false);
  for (let y = 0; y < scaled.h; y++)
    for (let x = 0; x < scaled.w; x++) {
      const i = y * scaled.w + x;
      if (!opaque(scaled, x, y)) continue;
      const o = i * 4;
      const px: Rgb = [scaled.rgba[o], scaled.rgba[o + 1], scaled.rgba[o + 2]];
      if (!(L[i] < 40 && colorDistance(px, SKIN_KEY) >= 70)) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++)
        for (let dx = -2; dx <= 2 && !near; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < scaled.w && ny < scaled.h && hairish[ny * scaled.w + nx]) near = true;
        }
      outlinePx[i] = near;
    }

  // shades: luma relative to the hair key
  const base = luma(HAIR_KEY);
  const lum: number[] = [];
  for (let i = 0; i < scaled.w * scaled.h; i++) if (hairish[i]) lum.push(Lb[i]);
  const refL = Math.max(20, percentile(lum.map((l) => Math.abs(l - base)), 0.85));

  // draw into the 40×56 canvas: the mannequin's skin-blob bottom-center must
  // land where the head canvases put theirs (crown anchor (20,6) → head rows)
  const tx = Math.round(20 + (headRef.cx - 16));
  const placeOx = Math.round(tx - (fit.cx - x0) * scale);
  const placeOy = Math.round(30 + dy - (fit.chin - y0) * scale);
  const slotC = new Uint8Array(40 * 56).fill(255);
  const shadeC = new Uint8Array(40 * 56);
  const draw = (isHair: boolean): void => {
    for (let y = 0; y < scaled.h; y++)
      for (let x = 0; x < scaled.w; x++) {
        const i = y * scaled.w + x;
        const want = isHair ? hairish[i] : outlinePx[i] && !hairish[i];
        if (!want) continue;
        const dx = placeOx + x, dy = placeOy + y;
        if (dx < 0 || dy < 0 || dx >= 40 || dy >= 56) continue;
        // hair may never enter the face zone (brows/eyes/mouth)
        if (dy >= 16 && dx >= 10 && dx <= 29) continue;
        slotC[dy * 40 + dx] = isHair ? SLOT.hair : SLOT.outline;
        // hair keeps to the middle of the ramp: deep strand shadows read as
        // black speckle otherwise
        shadeC[dy * 40 + dx] = isHair ? Math.max(2, Math.min(6, Math.round(4 + (Lb[i] - base) * 2.2 / refL))) : 3;
      }
  };
  draw(false); // outline first, hair overwrites
  draw(true);
  // dark ink nearly surrounded by hair is strand shadow, not outline — keep
  // it as the darkest hair shade instead of a black speckle
  for (let y = 1; y < 55; y++)
    for (let x = 1; x < 39; x++) {
      const i = y * 40 + x;
      if (slotC[i] !== SLOT.outline) continue;
      let hairN = 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++)
          if ((ox || oy) && slotC[(y + oy) * 40 + x + ox] === SLOT.hair) hairN++;
      if (hairN >= 6) {
        slotC[i] = SLOT.hair;
        shadeC[i] = 2;
      }
    }
  smoothShade(slotC, shadeC, 40, 56, 3); // hair art shades speckle badly at this scale
  emit(`${styleId.replace(".", "_")}`, 40, 56, slotC, shadeC);
}

// ── run ─────────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

const headRefs: HeadRef[] = [];
for (const h of HEADS) headRefs.push(buildHead(h.id));
const headRef: HeadRef = {
  cx: headRefs.reduce((s, h) => s + h.cx, 0) / headRefs.length,
  bottom: headRefs.reduce((s, h) => s + h.bottom, 0) / headRefs.length,
  width: headRefs.reduce((s, h) => s + h.width, 0) / headRefs.length,
};

for (const b of BODIES) buildBody(b.id);
for (const f of FACES) buildFace(f.id);

// the game head's cheek-to-cheek span (ears excluded), in head-canvas px
const GAME_CHEEK_W = 21;
for (const h of HAIRS) {
  const id = h.id.replace("hair.", "");
  const fit = HAIR_FIT[id];
  const tune = HAIR_TUNE[id] ?? {};
  const scale = GAME_CHEEK_W / (fit.cheekR - fit.cheekL) * (tune.shrink ?? 1);
  buildHair(h.id, scale, headRef, tune.dy ?? 0);
}

// ── validation + preview ────────────────────────────────────────────────────

const problems: string[] = [];
const parts = new Map<string, { w: number; h: number; slot: Uint8Array; shade: Uint8Array }>();
for (const f of assetFiles()) {
  const png = decodePng(new Uint8Array(readFileSync(new URL(`../../public${f.src}`, import.meta.url))));
  const dec = decodePart(png.w, png.h, png.rgba);
  problems.push(...validatePart(f, png.w, png.h, dec));
  parts.set(f.src, dec.map);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const looks = [7, 91, 233, 512, 777, 1024, 1333, 1701, 1999, 2444, 2828, 3333].map((s) => generateLook(s));
const SC = 3, cellW = 64 * SC + 8;
const W = 6 * cellW + 12;
const H = 12 + Math.ceil(looks.length / 6) * (96 * SC + 12);
const sheet = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) sheet.set([46, 40, 52, 255], i * 4);
const blitS = (buf: { w: number; h: number; rgba: Uint8Array }, X: number, Y: number, sc: number): void => {
  for (let y = 0; y < buf.h; y++)
    for (let x = 0; x < buf.w; x++) {
      const i = (y * buf.w + x) * 4;
      if (!buf.rgba[i + 3]) continue;
      for (let dy = 0; dy < sc; dy++)
        for (let dx = 0; dx < sc; dx++) {
          const o = ((Y + y * sc + dy) * W + X + x * sc + dx) * 4;
          sheet.set([buf.rgba[i], buf.rgba[i + 1], buf.rgba[i + 2], 255], o);
        }
    }
};
looks.forEach((look, i) => {
  const c = composeLook(look, (src) => parts.get(src));
  blitS({ w: c.w, h: c.h, rgba: new Uint8Array(c.rgba) }, 6 + (i % 6) * cellW, 6 + Math.floor(i / 6) * (96 * SC + 12), SC);
});
writeFileSync(new URL("./preview.png", import.meta.url), Buffer.from(encodePng(W, H, sheet)));
console.log(`segment: wrote ${assetFiles().length} parts + preview.png`);
