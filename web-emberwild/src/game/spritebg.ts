/**
 * Automatic black-background removal for sprites — one shared pipeline.
 *
 * The build-time art pipeline (scripts/sprites.ts) and the runtime loaders both
 * push sprites through `stripBlackBackground`, which removes background black
 * while keeping the black that belongs to the art (eyes, dark maws, textured
 * armor, outlines):
 *
 *  - pass 1: flood fill from the image borders through near-black pixels
 *  - pass 2: large uniform enclosed black pockets (a flat black fill is
 *    background); creature-internal black is small or textured, so it stays
 *  - `defringeEdges`: dark pixels hugging transparency blend toward nearby body
 *    color, killing dark halos around the silhouette
 *
 * Sprites whose border carries no opaque black pass through untouched, so
 * already transparent art is never modified. Cut-out art (a mostly transparent
 * border with leftover dark glow smudges) is guarded too: its dark interior is
 * creature color — a charcoal coat, dark armor — and flooding from the smudges
 * would eat the creature it is meant to clean.
 */

export interface RawImage {
  w: number;
  h: number;
  data: Uint8Array;
}

/** Fraction rectangle (fractions of width/height) for seed/protect overrides. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Max channel value for a pixel to count as black. */
const BLACK_MAX = 36;
/** Enclosed black pockets under this fraction of the canvas are creature detail. */
const POCKET_KEEP_FRAC = 400; // kept when pixels * POCKET_KEEP_FRAC < w*h (< 0.25%)
/** Enclosed pockets flatter than this stddev are flat fills, i.e. background. */
const POCKET_STD_MAX = 16;
/** Dark 8-neighbors that mark a pixel as line work, not anti-alias fringe —
 *  a fringe band pixel runs along the edge (2 dark neighbors); line work has
 *  structure beside and behind it. */
const DEFRINGE_LINE_NEIGHBORS = 3;
/** A line-work pocket stays alive if it is thinner than 2 * this + 1 pixels. */
const POCKET_THIN = 2;
/** How far defringe searches for body color. */
const DEFRINGE_RADIUS = 5;
/** Luminance below which an edge pixel counts as a dark fringe. */
const DEFRINGE_DARK_LUM = 95;
/** Luminance a neighbor needs to count as body color. */
const DEFRINGE_BODY_LUM = 105;
/** How strongly defringe pulls an edge pixel toward body color. */
const DEFRINGE_MIX = 0.65;

const lumAt = (d: Uint8Array, o: number): number => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

/**
 * Remove background black while keeping creature-internal black.
 * Idempotent on silhouette: already-transparent art keeps its exact alpha.
 */
export function stripBlackBackground(src: RawImage, ov: { T?: number; seed?: Rect[]; protect?: Rect[] } = {}): RawImage {
  const { w, h } = src;
  const T = ov.T ?? BLACK_MAX;
  const black = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (Math.max(src.data[o], src.data[o + 1], src.data[o + 2]) <= T) black[i] = 1;
  }
  // cut-out guard: when most of the border is already transparent, the art was
  // cleaned elsewhere — any opaque dark smudges hugging the edge are at most
  // leftover glow, while the creature itself may be near-black. Flooding from
  // the smudges would consume the coat, so the art passes through untouched
  // (defringe still softens any dark halo hugging real transparency).
  let borderArea = 0;
  let borderClear = 0;
  for (let x = 0; x < w; x++) {
    borderArea += 2;
    if (src.data[x * 4 + 3] === 0) borderClear++;
    if (src.data[((h - 1) * w + x) * 4 + 3] === 0) borderClear++;
  }
  for (let y = 0; y < h; y++) {
    borderArea += 2;
    if (src.data[(y * w) * 4 + 3] === 0) borderClear++;
    if (src.data[(y * w + w - 1) * 4 + 3] === 0) borderClear++;
  }
  if (borderClear * 4 >= borderArea) {
    const spared: RawImage = { w, h, data: Uint8Array.from(src.data) };
    defringeEdges(spared);
    return spared;
  }

  const px = (r: Rect, f: (i: number) => void): void => {
    for (let y = Math.floor(r.y0 * h); y < Math.ceil(r.y1 * h); y++)
      for (let x = Math.floor(r.x0 * w); x < Math.ceil(r.x1 * w); x++) f(y * w + x);
  };
  for (const r of ov.protect ?? []) px(r, (i) => { black[i] = 0; });

  // pass 1: flood from borders (+ manual seeds) through black
  const remove = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qn = 0;
  const seed = (i: number): void => {
    // opaque black only: transparent border pixels are already background, and
    // seeding on them would re-process art that is already clean
    if (black[i] && src.data[i * 4 + 3] > 0 && !remove[i]) {
      remove[i] = 1;
      queue[qn++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  for (const r of ov.seed ?? []) px(r, seed);

  // conservative fast path: no black touches the border and nothing was seeded —
  // there is no background black to find, so leave the art exactly as it is
  if (qn === 0) return { w, h, data: Uint8Array.from(src.data) };

  let qh = 0;
  while (qh < qn) {
    const i = queue[qh++];
    const x = i % w, y = (i / w) | 0;
    // 4-connected flood: a closed anti-alias ring around a stroke — even a
    // one-pixel ring — must keep that stroke's core off limits, so the
    // background never eats its way into the creature's line work
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const ny = y + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      seed(ny * w + nx);
    }
  }

  // pass 2: enclosed black pockets — remove when large AND uniform (flat fill = background).
  // Creature black (eyes, maws, textured armor creases) is small or textured, so it stays.
  const comp = new Int32Array(w * h).fill(-1);
  for (let i0 = 0; i0 < w * h; i0++) {
    if (!black[i0] || remove[i0] || comp[i0] >= 0) continue;
    const id = (comp[i0] = i0);
    const pixels: number[] = [i0];
    for (let k = 0; k < pixels.length; k++) {
      const i = pixels[k], x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (black[ni] && !remove[ni] && comp[ni] < 0) {
            comp[ni] = id;
            pixels.push(ni);
          }
        }
      }
    }
    if (pixels.length * POCKET_KEEP_FRAC < w * h) continue; // small enough: creature detail
    let sr = 0, sg = 0, sb = 0;
    for (const i of pixels) {
      const o = i * 4;
      sr += src.data[o];
      sg += src.data[o + 1];
      sb += src.data[o + 2];
    }
    const mr = sr / pixels.length, mg = sg / pixels.length, mb = sb / pixels.length;
    let varSum = 0;
    for (const i of pixels) {
      const o = i * 4;
      varSum += (src.data[o] - mr) ** 2 + (src.data[o + 1] - mg) ** 2 + (src.data[o + 2] - mb) ** 2;
    }
    const std = Math.sqrt(varSum / pixels.length);
    if (std >= POCKET_STD_MAX) continue;
    // thin pockets are line work, not background: a dark seam between wing
    // fingers or a stroke cluster is flat too, but eroding it twice empties
    // it, while a true background hole keeps a thick core
    let live = new Uint8Array(w * h);
    for (const i of pixels) live[i] = 1;
    for (let e = 0; e < POCKET_THIN && live.some((v) => v); e++) {
      const next = new Uint8Array(w * h);
      for (const i of pixels) {
        if (!live[i]) continue;
        const x = i % w, y = (i / w) | 0;
        if (
          x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          !live[i - 1] || !live[i + 1] || !live[i - w] || !live[i + w]
        ) continue;
        next[i] = 1;
      }
      live = next;
    }
    if (!live.some((v) => v)) continue; // thin: line work, kept
    for (const i of pixels) remove[i] = 1;
  }

  const out: RawImage = { w, h, data: Uint8Array.from(src.data) };
  for (let i = 0; i < w * h; i++) if (remove[i]) out.data[i * 4 + 3] = 0;
  defringeEdges(out);
  return out;
}

/** Blend dark pixels that hug transparency toward nearby body color (kills dark halos). */
export function defringeEdges(img: RawImage, radius = DEFRINGE_RADIUS): void {
  defringe(img, radius, "dark");
}

/** Blend bright pixels that hug transparency toward nearby body color (kills white halos). */
export function defringeLightEdges(img: RawImage, radius = DEFRINGE_RADIUS): void {
  defringe(img, radius, "light");
}

/** Shared fringe pass: edge pixels of the given polarity pull toward body color. */
function defringe(img: RawImage, radius: number, mode: "dark" | "light"): void {
  const { w, h } = img;
  const snap = Uint8Array.from(img.data);
  const transparent = (x: number, y: number): boolean => snap[(y * w + x) * 4 + 3] === 0;
  const fringeLum = mode === "dark" ? DEFRINGE_DARK_LUM : 216;
  const bodyLum = mode === "dark" ? DEFRINGE_BODY_LUM : 200;
  const isFringe = (o: number): boolean => (mode === "dark" ? lumAt(snap, o) < fringeLum : lumAt(snap, o) >= fringeLum);
  const isBody = (o: number): boolean => (mode === "dark" ? lumAt(snap, o) >= bodyLum : lumAt(snap, o) < bodyLum);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (snap[o + 3] === 0) continue;
      let nearEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      for (let dy = -1; dy <= 1 && !nearEdge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || transparent(nx, ny)) {
            nearEdge = true;
            break;
          }
        }
      }
      if (!nearEdge || !isFringe(o)) continue;
      // count the dark structure around this pixel: fringe runs along an edge
      // with little dark company; line work (a stroke, a crease) has dark
      // pixels beside and behind it and must not be blended away
      let darkNeighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || (dx === 0 && dy === 0)) continue;
          if (snap[(ny * w + nx) * 4 + 3] === 0) continue;
          if (lumAt(snap, (ny * w + nx) * 4) < fringeLum) darkNeighbors++;
        }
      }
      if (darkNeighbors >= DEFRINGE_LINE_NEIGHBORS) continue;
      let br = -1, bg = -1, bb = -1, bd = radius + 1;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const no = (ny * w + nx) * 4;
          if (snap[no + 3] === 0 || !isBody(no)) continue;
          const d = Math.abs(dx) + Math.abs(dy);
          if (d < bd) {
            bd = d;
            br = snap[no];
            bg = snap[no + 1];
            bb = snap[no + 2];
          }
        }
      }
      if (br < 0) continue;
      img.data[o] = Math.round(snap[o] * (1 - DEFRINGE_MIX) + br * DEFRINGE_MIX);
      img.data[o + 1] = Math.round(snap[o + 1] * (1 - DEFRINGE_MIX) + bg * DEFRINGE_MIX);
      img.data[o + 2] = Math.round(snap[o + 2] * (1 - DEFRINGE_MIX) + bb * DEFRINGE_MIX);
    }
  }
}

/**
 * Remove a white studio background while keeping the art's own whites (aprons,
 * shirts, highlights). Only pixels flood-connected to the border through
 * near-white are removed — interior whites sit behind dark pixel outlines and
 * are unreachable, so there is deliberately no pocket pass. Idempotent on
 * already-transparent art (the border carries no opaque white).
 */
export function stripWhiteBackground(src: RawImage, whiteMin = 246): RawImage {
  const { w, h } = src;
  const white = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (Math.min(src.data[o], src.data[o + 1], src.data[o + 2]) >= whiteMin) white[i] = 1;
  }
  const remove = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qn = 0;
  const seed = (i: number): void => {
    if (white[i] && src.data[i * 4 + 3] > 0 && !remove[i]) {
      remove[i] = 1;
      queue[qn++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  if (qn === 0) return { w, h, data: Uint8Array.from(src.data) };
  let qh = 0;
  while (qh < qn) {
    const i = queue[qh++];
    const x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        seed(ny * w + nx);
      }
    }
  }
  const out: RawImage = { w, h, data: Uint8Array.from(src.data) };
  for (let i = 0; i < w * h; i++) if (remove[i]) out.data[i * 4 + 3] = 0;
  defringeLightEdges(out);
  return out;
}

// --- browser-side loader (never imported by tests) ---

const spriteCache = new Map<string, HTMLCanvasElement>();
const spritePending = new Set<string>();
const spriteListeners = new Set<() => void>();

const notifySprites = (): void => spriteListeners.forEach((l) => l());

function processSprite(im: HTMLImageElement): HTMLCanvasElement | null {
  if (!im.naturalWidth) return null;
  const cv = document.createElement("canvas");
  cv.width = im.naturalWidth;
  cv.height = im.naturalHeight;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(im, 0, 0);
  let raw: ImageData;
  try {
    raw = ctx.getImageData(0, 0, cv.width, cv.height);
  } catch {
    // cross-origin image without CORS headers: canvas is tainted — render
    // the sprite as-is rather than crashing on background removal
    return cv;
  }
  // the ImageData buffer is wrapped, not copied: cleaned pixels land back in `raw`
  const cleaned = stripBlackBackground({ w: cv.width, h: cv.height, data: new Uint8Array(raw.data.buffer) });
  raw.data.set(cleaned.data);
  ctx.putImageData(raw, 0, 0);
  return cv;
}

/**
 * Load a sprite with its black background automatically removed. Returns null
 * until the processed variant is ready; subscribe with onCleanSpriteReady.
 */
export function getCleanSprite(url: string): HTMLCanvasElement | null {
  const hit = spriteCache.get(url);
  if (hit) return hit;
  if (!spritePending.has(url)) {
    spritePending.add(url);
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.src = url;
    im.onload = () => {
      const cv = processSprite(im);
      if (cv) {
        spriteCache.set(url, cv);
        notifySprites();
      }
    };
  }
  return null;
}

/** Subscribe to processed-sprite readiness (hero, monsters, any future art). */
export function onCleanSpriteReady(l: () => void): () => void {
  spriteListeners.add(l);
  return () => {
    spriteListeners.delete(l);
  };
}
