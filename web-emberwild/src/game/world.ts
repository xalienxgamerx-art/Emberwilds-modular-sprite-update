import { TwoGenCache } from "./cache";
import { BIOMES, DAY_TICKS, HAMLET_SUFFIX, LAIR_NAMES, NAME_A, NAME_B, RUIN_NAMES, SEASON_DAYS, SHRINE_NAMES, SPECIES_LIST, TICK_MINUTES, TOWN_SUFFIX, WORLD_SIZE, CITY_SUFFIX } from "./data";
import { Perlin, clamp01, hash01, hash2, hashString } from "./rng";
import type { BiomeId, FeatureId, ItemId, WeatherId } from "./types";
import { PLAYER_MOVER, SURFACE, climbCost, stepRule, tileCost, walkable } from "./height";
import { getSettlementFootprint, isSettlement, settlementSeed, settlementTier } from "./settlement";
import { generateTown } from "./town";
import { generateCity } from "./city";
import type { UrbanPlan } from "./urban";
import { BUILDING_TEMPLATES, DIR_DELTA, generateBuilding, type Building, type BuildingCellKind, type BuildingDoor, type BuildingRoom, type BuildingType } from "./buildings";
import { roadNetworkOf, settlementEntrances } from "./roads";
import { objectAt } from "./objects";

export interface Feature {
  kind: FeatureId;
  name: string;
  x: number;
  y: number;
  speciesId: string | null;
}

/** One tile of a landmark's physical structure: walls, floors, doors, rubble. */
export interface SitePiece {
  kind: FeatureId;
  feature: Feature;
  wall: boolean;
  door: boolean;
  rubble: boolean;
  /** A solid gatepost flanking a deliberate settlement entrance (implies wall). */
  post?: boolean;
  /** Which generated building this tile belongs to, when the landmark is built from buildings. */
  buildingId?: string;
  /** Which room of that building the tile lies in. */
  roomId?: number;
  /** What future interactable this floor tile is reserved for (bed, chest, hearth…). */
  reservedFor?: string;
}

/** The folk of a settlement — service folk at their posts, plus residents and recruiters. */
export interface Npc {
  role: "innkeep" | "trader" | "penkeeper" | "resident" | "recruiter" | "traveler";
  name: string;
  /** The settlement this folk member lives in. */
  settlement: string;
  x: number;
  y: number;
  line: string;
  /** The home building a resident belongs to (residents only). */
  home?: BuildingType;
  /** Visual variant index — portraits may vary per variant in a later pass; nothing depends on one asset. */
  variant?: number;
  /** Which association of the local nation this recruiter speaks for, by slot (recruiters only). */
  assocSlot?: number;
  /** The road this traveler walks and the settlement they are bound for (travelers only). */
  boundFor?: string;
}

export interface TileInfo {
  x: number;
  y: number;
  biome: BiomeId;
  elev: number;
  height: number;
  baseTemp: number;
  moist: number;
  river: boolean;
  feature: Feature | null;
}

export interface WeatherInfo {
  id: WeatherId;
  temp: number;
  humidity: number;
  wind: number;
  cloud: number;
}

export const FEATURE_CELL = 24;
const REGION_CELL = 160;
/** Half-extent of a settlement site: the hamlet footprint centered on the feature tile. */
const SITE_R = Math.floor(getSettlementFootprint("hamlet").w / 2);
/** Half-extents of the bigger settlement sites. */
const TOWN_R = Math.floor(getSettlementFootprint("town").w / 2);
const CITY_R = Math.floor(getSettlementFootprint("city").w / 2);
/** City regions: each 6×6 block of feature cells raises at most one city. */
const CITY_REGION = 6;
/**
 * Dry-land edge gap every settlement keeps between its site and any other's:
 * no two settlement footprints may stand closer than this much open country,
 * whatever their tiers. Hamlets enforce it against every earlier settlement,
 * towns and cities against every earlier settlement and every later one that
 * looks back — together the two directions close the pair completely.
 */
export const SETTLEMENT_GAP = 12;
/** Feature-cell roll slices: below HAMLET_ROLL a cell hosts a hamlet; from
 * TOWN_ROLL to TOWN_ROLL_END a settled cell hosts a town. The town veto in
 * metroSpot scans a hair past the slice so a town never overlooks a neighbor
 * that just misses the cut. */
const HAMLET_ROLL = 0.09;
const TOWN_ROLL = 0.25;
const TOWN_ROLL_END = 0.27;
const TOWN_VETO_END = 0.274;
const DIRS8: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Shared empty gatepost set — handed out while a settlement's own posts are still being derived. */
const EMPTY_POSTS: Set<number> = new Set();

/**
 * The plots of a tier-hamlet settlement, each on its own lot (building-local
 * coordinates centered on the feature). The settlement asks the building
 * generator for each plot; buildings never assume they own the whole site, so
 * later phases can compose bigger settlements from these plots. Lots ring the
 * green along the north and south faces, clear of the plaza, with a street
 * between every plot.
 */
const SERVICE_PLOTS: { type: BuildingType; x0: number; y0: number; x1: number; y1: number }[] = [
  { type: "inn", x0: -11, y0: -11, x1: -3, y1: -7 },
  { type: "trader", x0: 3, y0: -11, x1: 11, y1: -7 },
  { type: "pen", x0: -3, y0: 7, x1: 3, y1: 11 },
  // two family homes in the south corners — a hamlet is houses, not just services
  { type: "small_home", x0: -11, y0: 7, x1: -4, y1: 11 },
  { type: "medium_home", x0: 4, y0: 7, x1: 11, y1: 11 },
];
/** The open village green: cleared ground inside this radius of the feature tile. */
const PLAZA_R2 = 25;

const smooth = (a: number, b: number, t: number): number => {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
};

const ADJ: Record<BiomeId, string[]> = {
  deep: ["Black", "Abyssal"], sea: ["Salt", "Grey"], lake: ["Still", "Glass"],
  river: ["Mossy", "Swift", "Reedy", "Pebbled"], beach: ["Shell", "Driftwood", "Sunny"],
  meadow: ["Clover", "Bright", "Bee-loud", "Golden"], forest: ["Dappled", "Old", "Fern", "Acorn"],
  taiga: ["Hushed", "Needle", "Cold"], gloomwood: ["Weeping", "Pale", "Hollow", "Ashen"],
  marsh: ["Sucking", "Murk", "Frog", "Reed"], steppe: ["Windy", "Long", "Thistle"],
  desert: ["Scorched", "Glass", "Red"], tundra: ["Frost", "Bare", "Lichen"],
  snow: ["White", "Silent"], hills: ["Heather", "Rolling", "Gorse"], mountain: ["Broken", "Eagle", "Scree"],
  peak: ["Sky", "Iron"],
};

export const SEASONS = ["Spring", "Summer", "Autumn", "Winter"] as const;
const SEASON_TEMP = [0, 6, -1, -9];

export function seasonIndex(tick: number): number {
  return Math.floor(Math.floor(tick / DAY_TICKS) / SEASON_DAYS) % 4;
}

export function timeOf(tick: number): { day: number; hour: number; minute: number; label: string; phase: "Dawn" | "Day" | "Dusk" | "Night"; night: boolean; daylight: number } {
  const day = Math.floor(tick / DAY_TICKS) + 1;
  const mins = (tick % DAY_TICKS) * TICK_MINUTES;
  const hour = Math.floor(mins / 60);
  const minute = mins % 60;
  const label = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const phase = hour >= 5 && hour < 8 ? "Dawn" : hour >= 8 && hour < 18 ? "Day" : hour >= 18 && hour < 21 ? "Dusk" : "Night";
  const h = hour + minute / 60;
  const daylight = clamp01(Math.sin(((h - 5.5) / 15) * Math.PI) * 1.4);
  return { day, hour, minute, label, phase, night: phase === "Night", daylight };
}

/** A building plus the local tile of interest, as answered by a settlement layout. */
export interface SettlementPiece {
  building: Building;
  kind: BuildingCellKind;
  room: BuildingRoom | null;
  door: BuildingDoor | null;
  /** What future interactable this tile is reserved for. */
  reservedFor?: string;
}

/** The built layout of a settlement: its generated buildings, queryable by tile. */
export interface SettlementLayout {
  buildings: Building[];
  /** The building tile at these feature-local coordinates, if any. */
  piece(lx: number, ly: number): SettlementPiece | null;
  /** The building of the given type, if the settlement has one. */
  building(type: BuildingType): Building | null;
  /** The reserved urban plan (streets, green, gates, districts) — town and city layouts. */
  urban?: UrbanPlan;
}

export class World {
  readonly seed: number;
  private cont: Perlin;
  private elevN: Perlin;
  private ridge: Perlin;
  private moistN: Perlin;
  private tempN: Perlin;
  private riverN: Perlin;
  private river2N: Perlin;
  private warp: Perlin;
  private lakeN: Perlin;
  private gloomN: Perlin;
  private weatherN: Perlin;
  private windN: Perlin;
  // two-generation aging: pure per-seed data never invalidates, and the hot
  // country around the player survives a size overflow instead of a full clear
  private cache = new TwoGenCache<TileInfo>(160000);
  private featureCache = new Map<number, Feature | null>();
  // two-generation aging like the tile cache: siteAt is pure per seed and its
  // hot set (the settlements around you) must survive an overflow
  private siteCache = new TwoGenCache<SitePiece | null>(160000);
  private layoutCache = new Map<string, SettlementLayout>();
  private postCache = new Map<string, Set<number>>();
  private posting = new Set<string>();
  private regionCache = new Map<number, string>();
  private start: { x: number; y: number; name: string } | null = null;

  constructor(seed: number) {
    this.seed = seed;
    this.cont = new Perlin(seed ^ 0x1111);
    this.elevN = new Perlin(seed ^ 0x2222);
    this.ridge = new Perlin(seed ^ 0x3333);
    this.moistN = new Perlin(seed ^ 0x4444);
    this.tempN = new Perlin(seed ^ 0x5555);
    this.riverN = new Perlin(seed ^ 0x6666);
    this.river2N = new Perlin(seed ^ 0x6767);
    this.warp = new Perlin(seed ^ 0x7777);
    this.lakeN = new Perlin(seed ^ 0x8888);
    this.gloomN = new Perlin(seed ^ 0x9999);
    this.weatherN = new Perlin(seed ^ 0xaaaa);
    this.windN = new Perlin(seed ^ 0xbbbb);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < WORLD_SIZE && y < WORLD_SIZE;
  }

  /** Raw elevation, 0..1 with sea level at 0.5. */
  elevation(x: number, y: number): number {
    const nx = x / WORLD_SIZE - 0.5;
    const ny = y / WORLD_SIZE - 0.5;
    const d = Math.sqrt(nx * nx + ny * ny) * 2;
    const wx = x + this.warp.fbm(x / 400, y / 400, 2) * 120;
    const wy = y + this.warp.fbm(x / 400 + 31, y / 400 - 17, 2) * 120;
    const cont = this.cont.fbm(wx / 900, wy / 900, 4);
    let e = 0.6 + cont * 0.55 + this.elevN.fbm(wx / 140, wy / 140, 5) * 0.16 - smooth(0.7, 1.05, d) * 0.5;
    const r = 1 - Math.abs(this.ridge.fbm(wx / 380, wy / 380, 4)) * 2.4;
    const ridged = Math.max(0, r) ** 4;
    e += ridged * 0.22 * smooth(0.52, 0.62, e);
    return e;
  }

  tile(x: number, y: number): TileInfo {
    const key = y * WORLD_SIZE + x;
    const c = this.cache.get(key);
    if (c) return c;
    const t = this.compute(x, y);
    this.cache.set(key, t);
    return t;
  }

  private compute(x: number, y: number, withFeature = true): TileInfo {
    if (!this.inBounds(x, y)) {
      return { x, y, biome: "deep", elev: 0, height: -400, baseTemp: 4, moist: 1, river: false, feature: null };
    }
    const e = this.elevation(x, y);
    const h = clamp01((e - 0.5) / 0.55) ** 1.5;
    const lat = y / WORLD_SIZE;
    const baseTemp = -9 + lat * 38 + this.tempN.fbm(x / 600, y / 600, 3) * 10 - h * 26;
    const coast = 1 - smooth(0.5, 0.58, e);
    const moist = clamp01(0.5 + this.moistN.fbm(x / 520, y / 520, 4) * 1.05 + coast * 0.18 - h * 0.15);
    let biome: BiomeId;
    let river = false;
    if (e < 0.44) biome = "deep";
    else if (e < 0.5) biome = "sea";
    else {
      const wx = x + this.warp.fbm(x / 90, y / 90, 2) * 30;
      const wy = y + this.warp.fbm(x / 90 + 9, y / 90 + 5, 2) * 30;
      const rv = Math.abs(this.riverN.fbm(wx / 520, wy / 520, 3));
      const rv2 = Math.abs(this.river2N.fbm(wx / 240, wy / 240, 3));
      const riverAllowed = h < 0.5 && e > 0.505;
      if (riverAllowed && (rv < 0.0065 + h * -0.006 + 0.002 || (moist > 0.5 && rv2 < 0.0045 && h < 0.35))) river = true;
      const lake = this.lakeN.fbm(x / 140, y / 140, 3) > 0.36 && h < 0.22 && moist > 0.52;
      if (lake) biome = "lake";
      else if (river) biome = "river";
      else if (h > 0.66) biome = "peak";
      else if (h > 0.44) biome = baseTemp < -8 ? "snow" : "mountain";
      else if (e < 0.512 && baseTemp > 0) biome = "beach";
      else if (baseTemp < -6) biome = "snow";
      else if (baseTemp < 0) biome = "tundra";
      else if (baseTemp < 6) biome = moist > 0.42 ? "taiga" : "tundra";
      else if (baseTemp > 19 && moist < 0.36) biome = "desert";
      else if (moist < 0.42) biome = h > 0.24 ? "hills" : "steppe";
      else if (moist > 0.7 && h < 0.14) biome = "marsh";
      else if (moist > 0.52) {
        biome = this.gloomN.fbm(x / 260, y / 260, 3) > 0.28 ? "gloomwood" : "forest";
      } else biome = h > 0.24 ? "hills" : "meadow";
    }
    const height = Math.round((e - 0.5) * 2 * 3200);
    const info: TileInfo = { x, y, biome, elev: e, height, baseTemp, moist, river, feature: null };
    if (withFeature) info.feature = this.featureAt(x, y, biome);
    return info;
  }

  private cellFeature(cx: number, cy: number): Feature | null {
    const key = cy * 1000 + cx;
    if (this.featureCache.has(key)) return this.featureCache.get(key) ?? null;
    const hh = hash2(this.seed ^ 0xfea7, cx, cy);
    const fx = cx * FEATURE_CELL + 3 + (hh % (FEATURE_CELL - 6));
    const fy = cy * FEATURE_CELL + 3 + ((hh >>> 8) % (FEATURE_CELL - 6));
    let f: Feature | null = null;
    if (this.inBounds(fx, fy)) {
      const e = this.elevation(fx, fy);
      const tile = e > 0.5 ? this.computeBiomeOnly(fx, fy) : "sea";
      const roll = hash01(this.seed ^ 0xbead, cx, cy);
      const pass = BIOMES[tile].passable && tile !== "river";
      // a city claims its region before lesser landmarks are placed: its own
      // cell becomes the city, and anything that would spawn inside its site
      // yields to it. The site is wide, so cities of neighboring regions keep
      // their claim too — a cell near a region border yields to either.
      const rx0 = Math.floor(cx / CITY_REGION);
      const ry0 = Math.floor(cy / CITY_REGION);
      const own = this.regionCity(rx0, ry0);
      if (own && own.cx === cx && own.cy === cy) {
        const name = NAME_A[hh % NAME_A.length] + NAME_B[(hh >>> 7) % NAME_B.length] + CITY_SUFFIX[(hh >>> 13) % CITY_SUFFIX.length];
        this.featureCache.set(key, { kind: "city", name, x: own.x, y: own.y, speciesId: null });
        return this.featureCache.get(key)!;
      }
      let claimed = false;
      for (let dry2 = -1; dry2 <= 1 && !claimed; dry2++) {
        for (let drx2 = -1; drx2 <= 1; drx2++) {
          const m = this.regionCity(rx0 + drx2, ry0 + dry2);
          if (m && Math.max(Math.abs(fx - m.x), Math.abs(fy - m.y)) <= CITY_R + 40) {
            claimed = true;
            break;
          }
        }
      }
      if (claimed) {
        this.featureCache.set(key, null);
        return null;
      }
      if (pass) {
        const settled = tile === "meadow" || tile === "forest" || tile === "hills" || tile === "steppe" || tile === "taiga" || tile === "beach";
        const h2 = hash2(this.seed ^ 0x77, cx, cy);
        if (settled && roll < HAMLET_ROLL) {
          const name = NAME_A[h2 % NAME_A.length] + NAME_B[(h2 >>> 7) % NAME_B.length] + HAMLET_SUFFIX[(h2 >>> 13) % HAMLET_SUFFIX.length];
          // a settlement stands whole on dry land or not at all: the site moves
          // to the nearest spot that fits, never jutting into water or damming
          // a river
          const spot = this.drySettlementSpot(cx, cy, fx, fy);
          if (spot) f = { kind: "hamlet", name, x: spot.x, y: spot.y, speciesId: null };
        } else if (roll < 0.13) {
          f = { kind: "ruin", name: RUIN_NAMES[h2 % RUIN_NAMES.length], x: fx, y: fy, speciesId: null };
        } else if (roll < 0.155) {
          f = { kind: "shrine", name: SHRINE_NAMES[h2 % SHRINE_NAMES.length], x: fx, y: fy, speciesId: null };
        } else if (roll < 0.25) {
          const sp = this.pickSpecies(tile, h2);
          if (sp) f = { kind: "lair", name: `${SPECIES_LIST.find((s) => s.id === sp)?.name ?? "Beast"} ${LAIR_NAMES[(h2 >>> 5) % LAIR_NAMES.length]}`, x: fx, y: fy, speciesId: sp };
        } else if (settled && roll < TOWN_ROLL_END) {
          // a town: a regional center on a 46×46 site. Every cell that hosts
          // one was empty before, so no existing hamlet, ruin, shrine or lair
          // moves. The site demands a full footprint of dry land and room
          // from every neighbor; a cell that cannot host one stays empty.
          const name = NAME_A[h2 % NAME_A.length] + NAME_B[(h2 >>> 7) % NAME_B.length] + TOWN_SUFFIX[(h2 >>> 13) % TOWN_SUFFIX.length];
          const spot = this.metroSpot(cx, cy, fx, fy, TOWN_R, TOWN_R + SETTLEMENT_GAP + 12, 7);
          if (spot) f = { kind: "town", name, x: spot.x, y: spot.y, speciesId: null };
        }
      }
    }
    this.featureCache.set(key, f);
    return f;
  }

  /** Water never carries a settlement: lakes and seas are impassable, and rivers must keep flowing. */
  private isDryLand(x: number, y: number): boolean {
    const b = this.computeBiomeOnly(x, y);
    return BIOMES[b].passable && b !== "river";
  }

  /**
   * The nearest position in this feature cell whose whole settlement site stands
   * on dry land, or null when the cell cannot host one. Candidates stay inside
   * the cell so neighboring settlements' sites never overlap; the ordering is
   * deterministic — nearest to the hashed origin first, ties broken by position.
   */
  private drySettlementSpot(cx: number, cy: number, fx: number, fy: number): { x: number; y: number } | null {
    const loX = cx * FEATURE_CELL + SITE_R;
    const hiX = cx * FEATURE_CELL + FEATURE_CELL - 1 - SITE_R;
    const loY = cy * FEATURE_CELL + SITE_R;
    const hiY = cy * FEATURE_CELL + FEATURE_CELL - 1 - SITE_R;
    // settlements keep their distance: this site must stand a full dry gap
    // away from every earlier settlement's site. Earlier cells only (row
    // major), so no placement ever depends on a later one — deterministic,
    // cycle-free — and later settlements look back at this one's realized
    // spot in turn, closing every pair from both sides.
    const near: { x: number; y: number; d: number }[] = [];
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const ncx = cx + dx;
        const ncy = cy + dy;
        if (ncx < 0 || ncy < 0) continue;
        // a ruin, shrine or lair in a neighboring cell keeps its whole
        // structure clear of this site: no landmark spawns inside a reserved
        // settlement footprint (pure hash — no recursion, no order dependence).
        // Minors also spawn on cells below the hamlet roll whose biome cannot
        // host a settlement, so the veto covers the whole minor range.
        const nroll = hash01(this.seed ^ 0xbead, ncx, ncy);
        const nsettled = (() => {
          const nhh2 = hash2(this.seed ^ 0xfea7, ncx, ncy);
          const nbx = ncx * FEATURE_CELL + 3 + (nhh2 % (FEATURE_CELL - 6));
          const nby = ncy * FEATURE_CELL + 3 + ((nhh2 >>> 8) % (FEATURE_CELL - 6));
          const nb = this.computeBiomeOnly(nbx, nby);
          return nb === "meadow" || nb === "forest" || nb === "hills" || nb === "steppe" || nb === "taiga" || nb === "beach";
        })();
        if (nroll < TOWN_ROLL && !(nroll < HAMLET_ROLL && nsettled)) {
          const nhh = hash2(this.seed ^ 0xfea7, ncx, ncy);
          const mfx = ncx * FEATURE_CELL + 3 + (nhh % (FEATURE_CELL - 6));
          const mfy = ncy * FEATURE_CELL + 3 + ((nhh >>> 8) % (FEATURE_CELL - 6));
          near.push({ x: mfx, y: mfy, d: SITE_R + 6 });
        }
        if (ncy > cy || (ncy === cy && ncx >= cx)) continue;
        const nf = this.cellFeature(ncx, ncy);
        if (!nf) continue;
        const nr = nf.kind === "hamlet" ? SITE_R : nf.kind === "town" ? TOWN_R : nf.kind === "city" ? CITY_R : 0;
        if (!nr) continue;
        near.push({ x: nf.x, y: nf.y, d: nr + SITE_R + SETTLEMENT_GAP });
      }
    }
    const cand: { x: number; y: number }[] = [];
    for (let x = loX; x <= hiX; x++) {
      for (let y = loY; y <= hiY; y++) cand.push({ x, y });
    }
    cand.sort((a, b) => Math.abs(a.x - fx) + Math.abs(a.y - fy) - (Math.abs(b.x - fx) + Math.abs(b.y - fy)) || a.y - b.y || a.x - b.x);
    for (const c of cand) {
      let dry = true;
      site: for (let dy = -SITE_R; dy <= SITE_R && dry; dy++) {
        for (let dx = -SITE_R; dx <= SITE_R; dx++) {
          if (!this.inBounds(c.x + dx, c.y + dy) || !this.isDryLand(c.x + dx, c.y + dy)) {
            dry = false;
            break site;
          }
        }
      }
      if (!dry) continue;
      for (const n of near) {
        if (Math.max(Math.abs(c.x - n.x), Math.abs(c.y - n.y)) < n.d) {
          dry = false;
          break;
        }
      }
      if (dry) return c;
    }
    return null;
  }

  /**
   * The city of this city-region, if it can host one. A city's 69×69 site
   * spans several feature cells, so cities cannot be placed cell by cell:
   * each region of CITY_REGION×CITY_REGION cells either raises one city —
   * claimed before any lesser landmark of the region is placed, so nothing
   * else spawns inside its footprint — or none at all. Deterministic and
   * cached; the site search itself is metroSpot. Hamlet and town cells are
   * never claimed: existing settlements stay exactly where they were.
   */
  private regionCityStack = new Set<number>();

  private regionCity(rx: number, ry: number): { x: number; y: number; cx: number; cy: number } | null {
    const key = ry * 1024 + rx;
    const c = this.regionCityCache.get(key);
    if (c !== undefined) return c;
    // a region being placed sees no city of its own yet: nested lookups from
    // its own site search come back empty, and the city's veto against those
    // same cells closes the pair. The recursion is fixed by cell order, so
    // the result never depends on which tile asked first.
    if (this.regionCityStack.has(key)) return null;
    this.regionCityStack.add(key);
    let out: { x: number; y: number; cx: number; cy: number } | null = null;
    if (hash01(this.seed ^ 0xc17e, rx, ry) < 0.04) {
      // candidate cells: the region's interior, cells that decided against
      // being a hamlet or town — lesser landmarks yield to the city
      const lo = rx * CITY_REGION + 1;
      const hi = rx * CITY_REGION + CITY_REGION - 2;
      const loY = ry * CITY_REGION + 1;
      const hiY = ry * CITY_REGION + CITY_REGION - 2;
      const cand: { cx: number; cy: number }[] = [];
      for (let cy = loY; cy <= hiY; cy++) {
        for (let cx = lo; cx <= hi; cx++) {
          if (cx < 2 || cy < 2 || cx >= WORLD_SIZE / FEATURE_CELL - 2 || cy >= WORLD_SIZE / FEATURE_CELL - 2) continue;
          const roll = hash01(this.seed ^ 0xbead, cx, cy);
          // hamlet and town cells never yield; ruins, shrines, lairs and
          // empty cells can all be claimed by the city
          const settledCell = roll < HAMLET_ROLL || (roll >= TOWN_ROLL && roll < TOWN_VETO_END);
          if (settledCell) continue;
          cand.push({ cx, cy });
        }
      }
      const midX = rx * CITY_REGION + (CITY_REGION - 1) / 2;
      const midY = ry * CITY_REGION + (CITY_REGION - 1) / 2;
      cand.sort((a, b) => Math.abs(a.cx - midX) + Math.abs(a.cy - midY) - (Math.abs(b.cx - midX) + Math.abs(b.cy - midY)) || a.cy - b.cy || a.cx - b.cx);
      for (const { cx, cy } of cand) {
        const hh = hash2(this.seed ^ 0xfea7, cx, cy);
        const nfx = cx * FEATURE_CELL + 3 + (hh % (FEATURE_CELL - 6));
        const nfy = cy * FEATURE_CELL + 3 + ((hh >>> 8) % (FEATURE_CELL - 6));
        const spot = this.metroSpot(cx, cy, nfx, nfy, CITY_R, TOWN_R + SETTLEMENT_GAP + 12, null, false);
        if (!spot) continue;
        // cities of neighboring regions keep a full gap between their sites
        // too: whoever places second yields, and each regionCity lookup is
        // a fixed leaf computation, so the pair settles the same way however
        // the map is explored
        let close = false;
        for (let dy2 = -1; dy2 <= 1 && !close; dy2++) {
          for (let dx2 = -1; dx2 <= 1; dx2++) {
            const m = this.regionCity(Math.floor(cx / CITY_REGION) + dx2, Math.floor(cy / CITY_REGION) + dy2);
            if (m && !(m.cx === cx && m.cy === cy) && Math.max(Math.abs(spot.x - m.x), Math.abs(spot.y - m.y)) < CITY_R * 2 + SETTLEMENT_GAP) {
              close = true;
              break;
            }
          }
        }
        if (close) continue;
        out = { ...spot, cx, cy };
        break;
      }
    }
    this.regionCityStack.delete(key);
    this.regionCityCache.set(key, out);
    return out;
  }

  private regionCityCache = new Map<number, { x: number; y: number; cx: number; cy: number } | null>();

  /**
   * The nearest position in this feature cell that can host a whole 46×46
   * town site: every tile of the footprint on dry land, and clearance from
   * every neighboring feature's site. Neighboring hamlets are measured at
   * their realized positions; a cell decided to hold another town disqualifies
   * its whole neighborhood, which keeps town placement free of recursive
   * lookups while spreading regional centers apart. Deterministic ordering:
   * nearest to the hashed origin first, ties broken by position.
   */
  private metroSpot(cx: number, cy: number, fx: number, fy: number, R: number, setlNbR: number, minorR: number | null, hamlets = true): { x: number; y: number } | null {
    const x0 = cx * FEATURE_CELL - R - 1;
    const x1 = (cx + 1) * FEATURE_CELL + R;
    const y0 = cy * FEATURE_CELL - R - 1;
    const y1 = (cy + 1) * FEATURE_CELL + R;
    const W = x1 - x0 + 1;
    const dry = new Uint8Array(W * W);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        dry[(y - y0) * W + (x - x0)] = this.inBounds(x, y) && this.isDryLand(x, y) ? 1 : 0;
      }
    }
    // each neighbor demands this much center distance, edge to edge plus gap
    interface NB { x: number; y: number; d: number }
    const nbs: NB[] = [];
    const scan = 2 + Math.ceil(Math.max(0, R - SITE_R) / FEATURE_CELL);
    for (let dy = -scan; dy <= scan; dy++) {
      for (let dx = -scan; dx <= scan; dx++) {
        if (!dx && !dy) continue;
        const ncx = cx + dx;
        const ncy = cy + dy;
        if (ncx < 0 || ncy < 0) continue;
        const hh = hash2(this.seed ^ 0xfea7, ncx, ncy);
        const roll = hash01(this.seed ^ 0xbead, ncx, ncy);
        const nfx = ncx * FEATURE_CELL + 3 + (hh % (FEATURE_CELL - 6));
        const nfy = ncy * FEATURE_CELL + 3 + ((hh >>> 8) % (FEATURE_CELL - 6));
        const nsettledMinor = (() => {
          const nb = this.computeBiomeOnly(nfx, nfy);
          return nb === "meadow" || nb === "forest" || nb === "hills" || nb === "steppe" || nb === "taiga" || nb === "beach";
        })();
        if (roll < HAMLET_ROLL && nsettledMinor) {
          // a hamlet neighbor: measure its realized site, not its raw pick.
          // Earlier cells only — a later hamlet finds this site on its own
          // when its turn comes, and measuring it here would recurse.
          // Cities skip the veto outright: their region suppresses every
          // hamlet within CITY_R + 40 of the center, a stronger demand than
          // this veto makes, placed before any neighbor hamlet is decided.
          if (!hamlets) continue;
          if (ncy > cy || (ncy === cy && ncx >= cx)) continue;
          const spot = this.drySettlementSpot(ncx, ncy, nfx, nfy);
          if (spot) nbs.push({ x: spot.x, y: spot.y, d: R + SITE_R + SETTLEMENT_GAP });
        } else if (roll < TOWN_ROLL) {
          // ruin, shrine or lair: sites at most 6 tiles across — including
          // the unsettled below-hamlet cells the first branch no longer takes.
          // Cities skip
          // this veto — their region suppresses lesser landmarks inside the
          // reserved site instead of demanding an empty wilderness.
          if (minorR !== null) nbs.push({ x: nfx, y: nfy, d: R + minorR + 1 });
        } else if (roll < TOWN_VETO_END) {
          // a cell that would also host a town or city: keep well apart, and
          // never recurse into its own site search (determinism has no
          // cycles). The veto anchors to the cell's middle, a half-cell of
          // slack from the realized spot, so the demand carries the gap plus
          // that slack.
          nbs.push({ x: ncx * FEATURE_CELL + 12, y: ncy * FEATURE_CELL + 12, d: R + setlNbR });
        }
      }
    }
    const cand: { x: number; y: number }[] = [];
    for (let x = cx * FEATURE_CELL; x < (cx + 1) * FEATURE_CELL; x++) {
      for (let y = cy * FEATURE_CELL; y < (cy + 1) * FEATURE_CELL; y++) cand.push({ x, y });
    }
    cand.sort((a, b) => Math.abs(a.x - fx) + Math.abs(a.y - fy) - (Math.abs(b.x - fx) + Math.abs(b.y - fy)) || a.y - b.y || a.x - b.x);
    for (const c of cand) {
      let ok = true;
      site: for (let dy = -R; dy <= R && ok; dy++) {
        const row = (c.y + dy - y0) * W;
        for (let dx = -R; dx <= R; dx++) {
          if (!dry[row + c.x + dx - x0]) {
            ok = false;
            break site;
          }
        }
      }
      if (!ok) continue;
      for (const n of nbs) {
        if (Math.max(Math.abs(c.x - n.x), Math.abs(c.y - n.y)) < n.d) {
          ok = false;
          break;
        }
      }
      if (ok) return c;
    }
    return null;
  }

  private computeBiomeOnly(x: number, y: number): BiomeId {
    const key = y * WORLD_SIZE + x;
    const c = this.cache.get(key);
    if (c) return c.biome;
    return this.compute(x, y, false).biome;
  }

  private featureAt(x: number, y: number, biome: BiomeId): Feature | null {
    if (!BIOMES[biome].passable) return null;
    const f = this.cellFeature(Math.floor(x / FEATURE_CELL), Math.floor(y / FEATURE_CELL));
    return f && f.x === x && f.y === y ? f : null;
  }

  /**
   * The physical structure piece (wall/floor/door) at a tile, if it lies within
   * a landmark's footprint — settlement gateposts included. Pure function of
   * the seed — hamlets, ruins, lairs and shrines are real built places the
   * party can walk into, CoQ-style.
   */
  siteAt(x: number, y: number): SitePiece | null {
    if (!this.inBounds(x, y)) return null;
    const key = y * WORLD_SIZE + x;
    const c = this.siteCache.get(key);
    if (c !== undefined) return c;
    let out: SitePiece | null = null;
    const cx = Math.floor(x / FEATURE_CELL);
    const cy = Math.floor(y / FEATURE_CELL);
    // a city's 69-tile footprint spans four feature cells, so the scan reaches
    // two cells out — a 3×3 sweep silently dropped the fringe of every big
    // settlement, leaving its far buildings and gates intangible.
    // Pass one: gateposts outrank every base piece, so a neighbor's open
    // ground can never shadow the solid post of a settlement's gate.
    outerPosts: for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const f = this.cellFeature(cx + dx, cy + dy);
        if (!f || !isSettlement(f)) continue;
        if (this.gatepostsOf(f).has(this.postKey(x - f.x, y - f.y))) {
          out = { kind: f.kind, feature: f, wall: true, door: false, rubble: false, post: true };
          break outerPosts;
        }
      }
    }
    if (!out) {
      outer: for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const f = this.cellFeature(cx + dx, cy + dy);
          if (!f) continue;
          const p = this.sitePiece(f, x - f.x, y - f.y);
          if (p) {
            out = p;
            break outer;
          }
        }
      }
    }
    this.siteCache.set(key, out);
    return out;
  }

  /**
   * The built structure at a tile ignoring gateposts — the view the entrance
   * survey uses, so entrance selection never depends on which neighbors'
   * gateposts happened to be computed first.
   */
  baseSiteAt(x: number, y: number): SitePiece | null {
    if (!this.inBounds(x, y)) return null;
    const cx = Math.floor(x / FEATURE_CELL);
    const cy = Math.floor(y / FEATURE_CELL);
    // the same 5×5 sweep siteAt uses — a city spans four feature cells
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const f = this.cellFeature(cx + dx, cy + dy);
        if (!f) continue;
        const p = this.sitePiece(f, x - f.x, y - f.y);
        if (p) return p;
      }
    }
    return null;
  }

  /** Feature-local key of a tile near a feature (footprints span at most 69 tiles; 128-wide rows are safe). */
  private postKey(lx: number, ly: number): number {
    return (ly + 64) * 128 + (lx + 64);
  }

  /**
   * The solid gatepost tiles flanking a settlement's deliberate entrances, as
   * feature-local keys — one post per side, one step out along the approach,
   * where the ground allows it. Town and city gates sit on their ring road, so
   * the posts flank the approach outside it and the ring stays open. These
   * make an entrance a real passage: two posts, the road between, not a gap
   * in a sprite layer. Pure function of the seed; cached per settlement.
   */
  private gatepostsOf(f: Feature): Set<number> {
    const key = `${f.x}:${f.y}`;
    const c = this.postCache.get(key);
    if (c) return c;
    // entrance selection reads ground via siteAt; guard the re-entry (a
    // settlement's own posts never collide with its own entrance candidates,
    // and the settlement gap keeps every other settlement's posts far off)
    if (this.posting.has(key)) return EMPTY_POSTS;
    this.posting.add(key);
    const out = new Set<number>();
    const entrances = settlementEntrances(this, f);
    for (const e of entrances) {
      const outX = e.dir === "w" ? -1 : e.dir === "e" ? 1 : 0;
      const outY = e.dir === "n" ? -1 : e.dir === "s" ? 1 : 0;
      const perpX = outY !== 0 ? 1 : 0;
      const perpY = outX !== 0 ? 1 : 0;
      for (const s of [-1, 1]) {
        // per side, the first workable flank wins: just outside the gate, a
        // step further out, beside the entrance itself, or just inside it
        const tries: [number, number][] = [
          [e.x + outX + perpX * s, e.y + outY + perpY * s],
          [e.x + 2 * outX + perpX * s, e.y + 2 * outY + perpY * s],
          [e.x + perpX * s, e.y + perpY * s],
          [e.x - outX + perpX * s, e.y - outY + perpY * s],
        ];
        for (const [x, y] of tries) {
          if (!this.inBounds(x, y)) continue;
          if (entrances.some((o) => o.x === x && o.y === y)) continue;
          const b = this.tile(x, y).biome;
          if (b === "river" || b === "lake" || b === "sea" || b === "deep" || b === "peak") continue;
          const site = this.baseSiteAt(x, y);
          if (site?.wall || site?.door || site?.buildingId) continue;
          out.add(this.postKey(x - f.x, y - f.y));
          break;
        }
      }
    }
    this.posting.delete(key);
    this.postCache.set(key, out);
    return out;
  }

  private sitePiece(f: Feature, lx: number, ly: number): SitePiece | null {
    const ax = Math.abs(lx);
    const ay = Math.abs(ly);
    const mk = (wall: boolean, door = false, rubble = false): SitePiece => ({ kind: f.kind, feature: f, wall, door, rubble });
    // a tier-hamlet settlement is composed of procedurally generated multi-room
    // buildings on fixed plots around the village green; larger tiers get their
    // own site layouts when the procedural generator arrives
    const tier = settlementTier(f);
    if (tier === "hamlet" || tier === "town" || tier === "city") {
      const half = tier === "city" ? CITY_R : tier === "town" ? TOWN_R : SITE_R;
      if (ax > half || ay > half) return null;
      const e = this.settlementLayout(f).piece(lx, ly);
      if (e) {
        return {
          kind: f.kind,
          feature: f,
          wall: e.kind === "wall",
          door: e.kind === "door",
          rubble: false,
          buildingId: e.building.id,
          roomId: e.room?.id,
          reservedFor: e.reservedFor,
        };
      }
      // streets, green and open lots: reserved public ground, walkable
      if (tier !== "hamlet") return mk(false);
      const inPlaza = lx * lx + ly * ly <= PLAZA_R2;
      if (!inPlaza) return null;
      return mk(false);
    }
    if (f.kind === "ruin") {
      if (ax > 4 || ay > 4) return null;
      const gap = (x: number, y: number): boolean => hash2(this.seed ^ 0xbe11, f.x * 97 + x, f.y * 97 + y) % 10 < 4;
      let wall = false;
      if (ax === 4 || ay === 4) wall = !gap(lx, ly);
      else if (ly === 0 && lx >= -2 && lx <= 2 && lx !== 0) wall = !gap(lx, ly);
      else if (lx === -3 && ly >= -2 && ly <= 2) wall = !gap(lx, ly);
      const rubble = !wall && hash2(this.seed ^ 0x1e11, f.x * 31 + lx, f.y * 31 + ly) % 10 < 2;
      return mk(wall, false, rubble);
    }
    if (f.kind === "lair") {
      const d = Math.hypot(lx, ly);
      if (d > 5.2) return null;
      const ent = DIRS8[hash2(this.seed ^ 0x1a17, f.x, f.y) % 8];
      const ea = Math.atan2(ent[1], ent[0]);
      let diff = Math.abs(Math.atan2(ly, lx) - ea);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (d <= 3.6) return mk(false);
      const entrance = d <= 5.2 && diff < 0.45;
      return mk(!entrance, entrance && d > 4.4);
    }
    // shrine: a ring of standing stones around a mossy altar floor
    if (ax > 3 || ay > 3) return null;
    if (Math.hypot(lx, ly) > 3.3) return null;
    const stone = (ax === 3 && ly === 0) || (ay === 3 && lx === 0) || (ax === 2 && ay === 2);
    return mk(stone);
  }

  /** Deterministically choose a species that lives in a biome. */
  pickSpecies(biome: BiomeId, h: number): string | null {
    const entries: [string, number][] = [];
    for (const s of SPECIES_LIST) {
      const w = s.biomes[biome] ?? 0;
      if (w > 0) entries.push([s.id, w]);
    }
    const total = entries.reduce((a, [, w]) => a + w, 0);
    if (total <= 0) return null;
    let r = (h / 4294967296) * total;
    for (const [id, w] of entries) {
      r -= w;
      if (r <= 0) return id;
    }
    return entries[entries.length - 1][0];
  }

  private npcCache = new Map<string, Npc[]>();

  /** The building-tile query shared by every settlement layout. */
  private pieceOf(f: Feature, buildings: Building[]) {
    return (lx: number, ly: number): SettlementPiece | null => {
      for (const b of buildings) {
        const blx = lx - b.x + f.x;
        const bly = ly - b.y + f.y;
        if (blx < 0 || bly < 0 || blx >= b.w || bly >= b.h) continue;
        const kind = b.cells[bly * b.w + blx];
        let room: BuildingRoom | null = null;
        for (const r of b.rooms) if (blx >= r.x0 && blx <= r.x1 && bly >= r.y0 && bly <= r.y1) room = r;
        const door = b.doors.find((d) => d.lx === blx && d.ly === bly) ?? null;
        const spot = b.reserved.find((s) => s.lx === blx && s.ly === bly);
        return { building: b, kind, room, door, reservedFor: kind === "reserved" ? spot?.purpose : undefined };
      }
      return null;
    };
  }

  /**
   * The built layout of a settlement: its multi-room buildings, generated once
   * per settlement and cached. Pure function of the world seed + settlement
   * identity + building identity — nothing about buildings is persisted.
   */
  settlementLayout(f: Feature): SettlementLayout {
    const key = `${f.x}:${f.y}`;
    const c = this.layoutCache.get(key);
    if (c) return c;
    const seed = settlementSeed(this.seed, f);
    const tier = settlementTier(f);
    if (tier === "town" || tier === "city") {
      const t = tier === "city"
        ? generateCity({ id: `c:${f.x}:${f.y}`, seed, fx: f.x, fy: f.y, exteriorOk: (x, y) => this.inBounds(x, y) && BIOMES[this.tile(x, y).biome].passable })
        : generateTown({ id: `t:${f.x}:${f.y}`, seed, fx: f.x, fy: f.y, exteriorOk: (x, y) => this.inBounds(x, y) && BIOMES[this.tile(x, y).biome].passable });
      const layout: SettlementLayout = {
        buildings: t.buildings,
        piece: this.pieceOf(f, t.buildings),
        building(type) {
          return t.buildings.find((b) => b.type === type) ?? null;
        },
        urban: t.plan,
      };
      this.layoutCache.set(key, layout);
      return layout;
    }
    const buildings: Building[] = SERVICE_PLOTS.map((plot, i) =>
      generateBuilding({
        id: `b:${f.x}:${f.y}:${plot.type}`,
        seed: hash2(seed ^ 0x8d1a, f.x * 3 + i, f.y * 5 + i * 7),
        template: BUILDING_TEMPLATES[plot.type],
        plot: { w: plot.x1 - plot.x0 + 1, h: plot.y1 - plot.y0 + 1 },
        origin: { x: f.x + plot.x0, y: f.y + plot.y0 },
        exitOk: (side, wx, wy) => {
          if (!this.inBounds(wx, wy)) return false;
          if (!BIOMES[this.tile(wx, wy).biome].passable) return false;
          // every entrance faces the heart of the settlement: the ground a door
          // opens onto must sit closer to the feature tile than the door itself
          const [nx, ny] = DIR_DELTA[side];
          const d2 = (px: number, py: number): number => (px - f.x) ** 2 + (py - f.y) ** 2;
          if (d2(wx, wy) >= d2(wx - nx, wy - ny)) return false;
          // the entrance must open onto ground no other building claims
          return !SERVICE_PLOTS.some((p) => p !== plot && wx >= f.x + p.x0 && wx <= f.x + p.x1 && wy >= f.y + p.y0 && wy <= f.y + p.y1);
        },
      }),
    );
    const layout: SettlementLayout = {
      buildings,
      piece: this.pieceOf(f, buildings),
      building(type) {
        return buildings.find((b) => b.type === type) ?? null;
      },
    };
    this.layoutCache.set(key, layout);
    return layout;
  }

  /**
   * The folk of a settlement, each standing outside their building's entrance.
   * Deterministic from the seed — nothing about them is persisted.
   */
  settlementNpcs(f: Feature): Npc[] {
    const key = `${f.x}:${f.y}`;
    const c = this.npcCache.get(key);
    if (c) return c;
    const layout = this.settlementLayout(f);
    const NAMES = ["Marta", "Odd", "Fenn", "Bram", "Sela", "Torv", "Hesta", "Wick", "Grita", "Nol", "Asha", "Curd"];
    const LINES: Record<Npc["role"], string[]> = {
      innkeep: [
        "The hearth's warm and the soup is hot, if the soup is what you call it.",
        "Storm's coming. There is always a storm coming.",
        "Beds are soft, breakfast is grey, and both beat sleeping in a ditch.",
      ],
      trader: [
        "Fair prices! Mostly fair. Some would even say generous.",
        "You've the look of someone about to need a tonic.",
        "No refunds. The last customer knew that far too well.",
      ],
      penkeeper: [
        "Your beasts are safe here. Safer than I'd be out there.",
        "Mind the fence — the feisty one figured out the latch.",
        "Fresh hay twice a day. They eat better than I do.",
      ],
      resident: ["There's always work for hands that aren't afraid of feathers."],
      recruiter: ["Any beast of spirit deserves a tamer of the same. Care to hear about the associations?"],
      traveler: ["The road's the same in both directions. It's the arriving that differs."],
    };
    // each folk member stands just outside their building's entrance; if that
    // tile is blocked, a deterministic spiral search finds nearby open ground
    const ROLE_OF: Partial<Record<BuildingType, Npc["role"]>> = { inn: "innkeep", trader: "trader", pen: "penkeeper" };
    const posts: { x: number; y: number }[] = [];
    const free = (x: number, y: number): boolean => {
      if (!this.inBounds(x, y) || !BIOMES[this.tile(x, y).biome].passable) return false;
      const s = this.siteAt(x, y);
      if (s?.wall || s?.door) return false;
      return !posts.some((p) => p.x === x && p.y === y);
    };
    const findPost = (sx: number, sy: number): { x: number; y: number } => {
      if (free(sx, sy)) return { x: sx, y: sy };
      for (let r = 1; r <= 4; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            if (free(sx + dx, sy + dy)) return { x: sx + dx, y: sy + dy };
          }
        }
      }
      return { x: sx, y: sy };
    };
    const spots: { role: Npc["role"]; x: number; y: number }[] = [];
    for (const b of layout.buildings) {
      const role = ROLE_OF[b.type];
      if (!role) continue;
      const door = b.doors.find((d) => d.external && d.dir);
      if (!door || !door.dir) continue;
      const [ddx, ddy] = DIR_DELTA[door.dir];
      const post = findPost(b.x + door.lx + ddx, b.y + door.ly + ddy);
      posts.push(post);
      spots.push({ role, x: post.x, y: post.y });
    }
    const npcs = spots.map(({ role, x, y }, i) => {
      const h = hash2(this.seed ^ 0x9bc7, f.x * 7 + i * 11, f.y * 13 + i * 5);
      const lines = LINES[role];
      return { role, name: NAMES[h % NAMES.length], settlement: f.name, x, y, line: lines[(h >>> 8) % lines.length] };
    });
    this.npcCache.set(key, npcs);
    return npcs;
  }

  /** The settlement folk member — or traveler on the road — standing at this tile, if any. */
  npcAt(x: number, y: number, tick = 0): Npc | null {
    for (const f of this.featuresNear(x, y, CITY_R + 1)) {
      if (!isSettlement(f)) continue;
      for (const n of this.settlementPopulation(f, tick)) if (n.x === x && n.y === y) return n;
    }
    for (const t of this.roadTravelers(tick)) if (t.x === x && t.y === y) return t;
    return null;
  }

  /* --------------------------- wandering residents --------------------------- */

  /** The walkable, unbuilt public ground inside a settlement's footprint. */
  private publicCache = new Map<string, { x: number; y: number }[]>();

  private publicTiles(f: Feature): { x: number; y: number }[] {
    const key = `${f.x}:${f.y}`;
    const c = this.publicCache.get(key);
    if (c) return c;
    const r = getSettlementFootprint(settlementTier(f) ?? "hamlet").w >> 1;
    const out: { x: number; y: number }[] = [];
    // the settlement's own gate tiles are thresholds too — residents keep off them
    const gates = new Set(settlementEntrances(this, f).map((e) => e.y * WORLD_SIZE + e.x));
    for (let ly = -r; ly <= r; ly++) {
      for (let lx = -r; lx <= r; lx++) {
        const wx = f.x + lx;
        const wy = f.y + ly;
        if (!this.passable(wx, wy)) continue;
        const s = this.siteAt(wx, wy);
        if (!s || s.wall || s.door || s.buildingId) continue;
        // leave the ground just outside every entrance clear — thresholds stay usable
        const byDoor = DIRS8.some(([dx, dy]) => this.siteAt(wx + dx, wy + dy)?.door);
        if (byDoor) continue;
        if (gates.has(wy * WORLD_SIZE + wx)) continue;
        out.push({ x: wx, y: wy });
      }
    }
    // wandering happens on the green's own connected patch of public ground:
    // pockets sealed off by buildings are not worth a resident's day
    const index = new Map<number, number>(out.map((p, i) => [p.y * WORLD_SIZE + p.x, i]));
    let core = -1;
    let coreD = Infinity;
    for (let i = 0; i < out.length; i++) {
      const d = Math.abs(out[i].x - f.x) + Math.abs(out[i].y - f.y);
      if (d < coreD) {
        coreD = d;
        core = i;
      }
    }
    const keep = new Set<number>([core]);
    const q = [core];
    while (q.length) {
      const cur = q.shift()!;
      const cx = out[cur].x;
      const cy = out[cur].y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = index.get((cy + dy) * WORLD_SIZE + cx + dx);
        if (ni !== undefined && !keep.has(ni)) {
          keep.add(ni);
          q.push(ni);
        }
      }
    }
    const pooled = core >= 0 ? out.filter((_, i) => keep.has(i)) : out;
    this.publicCache.set(key, pooled);
    return pooled;
  }

  /**
   * One resident's position for every tick of a day, replayed deterministically
   * from the seed: a slow potter around the public ground — pick a reachable
   * public tile (biased toward the green), walk to it one step at a time,
   * pick another. Nothing about it is persisted and no pathfinding runs at
   * interaction time; the whole day is simulated once per settlement and cached.
   */
  private residentCache = new Map<string, { x: number; y: number }[]>();

  private residentTimeline(f: Feature, idx: number, homes: Building[], occupied: { x: number; y: number }[] = []): { x: number; y: number }[] {
    const key = `${f.x}:${f.y}:${idx}`;
    const c = this.residentCache.get(key);
    if (c) return c;
    const seed = settlementSeed(this.seed, f);
    const pool = this.publicTiles(f);
    const index = new Map<number, number>(pool.map((p, i) => [p.y * WORLD_SIZE + p.x, i]));
    const at = (i: number): number => index.get(i) ?? -1;
    // flood once per window: a resident only ever picks a target it can reach
    const flood = (start: number): number[] => {
      const seen = new Set<number>([start]);
      const q = [start];
      while (q.length) {
        const cur = q.shift()!;
        const cx = pool[cur].x;
        const cy = pool[cur].y;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = at((cy + dy) * WORLD_SIZE + cx + dx);
          if (ni >= 0 && !seen.has(ni)) {
            seen.add(ni);
            q.push(ni);
          }
        }
      }
      return [...seen];
    };
    const came = new Map<number, number>();
    const route = (start: number, goal: number): number[] => {
      if (start === goal) return [];
      came.clear();
      came.set(start, -1);
      const q = [start];
      while (q.length) {
        const cur = q.shift()!;
        if (cur === goal) break;
        const cx = pool[cur].x;
        const cy = pool[cur].y;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = at((cy + dy) * WORLD_SIZE + cx + dx);
          if (ni >= 0 && !came.has(ni)) {
            came.set(ni, cur);
            q.push(ni);
          }
        }
      }
      if (!came.has(goal)) return [];
      const path: number[] = [];
      for (let cur = goal; cur !== start; cur = came.get(cur)!) path.unshift(cur);
      return path;
    };

    const home = homes[idx % homes.length];
    const door = home.doors.find((d) => d.external && d.dir);
    const h0 = hash2(seed ^ 0x3e5d, f.x * 3 + idx, f.y * 7 + idx * 11);
    // the day starts at the resident's own doorstep — the public tile nearest
    // the home's entrance (thresholds themselves stay clear)
    const doorTile = door && door.dir ? { x: home.x + door.lx, y: home.y + door.ly } : { x: f.x, y: f.y };
    let cur = -1;
    let bestD = Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (occupied.some((o) => o.x === pool[i].x && o.y === pool[i].y)) continue;
      const d = Math.abs(pool[i].x - doorTile.x) + Math.abs(pool[i].y - doorTile.y);
      if (d < bestD) {
        bestD = d;
        cur = i;
      }
    }
    if (cur < 0) cur = 0;
    const d2c = (p: { x: number; y: number }): number => (p.x - f.x) ** 2 + (p.y - f.y) ** 2;
    const WINDOW = 36;
    const STEP = 4;
    // later residents politely keep off the earlier one's tile as they go —
    // timelines are cached in index order, so the earlier one always exists
    const earlier = idx > 0 ? this.residentTimeline(f, idx - 1, homes, occupied) : null;
    const tl: { x: number; y: number }[] = [];
    let path: number[] = [];
    for (let t = 0; t < DAY_TICKS; t++) {
      if (t % WINDOW === 0) {
        const reach = flood(cur);
        const plaza = reach.filter((i) => d2c(pool[i]) <= PLAZA_R2);
        // two windows in three head for the green — residents prefer public space
        const biased = plaza.length && ((h0 >>> (t / WINDOW)) % 3 < 2) ? plaza : reach;
        const goal = biased[(h0 + t * 0x9e37) % biased.length] ?? cur;
        path = route(cur, goal);
      }
      if (t % STEP === 0 && path.length) {
        const next = path[0];
        // a resident pauses rather than step onto a colleague's or a folk
        // member's post — one tile, one person
        const posted = occupied.some((o) => o.x === pool[next].x && o.y === pool[next].y);
        if (!posted && (!earlier || earlier[t].x !== pool[next].x || earlier[t].y !== pool[next].y)) {
          path.shift();
          cur = next;
        }
      }
      tl.push({ ...pool[cur] });
    }
    this.residentCache.set(key, tl);
    return tl;
  }

  /**
   * The wandering residents of a settlement, positions at the given tick.
   * Deterministic: the same world seed + settlement + tick yields the same
   * people in the same places.
   */
  settlementResidents(f: Feature, tick: number): Npc[] {
    const homes = this.settlementLayout(f).buildings.filter((b) => b.type === "small_home" || b.type === "medium_home");
    const tier = settlementTier(f);
    const want = tier === "city" ? 6 : tier === "town" ? 4 : 2;
    const NAMES = ["Ista", "Col", "Merrit", "Dagna", "Osric", "Petra", "Quill", "Ansel"];
    const LINES = [
      "Mind the pens after dark — the young ones bite.",
      "Quiet day. Quiet days never last out here.",
      "You'll be the tamer everyone's on about, then.",
      "The green's for walking. The wild's for the rest.",
    ];
    const out: Npc[] = [];
    const h0 = hash2(this.seed ^ 0x7e5d, f.x * 5, f.y * 11);
    // residents never share a name: 0x9e37 is coprime with the name-count
    // power of two, so stepping it walks every name exactly once.
    // Folk posts and the recruiter's green are occupied all day — timelines
    // treat them as walls, so npcAt always resolves the right person
    const rec = this.settlementRecruiter(f);
    const occupied = [...this.settlementNpcs(f).map((n) => ({ x: n.x, y: n.y })), ...(rec ? [{ x: rec.x, y: rec.y }] : [])];
    for (let i = 0; i < want && i < homes.length; i++) {
      const tl = this.residentTimeline(f, i, homes, occupied);
      const p = tl[((tick % tl.length) + tl.length) % tl.length];
      const h = hash2(this.seed ^ 0x7e5d, f.x * 5 + 3 * i, f.y * 11 + 13 * i);
      out.push({
        role: "resident",
        name: NAMES[(h0 + i * 0x9e37) % NAMES.length],
        settlement: f.name,
        x: p.x,
        y: p.y,
        line: LINES[(h >>> 10) % LINES.length],
        home: homes[i].type,
        variant: (h >>> 14) % 4,
      });
    }
    return out;
  }

  /**
   * The association recruiter posted on the village green. The slot names which
   * of the local nation's associations this recruiter speaks for — resolved to
   * a real charter by the dialogue layer, never fabricated here.
   */
  settlementRecruiter(f: Feature): Npc | null {
    const key = `${f.x}:${f.y}:rec`;
    const c = this.recruiterCache.get(key);
    if (c !== undefined) return c;
    const posts = this.settlementNpcs(f).map((n) => ({ x: n.x, y: n.y }));
    const free = (x: number, y: number): boolean => {
      if (!this.passable(x, y)) return false;
      const s = this.siteAt(x, y);
      if (s?.wall || s?.door || s?.buildingId) return false;
      return !posts.some((p) => p.x === x && p.y === y);
    };
    // a post on the green, a little south of the well-traveled heart of town
    let spot: { x: number; y: number } | null = null;
    for (let rad = 0; rad <= 6 && !spot; rad++) {
      for (let dy = -rad; dy <= rad && !spot; dy++) {
        for (let dx = -rad; dx <= rad && !spot; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          const x = f.x + dx;
          const y = f.y + 2 + dy;
          if (free(x, y)) spot = { x, y };
        }
      }
    }
    let npc: Npc | null = null;
    if (spot) {
      const h = hash2(this.seed ^ 0xadc0, f.x, f.y);
      npc = {
        role: "recruiter",
        name: ["Bren", "Halvard", "Ysolt", "Maro"][(h >>> 4) % 4],
        settlement: f.name,
        x: spot.x,
        y: spot.y,
        line: "Any beast of spirit deserves a tamer of the same. Care to hear about the associations?",
        assocSlot: h % 3,
      };
    }
    this.recruiterCache.set(key, npc);
    return npc;
  }

  private recruiterCache = new Map<string, Npc | null>();

  /** Everyone alive in a settlement at the given tick: folk, recruiter, residents. */
  settlementPopulation(f: Feature, tick: number): Npc[] {
    const rec = this.settlementRecruiter(f);
    return rec ? [...this.settlementNpcs(f), rec, ...this.settlementResidents(f, tick)] : [...this.settlementNpcs(f), ...this.settlementResidents(f, tick)];
  }

  /* ------------------------------ road travelers ----------------------------- */

  private travelCache: { tick: number; npcs: Npc[] } | null = null;

  /** The road corridors long enough to carry a walker, with each walker's pace offset. */
  private travelRoads(net: ReturnType<typeof roadNetworkOf>): { road: (typeof net.roads)[number]; offset: number; going: number }[] {
    const out: { road: (typeof net.roads)[number]; offset: number; going: number }[] = [];
    for (const r of net.roads) {
      if (r.status !== "built" || !r.route || r.route.length < 24) continue;
      const h = hash2(this.seed ^ 0x7a11, r.a.length * 97 + r.b.length * 31, r.shared * 13 + r.route.length);
      if (h % 100 >= 60) continue;
      out.push({ road: r, offset: h >>> 4, going: (h >>> 12) % 2 });
    }
    return out;
  }

  /**
   * The folk currently walking the roads between settlements, at this tick.
   * A traveler's whole life is their road: they pace it from end to end and
   * back, one step every three ticks — the same unhurried pace as a wandering
   * resident. Positions are a pure function of seed, road and tick; nothing
   * about them is persisted. Mid-build networks contribute the roads surveyed
   * so far, exactly like the map does.
   */
  roadTravelers(tick: number): Npc[] {
    if (this.travelCache && this.travelCache.tick === tick) return this.travelCache.npcs;
    const net = roadNetworkOf(this);
    const NAMES = ["Ruth", "Sorrel", "Vane", "Keel", "Osla", "Pike", "Maud", "Tarn"];
    const out: Npc[] = [];
    for (const { road, offset, going } of this.travelRoads(net)) {
      const route = road.route!;
      const period = Math.max(2, (route.length - 1) * 2);
      const ph = (tick * 3 + offset) % period;
      const idx = Math.round(ph <= route.length - 1 ? ph : period - ph);
      const p = route[idx];
      // the settlement they set out from this leg, and the one they are bound for
      const fromB = going === 0 ? ph > route.length - 1 : ph <= route.length - 1;
      const origin = net.byId.get(fromB ? road.b : road.a);
      const dest = net.byId.get(fromB ? road.a : road.b);
      const originF = origin ? this.tile(origin.x, origin.y).feature : null;
      const destF = dest ? this.tile(dest.x, dest.y).feature : null;
      // the walker's name belongs to the road, not to the leg — turning around
      // at the far end must not change who they are
      const h = hash2(this.seed ^ hashString(road.id), 0x4e2d, road.route!.length);
      out.push({
        role: "traveler",
        name: NAMES[(h >>> 2) % NAMES.length],
        settlement: originF?.name ?? "the road",
        x: p.x,
        y: p.y,
        line: "The road's the same in both directions. It's the arriving that differs.",
        variant: (h >>> 8) % 4,
        boundFor: destF?.name,
      });
    }
    this.travelCache = { tick, npcs: out };
    return out;
  }


  private allCache: Feature[] | null = null;

  /** The feature of one feature cell, or null — public access for chunked
   *  full-world surveys (the road network enumerates the map in slices). */
  featureCell(cx: number, cy: number): Feature | null {
    const cells = WORLD_SIZE / FEATURE_CELL;
    if (cx < 0 || cy < 0 || cx >= cells || cy >= cells) return null;
    return this.cellFeature(cx, cy);
  }

  /**
   * Every map feature, row-major by feature cell — the deterministic full census
   * (diagnostics enumerate the world from here). Cached once per world; the
   * feature grid itself is already memoized.
   */
  allFeatures(): Feature[] {
    if (this.allCache) return this.allCache;
    const out: Feature[] = [];
    const cells = WORLD_SIZE / FEATURE_CELL;
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const f = this.cellFeature(cx, cy);
        if (f) out.push(f);
      }
    }
    this.allCache = out;
    return out;
  }

  featuresNear(x: number, y: number, radius: number): Feature[] {
    const out: Feature[] = [];
    const c0x = Math.floor((x - radius) / FEATURE_CELL);
    const c1x = Math.floor((x + radius) / FEATURE_CELL);
    const c0y = Math.floor((y - radius) / FEATURE_CELL);
    const c1y = Math.floor((y + radius) / FEATURE_CELL);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        if (cx < 0 || cy < 0) continue;
        const f = this.cellFeature(cx, cy);
        if (f && Math.abs(f.x - x) <= radius && Math.abs(f.y - y) <= radius) out.push(f);
      }
    }
    return out;
  }

  regionName(x: number, y: number): string {
    const rx = Math.floor(x / REGION_CELL);
    const ry = Math.floor(y / REGION_CELL);
    const key = ry * 1000 + rx;
    const c = this.regionCache.get(key);
    if (c) return c;
    const h = hash2(this.seed ^ 0x4e61, rx, ry);
    const name = NAME_A[h % NAME_A.length] + NAME_B[(h >>> 9) % NAME_B.length];
    this.regionCache.set(key, name);
    return name;
  }

  tileTitle(t: TileInfo): string {
    if (t.feature) return t.feature.name;
    const list = ADJ[t.biome];
    const h = hash2(this.seed ^ 0xad1, Math.floor(t.x / 6), Math.floor(t.y / 6));
    return `${list[h % list.length]} ${BIOMES[t.biome].noun}`;
  }

  weather(x: number, y: number, tick: number): WeatherInfo {
    const t = this.tile(x, y);
    const time = timeOf(tick);
    const season = seasonIndex(tick);
    const hr = time.hour + time.minute / 60;
    const tt = tick / 260;
    const cloud = this.weatherN.fbm(x / 340 + tt, y / 340 - tt * 0.6, 3) + (t.moist - 0.5) * 0.35 + (season === 2 ? 0.06 : 0);
    const wind = clamp01(0.45 + this.windN.fbm(x / 500 - tt * 0.8, y / 500 + tt, 2) * 1.4 + (t.biome === "steppe" || t.biome === "desert" ? 0.15 : 0));
    const diurnal = -5 * Math.cos(((hr - 3) / 24) * Math.PI * 2);
    let temp = t.baseTemp + SEASON_TEMP[season] + diurnal - Math.max(0, cloud) * 4;
    let id: WeatherId = "clear";
    if (t.biome === "desert") {
      id = wind > 0.78 ? "sandstorm" : cloud > 0.3 ? "cloudy" : "clear";
    } else if (cloud > 0.26 && t.moist > 0.3) {
      if (temp < 0.5) id = "snow";
      else id = cloud > 0.42 ? "storm" : "rain";
    } else if (hr >= 4 && hr < 9 && t.moist > 0.58 && cloud > -0.05) id = "fog";
    else if (cloud > 0.1) id = "cloudy";
    if (id === "rain" || id === "storm") temp -= 2;
    temp = Math.round(temp * 10) / 10;
    const humidity = Math.round(clamp01(t.moist * 0.6 + (cloud + 0.4) * 0.45 + (id === "rain" || id === "storm" ? 0.2 : 0) + (id === "fog" ? 0.25 : 0) - (t.biome === "desert" ? 0.35 : 0)) * 100);
    return { id, temp, humidity, wind, cloud };
  }

  /** Whether a forageable item is present here right now, given depletion records.
   *  Placement is stable per seed — plants are physical map objects that deplete
   *  when eaten and regrow after two days, they do not pop in and out. What grows
   *  where follows the local land: damp ground grows fungi, honey only ripens
   *  while the bees fly, nothing grows inside standing walls, and riverbanks are
   *  richer than dry ground. */
  forage(x: number, y: number, tick: number, depleted: Record<string, number>): ItemId | null {
    const t = this.tile(x, y);
    const b = BIOMES[t.biome];
    if (b.forage.length === 0) return null;
    if (this.siteAt(x, y)?.wall) return null;
    if (this.siteAt(x, y)?.buildingId) return null; // wild plants do not sprout indoors
    const key = `${x},${y}`;
    const dep = depleted[key];
    if (dep !== undefined && tick - dep < DAY_TICKS * 2) return null;
    const season = seasonIndex(tick);
    const mult = season === 3 ? 0.45 : season === 1 ? 1.15 : 1;
    // riparian fertility: ground beside open water grows more
    const nearWater = (dx: number, dy: number): boolean => {
      const nb = this.tile(x + dx, y + dy).biome;
      return nb === "river" || nb === "lake" || nb === "sea" || nb === "deep";
    };
    const riparian = nearWater(1, 0) || nearWater(-1, 0) || nearWater(0, 1) || nearWater(0, -1);
    const chance = Math.min(1, b.forageChance * mult * (riparian ? 1.25 : 1));
    const roll = hash01(this.seed ^ 0xf00d, x, y);
    if (roll > chance) return null;
    // context keeps each item where it makes sense
    const table = b.forage.filter(([id]) => {
      if (id === "mushroom" && t.moist < 0.5) return false; // fungi need damp ground
      if (id === "honeycomb" && season === 3) return false; // the bees are dormant
      return true;
    });
    if (!table.length) return null;
    const h = hash2(this.seed ^ 0xf11d, x, y);
    const total = table.reduce((a, [, w]) => a + w, 0);
    let r = (h / 4294967296) * total;
    for (const [id, w] of table) {
      r -= w;
      if (r <= 0) return id;
    }
    return table[0][0];
  }

  /** Find a starting settlement near the heart of the world. */
  startPoint(): { x: number; y: number; name: string } {
    if (this.start) return this.start;
    const cx = Math.floor(WORLD_SIZE / 2);
    const cy = Math.floor(WORLD_SIZE * 0.56);
    let best: Feature | null = null;
    let bestD = Infinity;
    for (let ring = 0; ring < 40 && !best; ring++) {
      const r = ring * FEATURE_CELL;
      const fs = this.featuresNear(cx, cy, r + FEATURE_CELL);
      for (const f of fs) {
        if (!isSettlement(f)) continue;
        const tb = this.tile(f.x, f.y).biome;
        if (tb !== "meadow" && tb !== "forest" && tb !== "hills" && tb !== "steppe") continue;
        const d = Math.hypot(f.x - cx, f.y - cy);
        if (d < bestD) {
          bestD = d;
          best = f;
        }
      }
    }
    if (best) this.start = { x: best.x, y: best.y, name: best.name };
    else {
      let found = { x: cx, y: cy, name: "Wayfarer's Rest" };
      outer: for (let r = 0; r < 600; r += 3) {
        for (let a = 0; a < 16; a++) {
          const ang = (a / 16) * Math.PI * 2;
          const x = Math.round(cx + Math.cos(ang) * r);
          const y = Math.round(cy + Math.sin(ang) * r);
          if (BIOMES[this.tile(x, y).biome].passable && this.tile(x, y).biome !== "river") {
            found = { x, y, name: "Wayfarer's Rest" };
            break outer;
          }
        }
      }
      this.start = found;
    }
    return this.start;
  }

  passable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const s = this.siteAt(x, y);
    if (s) return !s.wall;
    return BIOMES[this.tile(x, y).biome].passable;
  }
}

export function seedFromText(text: string): number {
  return hashString(text.trim().toUpperCase() || "EMBER") >>> 0;
}

export function randomSeedText(): string {
  const a = Math.floor(Math.random() * 90000) + 10000;
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 3; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return `${a}-${s}`;
}

let worldSingleton: World | null = null;

export function getWorld(seed: number): World {
  if (!worldSingleton || worldSingleton.seed !== seed) worldSingleton = new World(seed);
  return worldSingleton;
}

/**
 * A* path over the world grid limited to a search budget. Height-aware: routes
 * climb by slopes only, never step off a ledge, and pay extra for going uphill.
 * Underground (`layer` < 0) the route follows open cave floor.
 */
export function findPath(world: World, sx: number, sy: number, tx: number, ty: number, budget = 6000, layer = SURFACE): [number, number][] | null {
  if (!walkable(world, layer, tx, ty)) return null;
  const key = (x: number, y: number): number => (y - sy + 512) * 1024 + (x - sx + 512);
  const open: { x: number; y: number; g: number; f: number }[] = [{ x: sx, y: sy, g: 0, f: 0 }];
  const came = new Map<number, number>();
  const gScore = new Map<number, number>([[key(sx, sy), 0]]);
  let iter = 0;
  while (open.length && iter < budget) {
    iter++;
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur.x === tx && cur.y === ty) {
      const path: [number, number][] = [];
      let k = key(cur.x, cur.y);
      let cx = cur.x;
      let cy = cur.y;
      while (!(cx === sx && cy === sy)) {
        path.unshift([cx, cy]);
        const p = came.get(k);
        if (p === undefined) break;
        cx = (p % 1024) - 512 + sx;
        cy = Math.floor(p / 1024) - 512 + sy;
        k = p;
      }
      return path;
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (Math.abs(nx - sx) > 500 || Math.abs(ny - sy) > 500) continue;
        if (!walkable(world, layer, nx, ny)) continue;
        if (layer === SURFACE && objectAt(world, nx, ny)) continue;
        const step = stepRule(world, layer, cur.x, cur.y, nx, ny, PLAYER_MOVER);
        if (!step.ok || step.drop > 1) continue;
        const base = tileCost(world, layer, nx, ny);
        const cost = (base + climbCost(PLAYER_MOVER, step.rise)) * (dx && dy ? 1.01 : 1);
        const ng = cur.g + cost;
        const nk = key(nx, ny);
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          came.set(nk, key(cur.x, cur.y));
          const hh = Math.max(Math.abs(tx - nx), Math.abs(ty - ny));
          open.push({ x: nx, y: ny, g: ng, f: ng + hh });
        }
      }
    }
  }
  return null;
}
