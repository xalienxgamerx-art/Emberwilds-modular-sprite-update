/**
 * Modular rival-tamer appearance: registry, palettes, generation, validation
 * and the pure (platform-free) sprite compositor.
 *
 * ── Asset format ────────────────────────────────────────────────────────────
 * Every part lives in public/tamers/ as a *region-indexed* PNG. A pixel does
 * not store a color; it stores WHICH region it belongs to and HOW LIT it is:
 *
 *   R = slot * 16 + 8      (slot 0..15, decoded with R >> 4)
 *   G = shade * 32 + 16    (shade 0 deep shadow .. 7 highlight, G >> 5)
 *   B = 128                (marker: lets validation reject foreign art)
 *   A = 255 opaque / 0 transparent
 *
 * The bucket encoding tolerates any small decode drift, and recoloring is an
 * exact (slot, shade) → ramp lookup — never approximate RGB matching. Shading,
 * outlines and highlights survive every recolor because they are the shade
 * index, which the palette never touches.
 *
 * ── Composition ─────────────────────────────────────────────────────────────
 * A tamer is drawn on a 32×48 sprite (2 px per tile pixel — the world draws it
 * ~1.42 tiles tall, like the other folk). Parts align through explicit anchors:
 *   body.feet → sprite feet; head.neck → body.neck;
 *   face.origin → head.face; hair.crown → head.crown.
 * Layer order: body → head → face → hair (a single sprite per style).
 *
 * Gameplay never reads any of this: appearance is pure presentation, stored
 * on the tamer as `look`, drawn from its own hash stream (no shared rng).
 */

import { hash2, Rng } from "./rng";

export const SPRITE_W = 64;
export const SPRITE_H = 96;
/** Sprite-space foot point (bottom center); the body's `feet` anchor lands here. */
export const SPRITE_FEET: [number, number] = [32, 95];
export const ASSET_ROOT = "/tamers";
export const LOOK_VERSION = 1;

// ── region slots ────────────────────────────────────────────────────────────

/** Fixed region slots. Garment slots are 8..13 and are named per body asset. */
export const SLOT = {
  outline: 0,
  skin: 1,
  hair: 2,
  iris: 3,
  sclera: 4,
  mouth: 5,
  brow: 6,
  metal: 7,
} as const;
export const GARMENT_SLOT_MIN = 8;
export const GARMENT_SLOT_MAX = 13;
export const SHADES = 8;

export function encodePixel(slot: number, shade: number): [number, number, number, number] {
  return [slot * 16 + 8, shade * 32 + 16, 128, 255];
}

// ── registry types ──────────────────────────────────────────────────────────

export type PartCategory = "body" | "head" | "face" | "hair";
export type Build = "masculine" | "feminine";
export type HairLength = "short" | "medium" | "long";
export type Anchor = [number, number];
export type PaletteKind = "cloth" | "light" | "leather" | "accent";

export interface GarmentRegion {
  /** Stable garment id, unique within its body — the key in `look.outfit`. */
  id: string;
  label: string;
  slot: number;
  palette: PaletteKind;
}

export interface PartDef {
  id: string;
  category: PartCategory;
  label: string;
  build?: Build;
  src: string;
  w: number;
  h: number;
  anchors: Record<string, Anchor>;
  /** Exactly the slots the file may contain (validated against the pixels). */
  slots: number[];
  garments?: GarmentRegion[];
  /** Faces: expression frames laid out horizontally, each `frameW` wide. */
  frames?: Record<string, number>;
  frameW?: number;
}

export interface HairDef {
  id: string;
  category: "hair";
  label: string;
  length: HairLength;
  w: number;
  h: number;
  anchors: Record<string, Anchor>;
  /** Single sprite drawn over the head; never reaches the brows, eyes or mouth. */
  src: string;
  slots: number[];
}

const src = (f: string): string => `${ASSET_ROOT}/${f}.png`;

// Body: 64×64 placed so its feet meet the sprite's feet; neck carries the head.
const BODY_ANCHORS = { feet: [32, 63] as Anchor, neck: [32, 7] as Anchor };
const BODY_W = 64;
const BODY_H = 64;
export const HEAD_W = 32;
export const HEAD_H = 32;
export const FACE_W = 24;
export const FACE_H = 16;
export const HAIR_W = 40;
export const HAIR_H = 56;

export const BODIES: PartDef[] = [
  {
    id: "body.trailwarden",
    category: "body",
    label: "Trailwarden",
    build: "masculine",
    src: src("body_trailwarden"),
    w: BODY_W,
    h: BODY_H,
    anchors: BODY_ANCHORS,
    slots: [SLOT.outline, SLOT.skin, SLOT.metal, 8, 9, 10, 11, 12],
    garments: [
      { id: "coat", label: "Long coat", slot: 8, palette: "cloth" },
      { id: "shirt", label: "Shirt", slot: 9, palette: "light" },
      { id: "belt", label: "Belt", slot: 10, palette: "leather" },
      { id: "trousers", label: "Trousers", slot: 11, palette: "cloth" },
      { id: "boots", label: "Boots", slot: 12, palette: "leather" },
    ],
  },
  {
    id: "body.brawler",
    category: "body",
    label: "Brawler",
    build: "masculine",
    src: src("body_brawler"),
    w: BODY_W,
    h: BODY_H,
    anchors: BODY_ANCHORS,
    slots: [SLOT.outline, SLOT.skin, 8, 9, 10, 11, 12],
    garments: [
      { id: "vest", label: "Sleeveless vest", slot: 8, palette: "cloth" },
      { id: "wraps", label: "Forearm wraps", slot: 9, palette: "light" },
      { id: "sash", label: "Waist sash", slot: 10, palette: "accent" },
      { id: "trousers", label: "Baggy trousers", slot: 11, palette: "cloth" },
      { id: "shoes", label: "Shoes", slot: 12, palette: "leather" },
    ],
  },
  {
    id: "body.wayfarer",
    category: "body",
    label: "Wayfarer",
    build: "feminine",
    src: src("body_wayfarer"),
    w: BODY_W,
    h: BODY_H,
    anchors: BODY_ANCHORS,
    slots: [SLOT.outline, SLOT.skin, SLOT.metal, 8, 9, 10, 11, 12],
    garments: [
      { id: "capelet", label: "Capelet", slot: 8, palette: "accent" },
      { id: "dress", label: "Travel dress", slot: 9, palette: "cloth" },
      { id: "belt", label: "Belt", slot: 10, palette: "leather" },
      { id: "leggings", label: "Leggings", slot: 11, palette: "cloth" },
      { id: "boots", label: "Ankle boots", slot: 12, palette: "leather" },
    ],
  },
  {
    id: "body.scout",
    category: "body",
    label: "Scout",
    build: "feminine",
    src: src("body_scout"),
    w: BODY_W,
    h: BODY_H,
    anchors: BODY_ANCHORS,
    slots: [SLOT.outline, SLOT.skin, SLOT.metal, 8, 9, 10, 11, 12, 13],
    garments: [
      { id: "jacket", label: "Cropped jacket", slot: 8, palette: "cloth" },
      { id: "top", label: "Top", slot: 9, palette: "light" },
      { id: "trousers", label: "Fitted trousers", slot: 10, palette: "cloth" },
      { id: "gloves", label: "Gloves", slot: 11, palette: "leather" },
      { id: "boots", label: "Tall boots", slot: 12, palette: "leather" },
      { id: "satchel", label: "Satchel & strap", slot: 13, palette: "leather" },
    ],
  },
];

// Head anchors: `neck` is the bottom-center attach point, `face` where the
// face part's origin goes, `crown` the top of the skull hair hangs from.
const headDef = (id: string, label: string, build: Build): PartDef => ({
  id: `head.${id}`,
  category: "head",
  label,
  build,
  src: src(`head_${id}`),
  w: HEAD_W,
  h: HEAD_H,
  anchors: { neck: [16, 32] as Anchor, face: [4, 10] as Anchor, crown: [16, 2] as Anchor },
  slots: [SLOT.outline, SLOT.skin],
});

export const HEADS: PartDef[] = [
  headDef("square", "Square jaw", "masculine"),
  headDef("angular", "Angular jaw", "masculine"),
  headDef("round", "Round soft", "feminine"),
  headDef("heart", "Heart", "feminine"),
];

const faceDef = (id: string, label: string, build: Build, slots: number[]): PartDef => ({
  id: `face.${id}`,
  category: "face",
  label,
  build,
  src: src(`face_${id}`),
  w: FACE_W * 2,
  h: FACE_H,
  frameW: FACE_W,
  frames: { neutral: 0, grin: 1 },
  anchors: { origin: [0, 0] },
  slots,
});

export const FACES: PartDef[] = [
  faceDef("stern", "Stern", "masculine", [SLOT.outline, SLOT.skin, SLOT.iris, SLOT.sclera, SLOT.mouth, SLOT.brow]),
  faceDef("easy", "Easygoing", "masculine", [SLOT.outline, SLOT.skin, SLOT.iris, SLOT.sclera, SLOT.mouth, SLOT.brow]),
  faceDef("bright", "Bright", "feminine", [SLOT.outline, SLOT.skin, SLOT.iris, SLOT.sclera, SLOT.mouth, SLOT.brow]),
  faceDef("keen", "Keen", "feminine", [SLOT.outline, SLOT.skin, SLOT.iris, SLOT.sclera, SLOT.mouth, SLOT.brow]),
];
export const EXPRESSIONS = ["neutral", "grin"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

const hairDef = (id: string, label: string, length: HairLength): HairDef => ({
  id: `hair.${id}`,
  category: "hair",
  label,
  length,
  w: HAIR_W,
  h: HAIR_H,
  anchors: { crown: [20, 6] as Anchor },
  src: src(`hair_${id}`),
  slots: [SLOT.outline, SLOT.hair],
});

export const HAIRS: HairDef[] = [
  hairDef("crop", "Crop", "short"),
  hairDef("tousled", "Tousled", "short"),
  hairDef("bob", "Bob", "medium"),
  hairDef("shag", "Side-swept shag", "medium"),
  hairDef("mane", "Long straight", "long"),
  hairDef("braid", "Long braid", "long"),
];

// ── palettes ────────────────────────────────────────────────────────────────

export interface Swatch {
  id: string;
  label: string;
  hex: string;
}

/** Natural skin tones, very light → very dark, mixed warm / neutral / cool undertones. */
export const SKIN_TONES: Swatch[] = [
  { id: "porcelain", label: "Porcelain (cool)", hex: "#f6e1d8" },
  { id: "ivory", label: "Ivory (neutral)", hex: "#f3dcc3" },
  { id: "rose", label: "Rose (cool)", hex: "#eac2b0" },
  { id: "peach", label: "Peach (warm)", hex: "#efc39c" },
  { id: "beige", label: "Beige (neutral)", hex: "#dcb48e" },
  { id: "olive", label: "Olive (cool-green)", hex: "#c9a77d" },
  { id: "honey", label: "Honey (warm)", hex: "#d19a66" },
  { id: "tan", label: "Tan (neutral)", hex: "#b88560" },
  { id: "bronze", label: "Bronze (warm)", hex: "#a8703f" },
  { id: "chestnut", label: "Chestnut (cool)", hex: "#8e5a43" },
  { id: "umber", label: "Umber (neutral)", hex: "#7a4a2e" },
  { id: "mahogany", label: "Mahogany (warm-red)", hex: "#6b3a28" },
  { id: "cocoa", label: "Cocoa (cool)", hex: "#5e3a2b" },
  { id: "espresso", label: "Espresso (neutral)", hex: "#4f3123" },
  { id: "ebony", label: "Ebony (cool)", hex: "#45291f" },
];

/** Natural hair colors: blacks, browns, blonds, reds, grays, white. */
export const HAIR_COLORS: Swatch[] = [
  { id: "jet", label: "Jet black", hex: "#1f1a1f" },
  { id: "soft_black", label: "Soft black", hex: "#2e2522" },
  { id: "dark_brown", label: "Dark brown", hex: "#43301f" },
  { id: "chestnut", label: "Chestnut", hex: "#6b4026" },
  { id: "light_brown", label: "Light brown", hex: "#8d6440" },
  { id: "dark_blond", label: "Dark blond", hex: "#a98450" },
  { id: "golden", label: "Golden blond", hex: "#d6ac5c" },
  { id: "platinum", label: "Platinum blond", hex: "#e8d9ae" },
  { id: "auburn", label: "Auburn", hex: "#7f3420" },
  { id: "copper", label: "Copper red", hex: "#b4532a" },
  { id: "ginger", label: "Ginger", hex: "#d07a3a" },
  { id: "ash", label: "Ash gray", hex: "#8a8580" },
  { id: "silver", label: "Silver", hex: "#b9b7b4" },
  { id: "white", label: "White", hex: "#ece8e2" },
];

export const EYE_COLORS: Swatch[] = [
  { id: "brown", label: "Brown", hex: "#5a3a22" },
  { id: "dark", label: "Dark brown", hex: "#3a2618" },
  { id: "hazel", label: "Hazel", hex: "#7a6a32" },
  { id: "green", label: "Green", hex: "#3f7a4a" },
  { id: "blue", label: "Blue", hex: "#3d6aa8" },
  { id: "gray", label: "Gray", hex: "#6c7a86" },
  { id: "amber", label: "Amber", hex: "#a8702a" },
];

/** Garment dyes, grouped by what each garment kind may plausibly be made of. */
export const OUTFIT_COLORS: Record<PaletteKind, Swatch[]> = {
  cloth: [
    { id: "crimson", label: "Crimson", hex: "#9c2f35" },
    { id: "rust", label: "Rust", hex: "#a5532c" },
    { id: "ochre", label: "Ochre", hex: "#b8892f" },
    { id: "olive", label: "Olive", hex: "#6b6e34" },
    { id: "moss", label: "Moss", hex: "#4f6a3a" },
    { id: "forest", label: "Forest", hex: "#2f5a3f" },
    { id: "teal", label: "Teal", hex: "#2e6e6a" },
    { id: "slate", label: "Slate blue", hex: "#4b5f80" },
    { id: "navy", label: "Navy", hex: "#2b3a5c" },
    { id: "indigo", label: "Indigo", hex: "#3f3a6e" },
    { id: "plum", label: "Plum", hex: "#5e3352" },
    { id: "burgundy", label: "Burgundy", hex: "#5f2430" },
    { id: "charcoal", label: "Charcoal", hex: "#35353a" },
    { id: "stone", label: "Stone gray", hex: "#77736c" },
    { id: "sand", label: "Sand", hex: "#b9a37a" },
    { id: "umber", label: "Umber", hex: "#6a4a30" },
  ],
  light: [
    { id: "linen", label: "Linen", hex: "#e6dcc4" },
    { id: "cream", label: "Cream", hex: "#efe4c8" },
    { id: "bone", label: "Bone", hex: "#d8d2c2" },
    { id: "pale_sky", label: "Pale sky", hex: "#b9cad6" },
    { id: "sage", label: "Sage", hex: "#b2bf9a" },
    { id: "blush", label: "Blush", hex: "#d9aea0" },
    { id: "straw", label: "Straw", hex: "#d9c386" },
    { id: "ash", label: "Ash", hex: "#a7a39c" },
  ],
  leather: [
    { id: "tan", label: "Tan leather", hex: "#a8743f" },
    { id: "saddle", label: "Saddle brown", hex: "#7a4a26" },
    { id: "dark_leather", label: "Dark leather", hex: "#4a3020" },
    { id: "black_leather", label: "Black leather", hex: "#2a2224" },
    { id: "oxblood", label: "Oxblood", hex: "#5e2522" },
    { id: "suede", label: "Gray suede", hex: "#6e665c" },
  ],
  accent: [
    { id: "scarlet", label: "Scarlet", hex: "#c23a2e" },
    { id: "saffron", label: "Saffron", hex: "#d9922a" },
    { id: "gold", label: "Gold", hex: "#c9a227" },
    { id: "jade", label: "Jade", hex: "#3f9a6a" },
    { id: "cerulean", label: "Cerulean", hex: "#3a7ab8" },
    { id: "violet", label: "Violet", hex: "#6a4a9a" },
    { id: "rosewood", label: "Rosewood", hex: "#a24a5a" },
    { id: "ink", label: "Ink", hex: "#262a3a" },
    { id: "ivory", label: "Ivory", hex: "#e8dfc8" },
  ],
};

/** Fixed (non-recolorable) region colors. */
export const OUTLINE_RGB: Rgb = [34, 23, 28];
const SCLERA_HEX = "#f2ece2";
const METAL_HEX = "#c9a24a";

// ── color math ──────────────────────────────────────────────────────────────

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === R ? (G - B) / d + (G < B ? 6 : 0) : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Hue-shift toward a target hue by up to `deg` degrees. */
function shiftHue(h: number, target: number, deg: number): number {
  const d = ((target - h + 540) % 360) - 180;
  return h + Math.sign(d) * Math.min(Math.abs(d), deg);
}

/**
 * An 8-step pixel-art ramp from one base color: smooth hue-shifted shadow →
 * highlight. Shadows lean cooler and richer, highlights warmer — the classic
 * pixel-art ramp — so recolors keep the art's lighting.
 * Every ramp is strictly increasing in luminance (validated by tests).
 */
export function ramp(hex: string): Rgb[] {
  const base = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(base);
  // HSL saturation overstates the chroma of pale colors: cap every step by the
  // base's real chroma so porcelain skin or cream cloth shades into soft tones
  // instead of saturated pinks.
  const chroma = s * (1 - Math.abs(2 * l - 1));
  const capSat = (sat: number, lt: number) => Math.min(Math.max(0, sat), (chroma * 1.25 + 0.02) / Math.max(0.05, 1 - Math.abs(2 * lt - 1)));
  const L = [0.3, 0.44, 0.58, 0.72, 1, 1.14, 1.27, 1.4];
  const HUE = [26, 19, 13, 7, 0, 7, 13, 19];
  const SAT: number[] = [1.05, 1.05, 1.03, 1.02, 1, 0.97, 0.94, 0.9];
  const out: Rgb[] = L.map((lm, i) => {
    const lt = Math.min(0.985, Math.max(0.015, i < 4 ? l * lm - 0.01 : i === 4 ? l : l + (1 - l) * ((lm - 1) / 0.4) * 0.9 + 0.02));
    return hslToRgb(shiftHue(h, i < 4 ? 300 : 55, HUE[i]), capSat(s * SAT[i] + (i < 4 ? 0.04 : -0.02), lt), lt);
  });
  out[4] = base.slice() as Rgb;
  // enforce strict monotonic luminance (very dark / very light bases)
  for (let i = 1; i < 8; i++) {
    if (luma(out[i]) <= luma(out[i - 1])) out[i] = out[i].map((c) => Math.min(255, c + 6 + i * 3)) as Rgb;
  }
  for (let i = 6; i >= 0; i--) {
    if (luma(out[i]) >= luma(out[i + 1])) out[i] = out[i].map((c) => Math.max(0, c - 6 - (7 - i) * 3)) as Rgb;
  }
  return out;
}

export function luma([r, g, b]: Rgb): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Perceptual-ish distance (redmean weighted RGB), 0..~765. */
export function colorDistance(a: Rgb, b: Rgb): number {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

// ── appearance data ─────────────────────────────────────────────────────────

/** A rival's look — presentation only, never read by gameplay. */
export interface TamerLook {
  v: number;
  body: string;
  head: string;
  face: string;
  hair: string;
  skin: string;
  hairColor: string;
  eyes: string;
  /** Garment id (of the selected body) → outfit swatch id. */
  outfit: Record<string, string>;
  expression: Expression;
  /** The seed the look was rolled from (provenance; regeneration is deterministic). */
  seed: number;
}

const byId = <T extends { id: string }>(xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]));
const BODY_BY_ID = byId(BODIES);
const HEAD_BY_ID = byId(HEADS);
const FACE_BY_ID = byId(FACES);
const HAIR_BY_ID = byId(HAIRS);
const SKIN_BY_ID = byId(SKIN_TONES);
const HAIRC_BY_ID = byId(HAIR_COLORS);
const EYE_BY_ID = byId(EYE_COLORS);
const OUTFIT_BY_KIND: Record<PaletteKind, Map<string, Swatch>> = {
  cloth: byId(OUTFIT_COLORS.cloth),
  light: byId(OUTFIT_COLORS.light),
  leather: byId(OUTFIT_COLORS.leather),
  accent: byId(OUTFIT_COLORS.accent),
};

export const bodyDef = (id: string): PartDef | undefined => BODY_BY_ID.get(id);
export const headDefOf = (id: string): PartDef | undefined => HEAD_BY_ID.get(id);
export const faceDefOf = (id: string): PartDef | undefined => FACE_BY_ID.get(id);
export const hairDefOf = (id: string): HairDef | undefined => HAIR_BY_ID.get(id);
export const skinSwatch = (id: string): Swatch | undefined => SKIN_BY_ID.get(id);
export const hairSwatch = (id: string): Swatch | undefined => HAIRC_BY_ID.get(id);
export const eyeSwatch = (id: string): Swatch | undefined => EYE_BY_ID.get(id);
export const outfitSwatch = (kind: PaletteKind, id: string): Swatch | undefined => OUTFIT_BY_KIND[kind].get(id);

/** The canonical fallback look — every id is a registered asset. */
export function defaultLook(): TamerLook {
  const body = BODIES[0];
  const outfit: Record<string, string> = {};
  const picks: Record<PaletteKind, number> = { cloth: 0, light: 0, leather: 0, accent: 0 };
  for (const g of body.garments ?? []) {
    const list = OUTFIT_COLORS[g.palette];
    // spread defaults through each list so neighbors never share a dye
    outfit[g.id] = list[(picks[g.palette]++ * 5 + (g.palette === "cloth" ? 8 : 1)) % list.length].id;
  }
  return {
    v: LOOK_VERSION,
    body: body.id,
    head: HEADS[0].id,
    face: FACES[0].id,
    hair: HAIRS[0].id,
    skin: SKIN_TONES[6].id,
    hairColor: HAIR_COLORS[2].id,
    eyes: EYE_COLORS[0].id,
    outfit,
    expression: "neutral",
    seed: 0,
  };
}

/** Minimum separation between regions that touch on the sprite. */
const MIN_SEP_SKIN = 70;
const MIN_SEP_HAIR = 60;
const MIN_SEP_GARMENT = 58;

/**
 * Roll a full look from a seed. Every structural choice is independent (any
 * body with any head, face and hair — no gender lock), and colors follow
 * readability rules: hair must stand off skin, each garment must stand off
 * skin, hair and every garment chosen before it. Deterministic per seed.
 */
export function generateLook(seed: number): TamerLook {
  const rng = new Rng(hash2(seed, 0x10c4, 0x7a3e) || 1);
  const pick = <T>(xs: T[]): T => xs[rng.int(0, xs.length - 1)];
  const body = pick(BODIES);
  const head = pick(HEADS);
  const face = pick(FACES);
  const hair = pick(HAIRS);
  const skin = pick(SKIN_TONES);
  const skinRgb = hexToRgb(skin.hex);
  // hair: retry for contrast with skin (blond on porcelain, black on ebony)
  let hairC = pick(HAIR_COLORS);
  for (let k = 0; k < 12 && colorDistance(hexToRgb(hairC.hex), skinRgb) < MIN_SEP_HAIR; k++) hairC = pick(HAIR_COLORS);
  const eyes = pick(EYE_COLORS);
  const taken: Rgb[] = [skinRgb, hexToRgb(hairC.hex)];
  const outfit: Record<string, string> = {};
  for (const g of body.garments ?? []) {
    const list = OUTFIT_COLORS[g.palette];
    let best = pick(list);
    let bestScore = -1;
    for (let k = 0; k < 14; k++) {
      const c = k === 0 ? best : pick(list);
      const rgb = hexToRgb(c.hex);
      const score = Math.min(
        colorDistance(rgb, skinRgb) - MIN_SEP_SKIN,
        ...taken.slice(1).map((t) => colorDistance(rgb, t) - MIN_SEP_GARMENT),
      );
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
      if (score >= 0) break;
    }
    outfit[g.id] = best.id;
    taken.push(hexToRgb(best.hex));
  }
  return {
    v: LOOK_VERSION,
    body: body.id,
    head: head.id,
    face: face.id,
    hair: hair.id,
    skin: skin.id,
    hairColor: hairC.id,
    eyes: eyes.id,
    outfit,
    expression: "neutral",
    seed,
  };
}

/** The look seed for a rival: its own stream, independent of gameplay rng. */
export function lookSeedFor(worldSeed: number, tamerId: string): number {
  let h = 0x9e3779b1 ^ worldSeed;
  for (let i = 0; i < tamerId.length; i++) h = Math.imul(h ^ tamerId.charCodeAt(i), 0x85ebca6b) >>> 0;
  return hash2(h, 0x5eed, 0x100c) >>> 0;
}

/**
 * Repair a stored look so it only names registered assets and swatches.
 * Unknown ids fall back to the default part; missing garments are filled
 * from the default palette of their kind; foreign garment keys are dropped
 * so a garment color can never leak onto another region. Returns a new
 * object; `ok` reports whether anything had to change.
 */
export function resolveLook(raw: unknown): { look: TamerLook; ok: boolean } {
  const d = defaultLook();
  if (!raw || typeof raw !== "object") return { look: d, ok: false };
  const r = raw as Partial<TamerLook>;
  let ok = true;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const body = bodyDef(str(r.body)) ?? (((ok = false), BODIES[0]));
  const head = headDefOf(str(r.head)) ? str(r.head) : ((ok = false), d.head);
  const face = faceDefOf(str(r.face)) ? str(r.face) : ((ok = false), d.face);
  const hair = hairDefOf(str(r.hair)) ? str(r.hair) : ((ok = false), d.hair);
  const skin = skinSwatch(str(r.skin)) ? str(r.skin) : ((ok = false), d.skin);
  const hairColor = hairSwatch(str(r.hairColor)) ? str(r.hairColor) : ((ok = false), d.hairColor);
  const eyes = eyeSwatch(str(r.eyes)) ? str(r.eyes) : ((ok = false), d.eyes);
  const expression = (EXPRESSIONS as readonly string[]).includes(str(r.expression)) ? (r.expression as Expression) : ((ok = false), "neutral" as Expression);
  const rawOutfit = r.outfit && typeof r.outfit === "object" ? (r.outfit as Record<string, unknown>) : ((ok = false), {});
  const outfit: Record<string, string> = {};
  (body.garments ?? []).forEach((g, i) => {
    const v = str(rawOutfit[g.id]);
    if (outfitSwatch(g.palette, v)) outfit[g.id] = v;
    else {
      ok = false;
      const list = OUTFIT_COLORS[g.palette];
      outfit[g.id] = list[(i * 5 + 3) % list.length].id;
    }
  });
  if (Object.keys(rawOutfit).some((k) => !(body.garments ?? []).some((g) => g.id === k))) ok = false;
  const seed = typeof r.seed === "number" && Number.isFinite(r.seed) ? r.seed : ((ok = false), 0);
  return {
    look: { v: LOOK_VERSION, body: body.id, head, face, hair, skin, hairColor, eyes, outfit, expression, seed },
    ok,
  };
}

/** Stable cache key for a look (structure + every color). */
export function lookKey(l: TamerLook): string {
  const o = Object.keys(l.outfit).sort().map((k) => `${k}=${l.outfit[k]}`).join(",");
  return `${l.body}|${l.head}|${l.face}|${l.hair}|${l.skin}|${l.hairColor}|${l.eyes}|${l.expression}|${o}`;
}

// ── decoded parts & validation ──────────────────────────────────────────────

/** A decoded region-indexed part: one slot and shade per pixel, 255 = empty. */
export interface PartMap {
  w: number;
  h: number;
  slot: Uint8Array;
  shade: Uint8Array;
}

/** Decode RGBA pixels (any source: canvas or PNG decoder) into a part map. */
export function decodePart(w: number, h: number, rgba: ArrayLike<number>): { map: PartMap; foreign: number } {
  const slot = new Uint8Array(w * h).fill(255);
  const shade = new Uint8Array(w * h);
  let foreign = 0;
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3];
    if (a < 128) continue;
    const b = rgba[i * 4 + 2];
    if (b < 64 || b > 192) {
      foreign++;
      continue;
    }
    slot[i] = rgba[i * 4] >> 4;
    shade[i] = Math.min(SHADES - 1, rgba[i * 4 + 1] >> 5);
  }
  return { map: { w, h, slot, shade }, foreign };
}

/** Every registered file, with the part it belongs to (for loading & validation). */
export interface AssetFile {
  src: string;
  partId: string;
  category: PartCategory;
  layer?: "back" | "front";
  w: number;
  h: number;
  slots: number[];
}

export function assetFiles(): AssetFile[] {
  const out: AssetFile[] = [];
  for (const p of [...BODIES, ...HEADS, ...FACES]) out.push({ src: p.src, partId: p.id, category: p.category, w: p.w, h: p.h, slots: p.slots });
  for (const h of HAIRS) out.push({ src: h.src, partId: h.id, category: "hair", layer: "front", w: h.w, h: h.h, slots: h.slots });
  return out;
}

/**
 * Validate the registry itself (no files needed): unique ids, anchors in
 * bounds, garment slots unique / in range / never a fixed slot, faces with a
 * neutral frame. Returns human-readable problems (empty = valid).
 */
export function validateRegistry(): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const all: { id: string; w: number; h: number; anchors: Record<string, Anchor> }[] = [...BODIES, ...HEADS, ...FACES, ...HAIRS];
  for (const p of all) {
    if (ids.has(p.id)) errs.push(`duplicate asset id ${p.id}`);
    ids.add(p.id);
    for (const [k, [x, y]] of Object.entries(p.anchors)) if (x < 0 || y < 0 || x > p.w || y > p.h) errs.push(`${p.id}: anchor ${k} out of bounds`);
  }
  const need: [PartDef[], string[]][] = [
    [BODIES, ["feet", "neck"]],
    [HEADS, ["neck", "face", "crown"]],
    [FACES, ["origin"]],
  ];
  for (const [list, keys] of need) for (const p of list) for (const k of keys) if (!p.anchors[k]) errs.push(`${p.id}: missing anchor ${k}`);
  for (const h of HAIRS) if (!h.anchors.crown) errs.push(`${h.id}: missing anchor crown`);
  for (const b of BODIES) {
    const gs = b.garments ?? [];
    if (!gs.length) errs.push(`${b.id}: no garment regions`);
    const slots = new Set<number>();
    const gids = new Set<string>();
    for (const g of gs) {
      if (g.slot < GARMENT_SLOT_MIN || g.slot > GARMENT_SLOT_MAX) errs.push(`${b.id}: garment ${g.id} uses non-garment slot ${g.slot}`);
      if (slots.has(g.slot)) errs.push(`${b.id}: garments share slot ${g.slot}`);
      if (gids.has(g.id)) errs.push(`${b.id}: duplicate garment id ${g.id}`);
      if (!OUTFIT_COLORS[g.palette]) errs.push(`${b.id}: garment ${g.id} has unknown palette ${g.palette}`);
      if (!b.slots.includes(g.slot)) errs.push(`${b.id}: garment ${g.id} slot ${g.slot} not declared`);
      slots.add(g.slot);
      gids.add(g.id);
    }
    for (const s of b.slots) if (s >= GARMENT_SLOT_MIN && !slots.has(s)) errs.push(`${b.id}: slot ${s} declared but not named by any garment`);
    if (!b.slots.includes(SLOT.skin)) errs.push(`${b.id}: body has no skin region`);
  }
  for (const h of HEADS) if (!h.slots.includes(SLOT.skin)) errs.push(`${h.id}: head has no skin region`);
  for (const f of FACES) {
    if (f.frames?.neutral !== 0) errs.push(`${f.id}: neutral expression must be frame 0`);
    if (!f.frameW || f.w !== f.frameW * Object.keys(f.frames ?? {}).length) errs.push(`${f.id}: frame layout does not match width`);
  }
  for (const h of HAIRS) if (h.slots.some((s) => s !== SLOT.outline && s !== SLOT.hair)) errs.push(`${h.id}: hair may only use outline and hair slots`);
  const palettes: [string, Swatch[]][] = [["skin", SKIN_TONES], ["hair", HAIR_COLORS], ["eyes", EYE_COLORS], ...Object.entries(OUTFIT_COLORS)];
  for (const [name, list] of palettes) {
    const sw = new Set<string>();
    for (const s of list) {
      if (!/^#[0-9a-f]{6}$/i.test(s.hex)) errs.push(`palette ${name}: bad hex ${s.hex}`);
      if (sw.has(s.id)) errs.push(`palette ${name}: duplicate swatch ${s.id}`);
      sw.add(s.id);
    }
  }
  return errs;
}

/** Validate one decoded file against its registry entry. */
export function validatePart(file: AssetFile, w: number, h: number, decoded: { map: PartMap; foreign: number }): string[] {
  const errs: string[] = [];
  if (w !== file.w || h !== file.h) errs.push(`${file.src}: ${w}×${h}, expected ${file.w}×${file.h}`);
  if (decoded.foreign) errs.push(`${file.src}: ${decoded.foreign} pixels are not region-encoded`);
  const seen = new Set<number>();
  for (const s of decoded.map.slot) if (s !== 255) seen.add(s);
  for (const s of seen) if (!file.slots.includes(s)) errs.push(`${file.src}: undeclared region slot ${s}`);
  for (const s of file.slots) if (!seen.has(s)) errs.push(`${file.src}: declared region slot ${s} has no pixels`);
  return errs;
}

// ── composition ─────────────────────────────────────────────────────────────

/** Where each look's regions resolve to on the output (for isolation tests). */
export type RegionTag = string;

export interface Composed {
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  /** Per pixel: the region that produced it ("" = transparent). */
  region: RegionTag[];
  /** Per pixel: which layer drew it last ("" = none). */
  layer: string[];
  missing: string[];
}

export type PartSource = (src: string) => PartMap | null | undefined;

interface Placement {
  map: PartMap;
  ox: number;
  oy: number;
  /** Faces: horizontal frame offset inside the sheet. */
  fx: number;
  fw: number;
  layer: string;
  body?: PartDef;
}

/** Sprite-space origin of every layer for a structural combination. */
export function layout(body: PartDef, head: PartDef, hair: HairDef): { body: Anchor; head: Anchor; face: Anchor; hair: Anchor } {
  const bo: Anchor = [SPRITE_FEET[0] - body.anchors.feet[0], SPRITE_FEET[1] - body.anchors.feet[1]];
  const neck: Anchor = [bo[0] + body.anchors.neck[0], bo[1] + body.anchors.neck[1]];
  const ho: Anchor = [neck[0] - head.anchors.neck[0], neck[1] - head.anchors.neck[1]];
  const fo: Anchor = [ho[0] + head.anchors.face[0], ho[1] + head.anchors.face[1]];
  const crown: Anchor = [ho[0] + head.anchors.crown[0], ho[1] + head.anchors.crown[1]];
  const hro: Anchor = [crown[0] - hair.anchors.crown[0], crown[1] - hair.anchors.crown[1]];
  return { body: bo, head: ho, face: fo, hair: hro };
}

/** The palette ramp each slot resolves to for a look (garments via the body). */
export function slotRamps(look: TamerLook, body: PartDef): (Rgb[] | null)[] {
  const skin = ramp(skinSwatch(look.skin)?.hex ?? SKIN_TONES[6].hex);
  const hair = ramp(hairSwatch(look.hairColor)?.hex ?? HAIR_COLORS[2].hex);
  const eyes = ramp(eyeSwatch(look.eyes)?.hex ?? EYE_COLORS[0].hex);
  const skinBase = hexToRgb(skinSwatch(look.skin)?.hex ?? SKIN_TONES[6].hex);
  // lips: the skin's own shadow pushed toward rose, so every tone gets a mouth that belongs to it
  const [sh, ss, sl] = rgbToHsl(skinBase);
  // deep tones read their lips lighter than the skin, light tones darker: the mouth always separates
  const lipL = sl < 0.36 ? Math.min(0.62, sl * 1.35 + 0.08) : sl * 0.62;
  const mouthHex = rgbHex(hslToRgb(shiftHue(sh, 355, 14), Math.min(sl > 0.75 ? 0.42 : 0.6, ss + 0.12), lipL));
  // brows / beard: the hair color, one step darker
  const brow = [hair[0], hair[0], hair[1], hair[1], hair[2], hair[2], hair[3], hair[3]];
  const out: (Rgb[] | null)[] = new Array(16).fill(null);
  out[SLOT.outline] = [OUTLINE_RGB, OUTLINE_RGB, OUTLINE_RGB, OUTLINE_RGB];
  out[SLOT.skin] = skin;
  out[SLOT.hair] = hair;
  out[SLOT.iris] = eyes;
  out[SLOT.sclera] = ramp(SCLERA_HEX);
  out[SLOT.mouth] = ramp(mouthHex);
  out[SLOT.brow] = brow;
  out[SLOT.metal] = ramp(METAL_HEX);
  for (const g of body.garments ?? []) {
    const sw = outfitSwatch(g.palette, look.outfit[g.id] ?? "") ?? OUTFIT_COLORS[g.palette][0];
    out[g.slot] = ramp(sw.hex);
  }
  return out;
}

function rgbHex([r, g, b]: Rgb): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/** Region tag for a slot in a given layer (garments carry their garment id). */
function regionTag(slot: number, body: PartDef | undefined, layer: string): RegionTag {
  switch (slot) {
    case SLOT.outline: return "outline";
    case SLOT.skin: return "skin";
    case SLOT.hair: return "hair";
    case SLOT.iris: return "iris";
    case SLOT.sclera: return "sclera";
    case SLOT.mouth: return "mouth";
    case SLOT.brow: return "brow";
    case SLOT.metal: return "metal";
    default: {
      const g = body?.garments?.find((x) => x.slot === slot);
      return g ? `garment:${g.id}` : `invalid:${layer}:${slot}`;
    }
  }
}

/**
 * Assemble a complete static sprite. Pure: parts come from `getPart` (a
 * canvas decoder in the browser, a PNG decoder in tests). Missing optional
 * layers are skipped (listed in `missing`); an invalid look is repaired with
 * `resolveLook` first. Pixels of an undeclared slot are never painted.
 */
export function composeLook(rawLook: TamerLook, getPart: PartSource): Composed {
  const look = resolveLook(rawLook).look;
  const body = bodyDef(look.body) ?? BODIES[0];
  const head = headDefOf(look.head) ?? HEADS[0];
  const face = faceDefOf(look.face) ?? FACES[0];
  const hair = hairDefOf(look.hair) ?? HAIRS[0];
  const pos = layout(body, head, hair);
  const missing: string[] = [];
  const layers: Placement[] = [];
  const add = (srcPath: string | null, o: Anchor, layer: string, fx = 0, fw = 0, b?: PartDef): void => {
    if (!srcPath) return;
    const map = getPart(srcPath);
    if (!map) {
      missing.push(srcPath);
      return;
    }
    layers.push({ map, ox: o[0], oy: o[1], fx, fw: fw || map.w, layer, body: b });
  };
  const frame = face.frames?.[look.expression] ?? 0;
  add(body.src, pos.body, "body", 0, 0, body);
  add(head.src, pos.head, "head");
  add(face.src, pos.face, "face", frame * (face.frameW ?? FACE_W), face.frameW ?? FACE_W);
  add(hair.src, pos.hair, "hair-front");

  const ramps = slotRamps(look, body);
  const allowed: Record<string, Set<number>> = {
    body: new Set(body.slots),
    head: new Set(head.slots),
    face: new Set(face.slots),
    "hair-front": new Set(hair.slots),
  };
  const W = SPRITE_W, H = SPRITE_H;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const region: RegionTag[] = new Array(W * H).fill("");
  const layer: string[] = new Array(W * H).fill("");
  for (const L of layers) {
    const ok = allowed[L.layer];
    for (let y = 0; y < L.map.h; y++) {
      const sy = L.oy + y;
      if (sy < 0 || sy >= H) continue;
      for (let x = 0; x < L.fw; x++) {
        const sx = L.ox + x;
        if (sx < 0 || sx >= W) continue;
        const i = y * L.map.w + L.fx + x;
        const s = L.map.slot[i];
        if (s === 255 || !ok.has(s)) continue;
        const r = ramps[s];
        if (!r) continue;
        const c = r[L.map.shade[i]];
        const o = sy * W + sx;
        rgba[o * 4] = c[0];
        rgba[o * 4 + 1] = c[1];
        rgba[o * 4 + 2] = c[2];
        rgba[o * 4 + 3] = 255;
        region[o] = regionTag(s, L.body ?? body, L.layer);
        layer[o] = L.layer;
      }
    }
  }
  return { w: W, h: H, rgba, region, layer, missing };
}

/** How many distinct looks the registry can express structurally (bodies × heads × faces × hairs). */
export const STRUCTURAL_COMBINATIONS = BODIES.length * HEADS.length * FACES.length * HAIRS.length;

/** The silhouette signature two rivals must not share (structure + hair color). */
export function lookSilhouette(l: TamerLook): string {
  return `${l.body}|${l.head}|${l.hair}|${l.hairColor}`;
}

/**
 * The persistent look for a rival, distinct from every look already in
 * `taken` (silhouette signatures). Re-rolls deterministically from the
 * tamer's own look seed, so the same world and roster always produce the
 * same appearances. Adds the chosen signature to `taken`.
 */
export function assignLook(worldSeed: number, tamerId: string, taken: Set<string>): TamerLook {
  const base = lookSeedFor(worldSeed, tamerId);
  let look = generateLook(base);
  for (let k = 1; k < 64 && taken.has(lookSilhouette(look)); k++) look = generateLook(hash2(base, k, 0x51d) >>> 0);
  taken.add(lookSilhouette(look));
  return look;
}

/**
 * Give every tamer in a roster a valid look, in id order: valid stored looks
 * are kept exactly (an appearance never changes once rolled), damaged ones
 * are repaired field by field, missing ones are rolled. Idempotent. Returns
 * how many tamers changed.
 */
export function ensureRosterLooks(worldSeed: number, tamers: Record<string, { id: string; look?: TamerLook }>): number {
  const ids = Object.keys(tamers).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const taken = new Set<string>();
  const pending: string[] = [];
  let changed = 0;
  for (const id of ids) {
    const t = tamers[id];
    if (t.look === undefined || t.look === null) {
      pending.push(id);
      continue;
    }
    const { look, ok } = resolveLook(t.look);
    if (!ok) {
      t.look = look;
      changed++;
    }
    taken.add(lookSilhouette(t.look));
  }
  for (const id of pending) {
    tamers[id].look = assignLook(worldSeed, id, taken);
    changed++;
  }
  return changed;
}
