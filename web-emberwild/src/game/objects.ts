/**
 * Objects — the physical, standable-world clutter of the surface: trees,
 * boulders, reeds and their kin.
 *
 * Everything here is a pure function of the world seed (like the heightfield
 * and the caves): nothing is persisted, and the same seed regenerates the same
 * forest forever. Every placed object blocks walking, sight and shots; the
 * placement rules keep every reserved space clear — settlements and their
 * grounds, roads and building paths, cave mouths, landmark plateaus, water and
 * icy peaks.
 *
 * Placement is natural, never uniform: a large-scale clustering field decides
 * where each biome's objects thicken into groves and thin into open glades, so
 * forests read as dense, winding cover that frays at the edges, while open
 * country keeps only the occasional lone tree or boulder.
 */
import { TwoGenCache } from "./cache";
import { WORLD_SIZE } from "./data";
import { PIN_CORE, heightOf } from "./height";
import { Perlin, hash2 } from "./rng";
import type { BiomeId } from "./types";
import { roadAt } from "./roads";
import type { World } from "./world";

export type ObjKind =
  | "tree" // broadleaf — forests and lone meadow trees
  | "pine" // conifer — taiga and snow
  | "gloomtree" // pale, dense — the gloomwood
  | "deadtree" // bare branches — tundra, marsh edges and driftwood
  | "shrub" // low bush — steppe, meadow edges and forest floor
  | "boulder" | "rocks" | "reeds" | "cactus";

/** Kinds placed by the generator (the full vocabulary, for checks and rendering). */
export const OBJ_KINDS: readonly ObjKind[] = ["tree", "pine", "gloomtree", "deadtree", "shrub", "boulder", "rocks", "reeds", "cactus"];

/** Human name for the inspect card. */
export const OBJ_NAME: Record<ObjKind, string> = {
  tree: "a broad tree",
  pine: "a needled pine",
  gloomtree: "a pale gloomwood tree",
  deadtree: "a dead tree",
  shrub: "a thick shrub",
  boulder: "a boulder",
  rocks: "a pile of rocks",
  reeds: "tall reeds",
  cactus: "a barrel cactus",
};

/**
 * Base blocking density per biome (a fraction of tiles that MAY hold an object
 * before the clustering field modulates it). Caps keep every biome well under
 * the 8-way percolation limit so wild country stays traversable off-road.
 */
const DENSITY: Partial<Record<BiomeId, number>> = {
  forest: 0.56,
  gloomwood: 0.6,
  taiga: 0.4,
  snow: 0.16,
  marsh: 0.4,
  meadow: 0.07,
  steppe: 0.06,
  hills: 0.18,
  mountain: 0.24,
  desert: 0.14,
  tundra: 0.1,
  beach: 0.03,
};

const NO_OBJECT: ReadonlySet<BiomeId> = new Set<BiomeId>(["deep", "sea", "lake", "river", "peak"]);

interface ObjField {
  cluster: Perlin;
  kind: Perlin;
}

const fields = new WeakMap<World, ObjField>();
/** One cache per world instance — tests and tools interleave several worlds. */
const caches = new WeakMap<World, TwoGenCache<ObjKind | null>>();

function fieldOf(world: World): ObjField {
  let f = fields.get(world);
  if (!f) {
    f = { cluster: new Perlin(world.seed ^ 0x4b57), kind: new Perlin(world.seed ^ 0x4b58) };
    fields.set(world, f);
  }
  return f;
}

/**
 * The physical object standing on this surface tile, or null.
 * Blockers are the same for walking, sight and shots: one answer, one cache.
 */
export function objectAt(world: World, x: number, y: number): ObjKind | null {
  let cache = caches.get(world);
  if (!cache) {
    cache = new TwoGenCache(250000);
    caches.set(world, cache);
  }
  const key = y * WORLD_SIZE + x;
  const c = cache.get(key);
  if (c !== undefined) return c;
  const v = computeObject(world, x, y, key);
  cache.set(key, v);
  return v;
}

function computeObject(world: World, x: number, y: number, key: number): ObjKind | null {
  if (!world.inBounds(x, y)) return null;
  const t = world.tile(x, y);
  const b = t.biome;
  if (NO_OBJECT.has(b) || t.feature || t.river) return null;
  // reserved spaces stay clear: settlements (walls, streets, greens, gateposts),
  // roads and building paths, cave mouths, landmark plateaus
  if (world.siteAt(x, y) || roadAt(world, x, y)) return null;
  const hf = heightOf(world);
  // the mouth itself and the two tiles of open approach before it
  if (hf.isMouth(x, y) || hf.isMouth(x, y - 1) || hf.isMouth(x, y - 2)) return null;
  for (const f of world.featuresNear(x, y, PIN_CORE)) return null;
  const base = DENSITY[b];
  if (!base) return null;
  const fl = fieldOf(world);
  // clustering: groves and glades from a large-scale field, so each biome's
  // cover thickens and thins naturally instead of sprinkling evenly
  const cluster = (fl.cluster.fbm(x / 34, y / 34, 3) + 1) / 2;
  const density = base * (0.35 + 1.05 * cluster);
  if (hash2(world.seed ^ 0xb17, x, y) / 4294967296 >= density) return null;
  // fine-grained clumping at tile scale, leaving gaps between trunks
  const fine = (fl.kind.fbm(x / 7, y / 7, 2) + 1) / 2;
  if (fine < 0.24) return null;
  const h = hash2(world.seed ^ 0xb18, x, y);
  switch (b) {
    case "forest":
      return h % 9 === 0 ? "shrub" : "tree";
    case "gloomwood":
      return h % 11 === 0 ? "deadtree" : "gloomtree";
    case "taiga":
      return h % 13 === 0 ? "shrub" : "pine";
    case "snow":
      return h % 5 === 0 ? "pine" : "rocks";
    case "marsh":
      return h % 4 === 0 ? "deadtree" : "reeds";
    case "meadow":
      return h % 3 === 0 ? "shrub" : "tree";
    case "steppe":
      return h % 3 === 0 ? "shrub" : "rocks";
    case "hills":
      return h % 3 === 0 ? "tree" : h % 2 === 0 ? "boulder" : "rocks";
    case "mountain":
      return h % 4 === 0 ? "boulder" : "rocks";
    case "desert":
      return h % 2 === 0 ? "cactus" : "rocks";
    case "tundra":
      return h % 3 === 0 ? "rocks" : "deadtree";
    case "beach":
      return "deadtree"; // driftwood
    default:
      return null;
  }
}


