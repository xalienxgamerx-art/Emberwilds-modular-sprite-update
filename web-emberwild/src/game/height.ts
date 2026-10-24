/**
 * Height — the single authority for vertical terrain.
 *
 * Surface levels (terraces), slopes (ramps), cliffs, carved riverbeds and
 * canyons, cave mouths and the two underground cave layers are all pure
 * functions of the world seed, layered on top of the existing `elevation()`
 * field. Nothing here is persisted: saves only remember which layer the player
 * (and the live creatures around them) stand on.
 *
 * Every rule that cares about height (movement, falls, sight, combat edge,
 * pathfinding, rendering) asks this module — no system derives levels itself.
 */
import { TwoGenCache } from "./cache";
import { BIOMES, SPECIES, WORLD_SIZE, footprintOf } from "./data";
import { bodyFootprint } from "./growth";
import { Perlin, clamp, hash01, hash2 } from "./rng";
import type { BiomeId, GameState } from "./types";
import type { World } from "./world";
import { roadAt } from "./roads";
import { objectAt } from "./objects";

/* ---------------------------------- Layers ----------------------------------- */

export const SURFACE = 0;
export const CAVE_UPPER = -1;
export const CAVE_DEEP = -2;
/** The sky: one full layer above the surface, home of flying creatures. */
export const SKY = 1;
/** The underwater floor beneath deep open water — home of diving swimmers. */
export const UW = -3;

/* ---------------------------------- Config ----------------------------------- */

/** Elevation span of one terrace level (sea level is 0.5). */
export const LEVEL_BAND = 0.036;
/** Max representable level (packed into 8 bits). */
const LEVEL_MAX = 63;
/** Landmarks sit on a flattened plateau of this chebyshev radius… */
export const PIN_CORE = 6;
/** …and every edge inside this radius is a gentle slope (never a cliff); levels climb at most one per tile outward. */
export const PIN_RAMP = 11;
/** Ramp noise: lower thresholds mean more slopes, fewer cliffs. */
export const RAMP_SCALE = 18;
export const RAMP_THRESHOLD = -0.06;
export const RAMP_THRESHOLD_ROCKY = 0.08;
const ROCKY: ReadonlySet<BiomeId> = new Set<BiomeId>(["mountain", "peak", "snow"]);
/** Canyons: winding ridged-noise cuts through uplands, stepped core → rim. */
export const CANYON_SCALE = 300;
export const CANYON_MASK_SCALE = 700;
export const CANYON_MASK_MIN = 0.04;
/** Canyons taper over this much mask strength, so their ends step down gently instead of ending in a sheer wall. */
export const CANYON_MASK_RAMP = 0.08;
/** |noise| below each width cuts that many levels (core 3, mid 2, rim 1). */
export const CANYON_BANDS = [0.007, 0.014, 0.021] as const;
export const CANYON_MIN_LEVEL = 4;
/** Trails: the only places canyon walls become slopes. */
export const TRAIL_SCALE = 46;
export const TRAIL_THRESHOLD = 0.2;
/** Away from trails, canyon walls still crumble into the odd scree slope. */
export const CANYON_SCREE_THRESHOLD = 0.3;
/** Cave mouths: at most one per cell, set into a south-facing cliff foot. */
export const MOUTH_CELL = 32;
export const MOUTH_CHANCE = 0.85;
const MOUTH_SCAN = 22;
/** Deep shafts: at most one per cell, linking the two cave layers. */
export const SHAFT_CELL = 56;
export const SHAFT_CHANCE = 0.7;
const SHAFT_SCAN = 12;
/** Every cave entry is ringed by a chamber and crossed by two corridors, so it always opens onto the tunnels. */
export const ENTRY_R = 4;
export const CORRIDOR_LEN = 26;
const CORRIDOR_WOBBLE = 2;
const CAVE_SHAPE = [
  { tunnelScale: 24, tunnelWidth: 0.075, chamberScale: 48, chamberMin: 0.3 },
  { tunnelScale: 30, tunnelWidth: 0.065, chamberScale: 40, chamberMin: 0.24 },
] as const;
/** Sight. */
export const CAVE_SIGHT = 4;
export const EYE_HEIGHT = 0.6;
export const TARGET_HEIGHT = 0.5;
/** Icy spires stand this much taller than their level for sight. */
export const PEAK_SIGHT_BONUS = 1;
/** Extra sight radius per level of prominence. */
export const PROMINENCE_SIGHT = 2;
export const PROMINENCE_R = 4;
export const PROMINENCE_CAP = 3;
/** Combat: to-hit edge per level of height advantage, capped. */
export const HIGH_GROUND_ACC = 2;
export const HIGH_GROUND_CAP = 2;
/** Falls: damage per level beyond the first (fraction of max HP), and time lost. */
export const FALL_DAMAGE_FRAC = 0.12;
export const FALL_TIME = 3;
/** Extra movement cost per level climbed (heavy bodies pay double). */
export const UPHILL_COST = 1;
/** Ticks the player spends hauling up onto an icy peak. */
export const PEAK_CLIMB_COST = 6;
/** Party monsters this far from the player regroup at their side. */
export const PARTY_REGROUP = 14;
/** Knockback triggers on crits or hits worth this fraction of max HP. */
export const KNOCKBACK_FRAC = 0.25;
const CACHE_MAX = 250000;

/* ---------------------------------- Packing ---------------------------------- */

const F_WATER = 1 << 8; // sea, deep, lake or riverbed
const F_SWIM = 1 << 9; // unwalkable water (sea, deep, lake): exempt from step rules
const F_CANYON = 1 << 10;
const F_PINZONE = 1 << 11; // inside a landmark's gentle zone

const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
const N8: readonly [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const N4: readonly [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/* --------------------------------- Movers ------------------------------------ */

/** How a body handles height and medium. */
export interface Mover {
  /** Ignores levels entirely (no climbs, no falls). */
  flies: boolean;
  /** Scales cliffs freely, up and down, without falling. */
  climbs: boolean;
  /** Big bodies: uphill costs double. */
  heavy: boolean;
  /** Cave dwellers that come up through cave mouths. */
  burrows: boolean;
  /** Swimmers can dive from deep water to the underwater layer and back. */
  swims: boolean;
}

export const PLAYER_MOVER: Mover = { flies: false, climbs: false, heavy: false, burrows: false, swims: false };

/** Extra climbers beyond the Bug family (which all scale rock). */
const CLIMBER_IDS: ReadonlySet<string> = new Set(["frostnib"]);
const moverCache = new Map<string, Mover>();

/** Height traits of a species, derived from existing species data. */
export function moverOf(speciesId: string): Mover {
  const c = moverCache.get(speciesId);
  if (c) return c;
  const sp = SPECIES[speciesId];
  if (!sp) return PLAYER_MOVER;
  const flies = sp.traits.includes("flutter");
  const m: Mover = {
    flies,
    swims: sp.swims,
    climbs: !flies && (sp.family === "Bug" || CLIMBER_IDS.has(speciesId)),
    heavy: !flies && footprintOf(sp) >= 3,
    burrows: !flies && sp.traits.includes("stoneskin"),
  };
  moverCache.set(speciesId, m);
  return m;
}

/** Wild route choice: how strongly a climb is avoided when another step closes distance just as well. */
export const CLIMB_AVOID = 0.3;
export const HEAVY_CLIMB_AVOID = 0.95;
/** Chance a cave mouth has a burrower loitering at it. */
export const MOUTH_BURROWER_CHANCE = 0.45;

/* ------------------------------- Cave fauna ---------------------------------- */

/** Who lives underground, per layer (weights). Burrowers dominate. */
export const CAVE_FAUNA: Record<number, [string, number][]> = {
  [CAVE_UPPER]: [["cragjaw", 4], ["gloamoth", 3], ["dunescuttle", 2], ["slimekin", 1.5], ["skullclub_orc", 1.5], ["hollowcrow", 1], ["boglurk", 1]],
  [CAVE_DEEP]: [["crystal_golem", 3], ["cragjaw", 2], ["gloamoth", 1], ["skullclub_orc", 1], ["ironfang_tyrant", 0.3]],
};
/** Who lives on the underwater floor: swimming species only. The sky has no resident ecology — flying creatures are ground animals that travel aloft. */
export const UW_FAUNA: [string, number][] = [
  ["tidefin_toad", 3], ["crested_wyrm", 2], ["slimekin", 2], ["boglurk", 1.5], ["mossback", 1.5], ["regalslime", 0.4],
];
/** Burrowers that surface at cave mouths. */
export const MOUTH_BURROWERS: [string, number][] = [["cragjaw", 4], ["dunescuttle", 3], ["crystal_golem", 1]];
/** Cave creature density (fraction of spawn rolls that succeed) and level bonus. */
export const CAVE_DENSITY = 0.42;
export const CAVE_LEVEL_BONUS: Record<number, number> = { [CAVE_UPPER]: 2, [CAVE_DEEP]: 5, [UW]: 2 };
/** Layer creature density: the seafloor is rich country. */
export const LAYER_DENSITY: Record<number, number> = { [UW]: 0.42 };
/** Thermals rise where the land is this high (or prouder) and the noise agrees. */
export const THERMAL_MIN_LEVEL = 5;
export const THERMAL_SCALE = 60;
export const THERMAL_THRESHOLD = 0.1;
/** Deepest lakes: the underwater layer opens under this much lake-noise. */
export const UW_LAKE_SCALE = 90;
export const UW_LAKE_THRESHOLD = 0.18;

/** Deterministic weighted pick from a fauna table. */
export function pickWeighted(table: [string, number][], h: number): string {
  const total = table.reduce((a, [, w]) => a + w, 0);
  let r = (h / 4294967296) * total;
  for (const [id, w] of table) {
    r -= w;
    if (r <= 0) return id;
  }
  return table[table.length - 1][0];
}

/* -------------------------------- Heightfield -------------------------------- */

export type CliffStyle = "moss" | "sand" | "ice" | "basalt" | "granite" | "earth";

/** Cliff-face rock style for the biome on top of the cliff. */
export function cliffStyle(b: BiomeId): CliffStyle {
  switch (b) {
    case "desert": case "beach": case "steppe": return "sand";
    case "snow": case "tundra": case "peak": return "ice";
    case "gloomwood": return "basalt";
    case "mountain": return "granite";
    case "marsh": case "river": case "lake": return "earth";
    default: return "moss";
  }
}

export class Heightfield {
  readonly world: World;
  private canyonN: Perlin;
  private canyonMask: Perlin;
  private trailN: Perlin;
  private rampN: Perlin;
  private caveA: [Perlin, Perlin];
  private caveB: [Perlin, Perlin];
  private thermalN: Perlin;
  private skyN: Perlin;
  private uwN: Perlin;
  private base = new TwoGenCache<number>(CACHE_MAX);
  private ramps = new TwoGenCache<boolean>(CACHE_MAX);
  private pinLevels = new Map<number, number>();
  private mouthCells = new Map<number, number>();
  private shaftCells = new Map<number, number>();
  private caveCache = new TwoGenCache<boolean>(CACHE_MAX);
  private thermalCache = new TwoGenCache<boolean>(CACHE_MAX);

  constructor(world: World) {
    this.world = world;
    const s = world.seed;
    this.canyonN = new Perlin(s ^ 0xc0a1);
    this.canyonMask = new Perlin(s ^ 0xc0a2);
    this.trailN = new Perlin(s ^ 0xc0a3);
    this.rampN = new Perlin(s ^ 0xc0a4);
    this.caveA = [new Perlin(s ^ 0xcaf1), new Perlin(s ^ 0xcaf2)];
    this.caveB = [new Perlin(s ^ 0xcaf3), new Perlin(s ^ 0xcaf4)];
    this.thermalN = new Perlin(s ^ 0x7e11);
    this.skyN = new Perlin(s ^ 0x5142);
    this.uwN = new Perlin(s ^ 0x3ea0);
  }

  private naturalLevel(elev: number): number {
    return clamp(1 + Math.floor((elev - 0.5) / LEVEL_BAND), 1, LEVEL_MAX);
  }

  /** Landmark anchors near a point: every feature, plus the start point when it is not itself a landmark. */
  private anchorsNear(x: number, y: number, r: number): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = this.world.featuresNear(x, y, r).map((f) => ({ x: f.x, y: f.y }));
    const s = this.world.startPoint();
    if (!this.world.tile(s.x, s.y).feature && cheb(x, y, s.x, s.y) <= r) out.push({ x: s.x, y: s.y });
    return out;
  }

  /** Total order on anchors (row-major); earlier anchors settle their level first. */
  private static before(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
    return a.y < b.y || (a.y === b.y && a.x < b.x);
  }

  /**
   * Plateau level of a landmark. Neighboring landmarks must agree: two plateaus
   * D tiles apart may differ by at most D - 2·PIN_CORE levels, so their gentle
   * zones can always join without a ledge. Earlier anchors (row-major) settle
   * first; later ones clamp into every earlier neighbor's allowance.
   */
  private pinLevel(x: number, y: number): number {
    const k = y * WORLD_SIZE + x;
    const c = this.pinLevels.get(k);
    if (c !== undefined) return c;
    let v = this.naturalLevel(this.world.tile(x, y).elev);
    const me = { x, y };
    for (const o of this.anchorsNear(x, y, PIN_RAMP * 2)) {
      if (!Heightfield.before(o, me)) continue;
      const allow = Math.max(0, cheb(x, y, o.x, o.y) - 2 * PIN_CORE);
      const ol = this.pinLevel(o.x, o.y);
      v = clamp(v, ol - allow, ol + allow);
    }
    this.pinLevels.set(k, v);
    return v;
  }

  /**
   * Gentle-zone bounds at a tile: the intersection of every nearby landmark's
   * allowance (its plateau level ± tiles beyond its core). The bounds are
   * 1-Lipschitz, so clamping natural terrain into them never creates a new ledge.
   */
  private pinBounds(x: number, y: number): { lo: number; hi: number } | null {
    let lo = -Infinity;
    let hi = Infinity;
    let any = false;
    for (const a of this.anchorsNear(x, y, PIN_RAMP)) {
      any = true;
      const s = Math.max(0, cheb(x, y, a.x, a.y) - PIN_CORE);
      const p = this.pinLevel(a.x, a.y);
      lo = Math.max(lo, p - s);
      hi = Math.min(hi, p + s);
    }
    if (!any) return null;
    if (lo > hi) {
      const m = Math.round((lo + hi) / 2);
      return { lo: m, hi: m };
    }
    return { lo, hi };
  }

  /** How many levels a canyon cuts here (0 = none). */
  canyonDepth(x: number, y: number): number {
    const m = this.canyonMask.fbm(x / CANYON_MASK_SCALE, y / CANYON_MASK_SCALE, 2);
    if (m < CANYON_MASK_MIN) return 0;
    const taper = Math.min(1, (m - CANYON_MASK_MIN) / CANYON_MASK_RAMP);
    const cv = Math.abs(this.canyonN.fbm(x / CANYON_SCALE, y / CANYON_SCALE, 3));
    for (let i = 0; i < CANYON_BANDS.length; i++) if (cv < CANYON_BANDS[i] * taper) return CANYON_BANDS.length - i;
    return 0;
  }

  private trail(x: number, y: number): boolean {
    return this.trailN.fbm(x / TRAIL_SCALE, y / TRAIL_SCALE, 2) > TRAIL_THRESHOLD;
  }

  /** Packed level + flags for a surface tile. */
  private baseOf(x: number, y: number): number {
    if (!this.world.inBounds(x, y)) return F_WATER | F_SWIM;
    const key = y * WORLD_SIZE + x;
    const c = this.base.get(key);
    if (c !== undefined) return c;
    const t = this.world.tile(x, y);
    let v: number;
    if (t.biome === "deep" || t.biome === "sea") v = F_WATER | F_SWIM;
    else {
      let lvl = this.naturalLevel(t.elev);
      let flags = 0;
      const p = this.pinBounds(x, y);
      const wet = t.biome === "lake" || t.biome === "river";
      if (!p && lvl >= CANYON_MIN_LEVEL) {
        // canyons cut land and river alike: canyon rivers run along the deepest part of the floor beside them
        let dep = this.canyonDepth(x, y);
        if (wet) for (const [dx, dy] of N8) dep = Math.max(dep, this.canyonDepth(x + dx, y + dy));
        if (dep) {
          lvl = Math.max(1, lvl - dep);
          flags |= F_CANYON;
        }
      }
      if (wet) {
        // riverbeds and lakebeds sit one step below the land around them (landmark approaches stay level: fords)
        if (!p) lvl = Math.max(0, lvl - 1);
        flags |= F_WATER | (t.biome === "lake" ? F_SWIM : 0);
      }
      if (p) {
        // landmark zones are clamped last, so nothing re-introduces a ledge near a town
        flags |= F_PINZONE;
        lvl = clamp(lvl, p.lo, p.hi);
      }
      v = clamp(lvl, 0, LEVEL_MAX) | flags;
    }
    this.base.set(key, v);
    return v;
  }

  /** Terrace level of a surface tile (sea is 0). */
  level(x: number, y: number): number {
    return this.baseOf(x, y) & 0xff;
  }

  isWater(x: number, y: number): boolean {
    return (this.baseOf(x, y) & F_WATER) !== 0;
  }

  /** Unwalkable water (sea, deep, lake): step rules don't apply to swimmers here. */
  isSwim(x: number, y: number): boolean {
    return (this.baseOf(x, y) & F_SWIM) !== 0;
  }

  isCanyon(x: number, y: number): boolean {
    return (this.baseOf(x, y) & F_CANYON) !== 0;
  }

  inGentleZone(x: number, y: number): boolean {
    return (this.baseOf(x, y) & F_PINZONE) !== 0;
  }

  /**
   * A slope: a tile one level above a neighbor that can be walked up onto.
   * Landmark zones, riverbanks and rapids are always slopes; canyon walls only
   * on trails; elsewhere ramp noise decides (rockier ground has more cliffs).
   */
  isRamp(x: number, y: number): boolean {
    if (!this.world.inBounds(x, y)) return false;
    const key = y * WORLD_SIZE + x;
    const c = this.ramps.get(key);
    if (c !== undefined) return c;
    const b = this.baseOf(x, y);
    let r = false;
    if (!(b & F_SWIM)) {
      const L = b & 0xff;
      let hasLower = false;
      let lowerCanyon = false;
      let nearWater = false;
      for (const [dx, dy] of N8) {
        const nb = this.baseOf(x + dx, y + dy);
        if (nb & F_WATER) nearWater = true;
        if (!(nb & F_SWIM) && (nb & 0xff) === L - 1) {
          hasLower = true;
          if (nb & F_CANYON) lowerCanyon = true;
        }
      }
      if (hasLower) {
        if (b & (F_PINZONE | F_WATER)) r = true;
        else if (nearWater) r = true;
        else if ((b & F_CANYON) || lowerCanyon) r = this.trail(x, y) || this.rampN.fbm(x / RAMP_SCALE, y / RAMP_SCALE, 2) > CANYON_SCREE_THRESHOLD;
        else {
          const th = ROCKY.has(this.world.tile(x, y).biome) ? RAMP_THRESHOLD_ROCKY : RAMP_THRESHOLD;
          r = this.rampN.fbm(x / RAMP_SCALE, y / RAMP_SCALE, 2) > th;
        }
      }
    }
    this.ramps.set(key, r);
    return r;
  }

  /** A cliff edge: a land tile with a sheer (non-slope) drop beside it. */
  isCliffEdge(x: number, y: number): boolean {
    if (this.isSwim(x, y)) return false;
    const L = this.level(x, y);
    for (const [dx, dy] of N4) {
      if (this.isSwim(x + dx, y + dy)) continue;
      const d = L - this.level(x + dx, y + dy);
      if (d >= 2 || (d === 1 && !this.isRamp(x, y))) return true;
    }
    return false;
  }

  /* ------------------------------ Cave mouths -------------------------------- */

  private mouthOk(x: number, y: number): boolean {
    const w = this.world;
    if (!w.inBounds(x, y - 1) || !w.inBounds(x, y + 1)) return false;
    const t = w.tile(x, y);
    if (!BIOMES[t.biome].passable || t.biome === "river" || t.feature || w.siteAt(x, y)) return false;
    const b = this.baseOf(x, y);
    if (b & (F_WATER | F_PINZONE)) return false;
    const n = this.baseOf(x, y - 1);
    if (n & F_WATER) return false;
    const d = (n & 0xff) - (b & 0xff);
    if (d < 1 || (d === 1 && this.isRamp(x, y - 1))) return false;
    return BIOMES[w.tile(x, y + 1).biome].passable;
  }

  /** The raw mouth scan of a cell — one candidate site or -1, ignoring neighbors. */
  private rawMouthInCell(cx: number, cy: number): number {
    const cells = WORLD_SIZE / MOUTH_CELL;
    if (cx < 0 || cy < 0 || cx >= cells || cy >= cells || hash01(this.world.seed ^ 0xca7e, cx, cy) >= MOUTH_CHANCE) return -1;
    const h = hash2(this.world.seed ^ 0xca7f, cx, cy);
    const span = MOUTH_CELL - MOUTH_SCAN - 4;
    const ox = cx * MOUTH_CELL + 2 + (h % span);
    const oy = cy * MOUTH_CELL + 2 + ((h >>> 10) % span);
    for (let dy = 0; dy < MOUTH_SCAN; dy++) {
      for (let dx = 0; dx < MOUTH_SCAN; dx++) {
        if (this.mouthOk(ox + dx, oy + dy)) return (oy + dy) * WORLD_SIZE + ox + dx;
      }
    }
    return -1;
  }

  /** The cave mouth tile key of a cell, or -1. A cell keeps its mouth only when
   *  no neighboring cell's candidate mouth sits within the entry-chamber radius —
   *  a pure, order-independent rule, so both cells of a tight pair drop theirs
   *  and entrance structures never overlap. */
  mouthKeyInCell(cx: number, cy: number): number {
    const ck = cy * 4096 + cx;
    const c = this.mouthCells.get(ck);
    if (c !== undefined) return c;
    const raw = this.rawMouthInCell(cx, cy);
    let found = raw;
    if (raw >= 0) {
      const mx = raw % WORLD_SIZE;
      const my = Math.floor(raw / WORLD_SIZE);
      for (let ny = cy - 1; ny <= cy + 1 && found >= 0; ny++) {
        for (let nx = cx - 1; nx <= cx + 1; nx++) {
          if ((nx === cx && ny === cy) || nx < 0 || ny < 0) continue;
          const other = this.rawMouthInCell(nx, ny);
          if (other < 0) continue;
          if (Math.max(Math.abs((other % WORLD_SIZE) - mx), Math.abs(Math.floor(other / WORLD_SIZE) - my)) <= ENTRY_R * 2) {
            found = -1;
            break;
          }
        }
      }
    }
    this.mouthCells.set(ck, found);
    return found;
  }

  isMouth(x: number, y: number): boolean {
    return this.mouthKeyInCell(Math.floor(x / MOUTH_CELL), Math.floor(y / MOUTH_CELL)) === y * WORLD_SIZE + x;
  }

  /** Cave mouths whose tiles fall inside a rectangle (inclusive). */
  mouthsIn(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let cy = Math.floor(y0 / MOUTH_CELL); cy <= Math.floor(y1 / MOUTH_CELL); cy++) {
      for (let cx = Math.floor(x0 / MOUTH_CELL); cx <= Math.floor(x1 / MOUTH_CELL); cx++) {
        const k = this.mouthKeyInCell(cx, cy);
        if (k < 0) continue;
        const x = k % WORLD_SIZE;
        const y = Math.floor(k / WORLD_SIZE);
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push({ x, y });
      }
    }
    return out;
  }

  /* --------------------------------- Caves ----------------------------------- */

  /** Raw cave noise: ridged tunnels plus blobby chambers. */
  private caveBase(layer: number, x: number, y: number): boolean {
    if (x < 2 || y < 2 || x >= WORLD_SIZE - 2 || y >= WORLD_SIZE - 2) return false;
    const i = layer === CAVE_UPPER ? 0 : 1;
    const s = CAVE_SHAPE[i];
    if (Math.abs(this.caveA[i].fbm(x / s.tunnelScale, y / s.tunnelScale, 2)) < s.tunnelWidth) return true;
    return this.caveB[i].fbm(x / s.chamberScale, y / s.chamberScale, 2) > s.chamberMin;
  }

  /** The deep-shaft tile key of a cell, or -1 (shafts sit in open upper-cave passages). */
  shaftKeyInCell(cx: number, cy: number): number {
    const ck = cy * 4096 + cx;
    const c = this.shaftCells.get(ck);
    if (c !== undefined) return c;
    let found = -1;
    const cells = Math.ceil(WORLD_SIZE / SHAFT_CELL);
    if (cx >= 0 && cy >= 0 && cx < cells && cy < cells && hash01(this.world.seed ^ 0x5af7, cx, cy) < SHAFT_CHANCE) {
      const h = hash2(this.world.seed ^ 0x5af8, cx, cy);
      const span = SHAFT_CELL - SHAFT_SCAN - 4;
      const ox = cx * SHAFT_CELL + 2 + (h % span);
      const oy = cy * SHAFT_CELL + 2 + ((h >>> 10) % span);
      outer: for (let dy = 0; dy < SHAFT_SCAN; dy++) {
        for (let dx = 0; dx < SHAFT_SCAN; dx++) {
          const x = ox + dx;
          const y = oy + dy;
          if (this.caveBase(CAVE_UPPER, x, y) && this.caveBase(CAVE_UPPER, x - 1, y) && this.caveBase(CAVE_UPPER, x + 1, y)) {
            found = y * WORLD_SIZE + x;
            break outer;
          }
        }
      }
    }
    this.shaftCells.set(ck, found);
    return found;
  }

  isShaft(x: number, y: number): boolean {
    return this.shaftKeyInCell(Math.floor(x / SHAFT_CELL), Math.floor(y / SHAFT_CELL)) === y * WORLD_SIZE + x;
  }

  private carves(k: number, x: number, y: number): boolean {
    const mx = k % WORLD_SIZE;
    const my = Math.floor(k / WORLD_SIZE);
    const dx = x - mx;
    const dy = y - my;
    if (dx * dx + dy * dy <= ENTRY_R * ENTRY_R) return true;
    const ph = (hash2(this.world.seed ^ 0x7a11, mx, my) % 628) / 100;
    if (Math.abs(dx) <= CORRIDOR_LEN && Math.abs(dy - Math.round(CORRIDOR_WOBBLE * Math.sin(dx / 5 + ph))) <= 1) return true;
    return Math.abs(dy) <= CORRIDOR_LEN && Math.abs(dx - Math.round(CORRIDOR_WOBBLE * Math.sin(dy / 5 + ph))) <= 1;
  }

  private nearEntry(layer: number, x: number, y: number): boolean {
    if (layer === CAVE_UPPER) {
      const cx = Math.floor(x / MOUTH_CELL);
      const cy = Math.floor(y / MOUTH_CELL);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = this.mouthKeyInCell(cx + dx, cy + dy);
          if (k >= 0 && this.carves(k, x, y)) return true;
        }
      }
    }
    const sx = Math.floor(x / SHAFT_CELL);
    const sy = Math.floor(y / SHAFT_CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = this.shaftKeyInCell(sx + dx, sy + dy);
        if (k >= 0 && this.carves(k, x, y)) return true;
      }
    }
    return false;
  }

  /** Is this cave tile open floor (vs solid rock)? */
  caveOpen(layer: number, x: number, y: number): boolean {
    if (layer >= SURFACE) return false;
    if (x < 1 || y < 1 || x >= WORLD_SIZE - 1 || y >= WORLD_SIZE - 1) return false;
    const key = (layer === CAVE_UPPER ? 0 : 1) * WORLD_SIZE * WORLD_SIZE + y * WORLD_SIZE + x;
    const c = this.caveCache.get(key);
    if (c !== undefined) return c;
    const v = this.caveBase(layer, x, y) || this.nearEntry(layer, x, y);
    this.caveCache.set(key, v);
    return v;
  }

  /** Cave floor decoration: 0/1 bare rock, 2 moss, 3 puddle, 4 glowcaps (upper) or crystals (deep). */
  caveDecor(layer: number, x: number, y: number): number {
    const h = hash2(this.world.seed ^ 0xdec0 ^ (layer & 0xff), x, y) % 100;
    if (h < 7) return 4;
    if (h < 17) return 2;
    if (h < 21) return 3;
    return h & 1;
  }

  /* ------------------------------- Sky & sea ---------------------------------- */

  /**
   * A thermal: rising air over high, proud ground — the only way a flier
   * gains the sky layer from the surface. Deterministic, on land only.
   */
  thermalAt(x: number, y: number): boolean {
    if (!this.world.inBounds(x, y)) return false;
    const k = y * WORLD_SIZE + x;
    const c = this.thermalCache.get(k);
    if (c !== undefined) return c;
    const t = this.world.tile(x, y);
    let v: boolean;
    if (this.isSwim(x, y) || t.biome === "river" || this.world.siteAt(x, y) || t.feature) v = false;
    else if (objectAt(this.world, x, y)) v = false;
    else if (this.level(x, y) < THERMAL_MIN_LEVEL && this.prominence(x, y) < 1) v = false;
    else v = this.thermalN.fbm(x / THERMAL_SCALE, y / THERMAL_SCALE, 2) > THERMAL_THRESHOLD;
    this.thermalCache.set(k, v);
    return v;
  }

  /** The sky layer is open everywhere over land and sea alike. */
  skyOpen(_x: number, _y: number): boolean {
    return true;
  }

  /** Sky tile look: 0 clear, 1 wispy, 2 cloud bank, 3 thermal updraft. */
  skyDecor(x: number, y: number): number {
    if (this.thermalAt(x, y)) return 3;
    const v = (this.skyN.fbm(x / 50, y / 50, 3) + 1) / 2;
    if (v > 0.78) return 2;
    if (v > 0.6) return 1;
    return 0;
  }

  /**
   * The underwater layer exists only beneath deep open water: the whole deep
   * ocean, plus the deepest pools of lakes (a noise field picks them). Every
   * other tile is solid rock under the floor.
   */
  uwOpen(x: number, y: number): boolean {
    if (!this.world.inBounds(x, y)) return false;
    const b = this.world.tile(x, y).biome;
    if (b === "deep") return true;
    if (b === "lake") return this.uwN.fbm(x / UW_LAKE_SCALE, y / UW_LAKE_SCALE, 2) > UW_LAKE_THRESHOLD;
    return false;
  }

  /** Freshwater floor (lake pools) vs the salt seafloor — different look, same layer. */
  uwFresh(x: number, y: number): boolean {
    return this.world.tile(x, y).biome === "lake";
  }

  /** Seafloor decoration: 0 sand, 1 kelp, 2 reef rock, 3 murk, 4 sunken log / lily roots. */
  uwDecor(x: number, y: number): number {
    const h = hash2(this.world.seed ^ 0x5ea0, x, y) % 100;
    if (h < 34) return 1;
    if (h < 50) return 2;
    if (h < 62) return 3;
    if (h < 68) return 4;
    return h & 1;
  }

  /** Layer reached by stepping onto this tile, or null. Fliers rise on
   *  thermals and can descend anywhere; swimmers dive into deep water and
   *  can surface anywhere below it (every open underwater tile is deep water
   *  above). Cave mouths work on foot as before. */
  transitionAt(layer: number, x: number, y: number, m: Mover = PLAYER_MOVER): number | null {
    if (layer === SURFACE) {
      if (this.isMouth(x, y)) return CAVE_UPPER;
      if (m.flies && this.thermalAt(x, y)) return SKY;
      if (m.swims && this.uwOpen(x, y)) return UW;
      return null;
    }
    if (layer === SKY) return SURFACE;
    if (layer === UW) return SURFACE;
    if (layer === CAVE_UPPER) {
      if (this.isMouth(x, y)) return SURFACE;
      if (this.isShaft(x, y)) return CAVE_DEEP;
      return null;
    }
    if (layer === CAVE_DEEP) return this.isShaft(x, y) ? CAVE_UPPER : null;
    return null;
  }

  /** How far a point stands above its surroundings (levels, 0..cap). */
  prominence(x: number, y: number): number {
    if (this.isSwim(x, y)) return 0;
    const L = this.level(x, y);
    let sum = 0;
    for (const [dx, dy] of N8) sum += this.level(x + dx * PROMINENCE_R, y + dy * PROMINENCE_R);
    return clamp(Math.floor(L - sum / N8.length), 0, PROMINENCE_CAP);
  }
}

const fields = new WeakMap<World, Heightfield>();

/** The heightfield of a world (cached per world instance). */
export function heightOf(world: World): Heightfield {
  let h = fields.get(world);
  if (!h) {
    h = new Heightfield(world);
    fields.set(world, h);
  }
  return h;
}

/* ------------------------------ Rule helpers --------------------------------- */

/** The layer the player — and therefore every live creature — is on. */
export function layerOf(gs: GameState): number {
  return gs.player.layer ?? SURFACE;
}

/** True when a wild creature shares the player's layer (creatures on other layers are frozen). */
export function sameLayer(gs: GameState, c: { layer?: number }): boolean {
  return (c.layer ?? SURFACE) === (gs.player.layer ?? SURFACE);
}

/**
 * Height-aware line of sight. Underground, solid rock blocks. On the surface
 * the sight line runs from eye height above the viewer's level to just above
 * the target's level; any terrain rising above that line hides the target —
 * so cliffs hide what lies above and behind them, and rims hide canyon floors.
 */
export function heightLOS(world: World, layer: number, x0: number, y0: number, x1: number, y1: number): boolean {
  const hf = heightOf(world);
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  if (n <= 1) return true;
  // the open sky and the open seafloor have no sight blockers of their own
  if (layer === SKY || layer === UW) return true;
  const top = (x: number, y: number): number => (hf.isSwim(x, y) ? 0 : hf.level(x, y) + (world.tile(x, y).biome === "peak" ? PEAK_SIGHT_BONUS : 0));
  const e0 = layer < SURFACE ? 0 : hf.level(x0, y0) + EYE_HEIGHT;
  const e1 = layer < SURFACE ? 0 : (hf.isSwim(x1, y1) ? 0 : hf.level(x1, y1)) + TARGET_HEIGHT;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
    if (x === x1 && y === y1) return true;
    if (layer < SURFACE) {
      if (!hf.caveOpen(layer, x, y)) return false;
      continue;
    }
    // a physical object — trunk, boulder, reed bed — breaks the sight line
    if (objectAt(world, x, y)) return false;
    const t = Math.max(Math.abs(x - x0), Math.abs(y - y0)) / n;
    if (top(x, y) > e0 + (e1 - e0) * t) return false;
  }
}

/** Terrace level used for gameplay at a tile on a layer (caves are flat). */
export function levelOn(world: World, layer: number, x: number, y: number): number {
  return layer === SURFACE ? heightOf(world).level(x, y) : 0;
}

/**
 * Can the player stand here at all on this layer (ignores bodies)? Icy peaks
 * are walkable on the surface but cost a hard climb; wild bodies additionally
 * need to be climbers or fliers to go up there. Physical objects (trees,
 * boulders) block the surface; the sky is open air; the seafloor is open
 * exactly where deep water sits above it. Road surveys pass `ignoreObjects`:
 * a road is a future clearing, and the laid road vetoes objects on itself.
 */
export function walkable(world: World, layer: number, x: number, y: number, ignoreObjects = false): boolean {
  const hf = heightOf(world);
  if (layer === SKY) return world.inBounds(x, y);
  if (layer === UW) return hf.uwOpen(x, y);
  if (layer < SURFACE) return hf.caveOpen(layer, x, y);
  if (!ignoreObjects && objectAt(world, x, y)) return false;
  if (world.passable(x, y)) return true;
  // a bridge span is the road over open water: walkable where it lies
  if (roadAt(world, x, y)) return true;
  return world.inBounds(x, y) && world.tile(x, y).biome === "peak" && !world.siteAt(x, y);
}

/** Ticks one step onto this tile costs the player (before climbing). A road
 *  is packed earth: walking it costs a flat 1 whatever the surrounding land —
 *  marsh, scree and snow all give way to the paved way. */
export function tileCost(world: World, layer: number, x: number, y: number): number {
  if (layer !== SURFACE) return 1;
  const b = world.tile(x, y).biome;
  if (b === "peak") return PEAK_CLIMB_COST;
  if (roadAt(world, x, y)) return 1;
  return BIOMES[b].cost;
}

export interface StepResult {
  ok: boolean;
  /** Levels climbed (0 when level or descending). */
  rise: number;
  /** Levels descended (0 when level or climbing). */
  drop: number;
}

/**
 * The one height rule for a single step between neighboring tiles.
 * Up one level needs a slope (climbers and fliers ignore this); down is always
 * physically possible — callers decide whether a drop of 2+ is a fall.
 * Unwalkable water endpoints (swimmers) and caves are flat.
 */
export function stepRule(world: World, layer: number, x0: number, y0: number, x1: number, y1: number, m: Mover): StepResult {
  if (layer !== SURFACE || m.flies) return { ok: true, rise: 0, drop: 0 };
  const hf = heightOf(world);
  if (hf.isSwim(x0, y0) || hf.isSwim(x1, y1)) return { ok: true, rise: 0, drop: 0 };
  const d = hf.level(x1, y1) - hf.level(x0, y0);
  if (d > 0) return { ok: m.climbs || (d === 1 && hf.isRamp(x1, y1)), rise: d, drop: 0 };
  return { ok: true, rise: 0, drop: -d };
}

/** Levels of falling a drop costs this body (fliers and climbers never fall). */
export function fallLevels(m: Mover, drop: number): number {
  return m.flies || m.climbs ? 0 : Math.max(0, drop - 1);
}

/** Fall damage for a body of this max HP falling this many levels. */
export function fallDamage(maxHp: number, levels: number): number {
  return levels <= 0 ? 0 : Math.max(1, Math.round(maxHp * FALL_DAMAGE_FRAC * levels));
}

/** Movement cost added by climbing. */
export function climbCost(m: Mover, rise: number): number {
  return rise * UPHILL_COST * (m.heavy ? 2 : 1);
}

/** To-hit edge for attacking from level `la` onto level `ld`. */
export function heightEdge(la: number, ld: number): number {
  return clamp(la - ld, -HIGH_GROUND_CAP, HIGH_GROUND_CAP) * HIGH_GROUND_ACC;
}

/** True when a multi-tile body would not straddle a cliff (all tiles within one level). */
export function bodyLevelOk(world: World, layer: number, x: number, y: number, fp: number): boolean {
  if (layer < SURFACE || fp <= 1) return true;
  const hf = heightOf(world);
  let lo = Infinity;
  let hi = -Infinity;
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      if (hf.isSwim(x + dx, y + dy)) continue;
      const l = hf.level(x + dx, y + dy);
      lo = Math.min(lo, l);
      hi = Math.max(hi, l);
    }
  }
  return hi - lo <= 1;
}

/** Human name of a level band (or a whole layer). */
export function tierName(level: number, layer = SURFACE): string {
  if (layer === SKY) return "Open Sky";
  if (layer === UW) return "Underwater";
  if (layer === CAVE_UPPER) return "Upper Caves";
  if (layer === CAVE_DEEP) return "Deep Caves";
  if (level <= 0) return "Sea level";
  if (level === 1) return "Shore";
  if (level <= 3) return "Lowlands";
  if (level <= 6) return "Uplands";
  if (level <= 9) return "Highlands";
  return "Mountain tops";
}

/** Everything the inspect card needs to describe a tile's vertical terrain. */
export interface GroundInfo {
  layer: number;
  level: number;
  tier: string;
  ramp: boolean;
  cliff: boolean;
  canyon: boolean;
  mouth: boolean;
  shaft: boolean;
  /** A rising thermal a flier could ride to the sky layer. */
  thermal: boolean;
  open: boolean;
}

/**
 * v15 height migration — idempotent, safe on every load. Saved positions are
 * re-validated against the heightfield: a player standing somewhere that is
 * no longer standable moves to the nearest safe ground; wild bodies that now
 * straddle a cliff or stand in rock are dropped (they respawn deterministically).
 * Returns true when the party should be re-deployed beside the player.
 */
export function migrateHeight(gs: GameState, world: World): boolean {
  if (gs.player.layer === SURFACE) delete gs.player.layer;
  if (gs.knowledge && !gs.knowledge.caves) gs.knowledge.caves = {};
  const layer = layerOf(gs);
  let refield = false;
  if (!walkable(world, layer, gs.player.x, gs.player.y)) {
    const spot = nearestStandable(world, layer, gs.player.x, gs.player.y);
    if (spot) {
      gs.player.x = spot.x;
      gs.player.y = spot.y;
    } else {
      delete gs.player.layer;
      gs.player.x = gs.player.homeX;
      gs.player.y = gs.player.homeY;
    }
    refield = true;
  }
  const pl = levelOn(world, layerOf(gs), gs.player.x, gs.player.y);
  for (const m of gs.party) {
    const p = gs.field?.[m.uid];
    if (!p) continue;
    if (!walkable(world, layerOf(gs), p.x, p.y) || Math.abs(levelOn(world, layerOf(gs), p.x, p.y) - pl) > 1) refield = true;
  }
  for (const [id, c] of Object.entries(gs.creatures)) {
    const cl = c.layer ?? SURFACE;
    if (c.layer === SURFACE) delete c.layer;
    const fp = bodyFootprint(c, gs.tick);
    const ok = cl === layerOf(gs) && (cl >= SURFACE || walkable(world, cl, c.x, c.y)) && bodyLevelOk(world, cl, c.x, c.y, fp);
    // monsters the player has met persist as real individuals, dormant on other
    // layers — a save/load must not wipe what changeLayer deliberately kept
    if (!ok && !(cl !== layerOf(gs) && c.known)) delete gs.creatures[id];
  }
  return refield;
}

/** Nearest tile (ring search) a body can stand on, on this layer. */
export function nearestStandable(world: World, layer: number, x: number, y: number, maxR = 24): { x: number; y: number } | null {
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (walkable(world, layer, x + dx, y + dy) && (layer < SURFACE || world.passable(x + dx, y + dy))) return { x: x + dx, y: y + dy };
      }
    }
  }
  return null;
}

export function groundInfo(world: World, layer: number, x: number, y: number): GroundInfo {
  const hf = heightOf(world);
  if (layer === SKY) {
    return { layer, level: 0, tier: tierName(0, layer), ramp: false, cliff: false, canyon: false, mouth: false, shaft: false, thermal: false, open: true };
  }
  if (layer === UW) {
    return { layer, level: 0, tier: tierName(0, layer), ramp: false, cliff: false, canyon: false, mouth: false, shaft: false, thermal: false, open: hf.uwOpen(x, y) };
  }
  if (layer < SURFACE) {
    return {
      layer, level: 0, tier: tierName(0, layer), ramp: false, cliff: false, canyon: false,
      mouth: layer === CAVE_UPPER && hf.isMouth(x, y), shaft: hf.isShaft(x, y), thermal: false, open: hf.caveOpen(layer, x, y),
    };
  }
  const level = hf.level(x, y);
  return {
    layer, level, tier: tierName(level), ramp: hf.isRamp(x, y), cliff: hf.isCliffEdge(x, y),
    canyon: hf.isCanyon(x, y), mouth: hf.isMouth(x, y), shaft: false, thermal: hf.thermalAt(x, y), open: world.passable(x, y) && !objectAt(world, x, y),
  };
}
