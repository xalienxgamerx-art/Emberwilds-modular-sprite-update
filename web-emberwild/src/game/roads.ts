import { WORLD_SIZE } from "./data";
import { hash01 } from "./rng";
import { getSettlementFootprint, isSettlement, settlementId, settlementTier, type SettlementTier } from "./settlement";
import { climbCost, PLAYER_MOVER, stepRule, SURFACE, tileCost, walkable } from "./height";
import { getFactions } from "./factions";
import type { Feature, World } from "./world";

/**
 * Roads — the national road network as a pure function of the seed.
 *
 *   settlements → candidate edges → national trunks (MST) → loops → bridges
 *   → terrain-aware routes (weighted A*) → physical road tiles
 *
 * The logical network (which settlement connects to which, by which class of
 * road) is kept separate from its physical realization (the road tiles on the
 * ground), so future systems can reason about connectivity without re-reading
 * terrain. Nothing is persisted: like every world system, the whole network is
 * a deterministic function of the world seed, rebuilt lazily and cached.
 *
 * Determinism rules the build: settlements are enumerated row-major, every
 * candidate list is sorted with stable tie-breaks, Prim's MST breaks ties by
 * node id, routes are surveyed in (length, id) order, and all chance comes
 * from subsystem hash streams (the `seed ^ 0x90ad` family) — never from a
 * shared random stream whose consumption order could vary.
 */

export type RoadClass = "local" | "regional" | "major";

export const ROAD_CLASS_RANK: Record<RoadClass, number> = { local: 0, regional: 1, major: 2 };

/** One deliberate way into a settlement: a boundary tile facing outward. */
export interface SettlementEntrance {
  id: string;
  x: number;
  y: number;
  /** The settlement this entrance belongs to. */
  settlement: string;
  /** Which way the entrance faces. */
  dir: "n" | "s" | "e" | "w";
}

/** A settlement as the road network sees it: stable identity + connectivity facts. */
export interface RoadSettlement {
  id: string;
  x: number;
  y: number;
  tier: SettlementTier;
  /** Nation id, or "" for settlements of the unclaimed wilds. */
  nation: string;
  /** Footprint half-extent. */
  half: number;
  entrances: SettlementEntrance[];
}

/** How a connection came to be: a hierarchy trunk, a supplementary loop, or a between-components bridge. */
export type RoadKind = "trunk" | "loop" | "bridge";
/** A connection is either a real road on the ground or an honestly recorded failure. */
export type RoadStatus = "built" | "failed";

export interface Road {
  id: string;
  /** Endpoint settlement ids, lexicographically ordered. */
  a: string;
  b: string;
  cls: RoadClass;
  kind: RoadKind;
  crossNational: boolean;
  status: RoadStatus;
  /** Why a planned connection never became a road (failures only). */
  reason?: string;
  /** Ordered tiles from a's entrance to b's entrance (built roads only). */
  route: { x: number; y: number }[] | null;
  entranceA: string | null;
  entranceB: string | null;
  /** Tiles this route reused from roads realized earlier. */
  shared: number;
}

export interface RoadNetwork {
  seed: number;
  settlements: RoadSettlement[];
  byId: Map<string, RoadSettlement>;
  roads: Road[];
  /** Settlements no road could reach (their failed attempts explain why). */
  isolated: string[];
  /** Physical realization: world tile key → the strongest road class over it. */
  tiles: Map<number, RoadClass>;
  /** The road tiles that span open water: wooden bridge spans, one plank lane wide. */
  bridges: Set<number>;
  /** Trodden building paths: every building's door walked to the village green. */
  paths: Set<number>;
  /** Every deliberate entrance tile, indexed for the map and NPC layers. */
  entranceTiles: Set<number>;
  /** False while the survey queue still has routes to pump. */
  finished: boolean;
}

/** Candidate reach per tier pair (Chebyshev, world tiles): the network stays hierarchical, never all-to-all. */
const REACH: Record<string, number> = {
  "city:city": 2400,
  "city:town": 1600,
  "town:town": 1200,
  "town:hamlet": 300,
  "hamlet:hamlet": 110,
};

/** Road class of a tier pair — the classification table of the hierarchy.
 *  Order-independent: the pair is ranked by tier first. */
export function roadClassFor(a: SettlementTier, b: SettlementTier): RoadClass {
  const rank: Record<SettlementTier, number> = { hamlet: 0, town: 1, city: 2 };
  const hi = rank[a] >= rank[b] ? a : b;
  const lo = rank[a] >= rank[b] ? b : a;
  if (hi === "city") return lo === "hamlet" ? "regional" : "major";
  if (hi === "town") return lo === "town" ? "regional" : "local";
  return "local";
}

/** How wide a road is built, in tiles, by class: every road is a real lane
 *  now — a hamlet lane is three carts wide, a highway four. */
export const ROAD_WIDTH: Record<RoadClass, number> = { local: 3, regional: 3, major: 4 };

/** Open water a road cannot widen onto and can only cross on a bridge span. */
const isWaterBiome = (b: string): boolean => b === "river" || b === "lake" || b === "sea" || b === "deep";

const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

const tileKey = (x: number, y: number): number => y * WORLD_SIZE + x;

/* ------------------------------ entrances ---------------------------------- */

const DIR_VEC = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] } as const;
type Dir4 = keyof typeof DIR_VEC;

/** World tiles of an urban settlement's gates (towns and cities gate their ring road). */
function urbanGates(world: World, f: Feature): SettlementEntrance[] {
  const urban = world.settlementLayout(f).urban;
  if (!urban) return [];
  const id = settlementId(f);
  return urban.gates.map((g) => ({
    id: `e:${f.x + g.lx}:${f.y + g.ly}`,
    x: f.x + g.lx,
    y: f.y + g.ly,
    settlement: id,
    dir: g.dir,
  }));
}

/** The village green's radius — the heart of a hamlet (matches the world's plaza). */
const GREEN_R2 = 25;

/**
 * Whether open ground really runs from an entrance candidate to the village
 * green. A tile that only faces a building's back wall admits no one.
 */
function reachesGreen(world: World, f: Feature, sx: number, sy: number): boolean {
  const half = getSettlementFootprint("hamlet").w >> 1;
  const seen = new Set<number>([sy * WORLD_SIZE + sx]);
  const q: [number, number][] = [[sx, sy]];
  while (q.length) {
    const [cx, cy] = q.shift()!;
    const lx = cx - f.x;
    const ly = cy - f.y;
    if (lx * lx + ly * ly <= GREEN_R2) return true;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        const k = ny * WORLD_SIZE + nx;
        if (seen.has(k)) continue;
        if (Math.max(Math.abs(nx - f.x), Math.abs(ny - f.y)) > half) continue;
        const nb = world.tile(nx, ny).biome;
        if (isWaterBiome(nb) || nb === "peak") continue;
        const site = world.baseSiteAt(nx, ny);
        if (site?.wall || site?.door || site?.buildingId) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
  }
  return false;
}

/**
 * A settlement lane: the open-ground path from an entrance to the green at
 * its heart, found by breadth-first search over the settlement's own public
 * ground (4-way, fixed neighbor order, first path wins). Inside a settlement
 * the ground is civil — the lane follows it, wherever a surveyed road would
 * balk at a kerb.
 */
function spurLane(
  world: World,
  n: RoadSettlement,
  en: SettlementEntrance,
  zone: Map<number, string>,
  goal: { x: number; y: number },
): { x: number; y: number }[] | null {
  const start = tileKey(en.x, en.y);
  const goalK = tileKey(goal.x, goal.y);
  const came = new Map<number, number>([[start, start]]);
  const q: [number, number][] = [[en.x, en.y]];
  const NBR: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let goalX = goal.x;
  let goalY = goal.y;
  let found = start === goalK;
  while (q.length && !found) {
    const [cx, cy] = q.shift()!;
    for (const [dx, dy] of NBR) {
      const nx = cx + dx;
      const ny = cy + dy;
      const k = tileKey(nx, ny);
      if (came.has(k)) continue;
      if (Math.max(Math.abs(nx - n.x), Math.abs(ny - n.y)) > n.half) continue;
      const nb = world.tile(nx, ny).biome;
      if (isWaterBiome(nb) || nb === "peak") continue;
      if (!walkable(world, SURFACE, nx, ny, true)) continue;
      const site = world.siteAt(nx, ny);
      if (site?.wall || site?.door || site?.buildingId) continue;
      const owner = zone.get(k);
      if (owner !== undefined && owner !== n.id) continue;
      came.set(k, cy * WORLD_SIZE + cx);
      if (nx === goalX && ny === goalY) {
        found = true;
        break;
      }
      q.push([nx, ny]);
    }
  }
  if (!found) return null;
  const path: { x: number; y: number }[] = [];
  let k = goalK;
  let x = goalX;
  let y = goalY;
  while (!(x === en.x && y === en.y)) {
    path.push({ x, y });
    const p = came.get(k);
    if (p === undefined) return null;
    x = p % WORLD_SIZE;
    y = Math.floor(p / WORLD_SIZE);
    k = p;
  }
  path.push({ x: en.x, y: en.y });
  return path.reverse();
}

/**
 * A hamlet's four deliberate entrances: the mid-edge tiles of its footprint,
 * one per cardinal side, where the ring of buildings leaves a gap to the
 * green. Along each side, the first passable tile outward of the building ring
 * whose open ground actually reaches the green is the entrance; a side wholly
 * walled off simply has none.
 */
function hamletEntrances(world: World, f: Feature): SettlementEntrance[] {
  const half = getSettlementFootprint("hamlet").w >> 1;
  const id = settlementId(f);
  const out: SettlementEntrance[] = [];
  for (const dir of ["n", "s", "e", "w"] as Dir4[]) {
    const [dx, dy] = DIR_VEC[dir];
    for (let off = 0; off <= 4; off++) {
      const candidates = off === 0 ? [0] : [-off, off];
      let placed = false;
      for (const side of candidates) {
        const x = f.x + dx * (half + 1) + (dx ? 0 : side);
        const y = f.y + dy * (half + 1) + (dy ? 0 : side);
        if (!world.passable(x, y)) continue;
        // riverbanks are "passable" fords, but an entrance stands on dry
        // ground: no gate opens onto open water
        if (isWaterBiome(world.tile(x, y).biome)) continue;
        // baseSiteAt: structure only, never gateposts — entrance selection
        // must not depend on which neighbors' posts were computed first
        if (world.baseSiteAt(x, y)?.wall) continue;
        if (!reachesGreen(world, f, x, y)) continue;
        out.push({ id: `e:${x}:${y}`, x, y, settlement: id, dir });
        placed = true;
        break;
      }
      if (placed) break;
    }
  }
  return out;
}

/**
 * The deliberate ways into a settlement: towns and cities gate their ring
 * road, hamlets keep mid-edge gaps in the building ring. The one shared
 * definition — the road network surveys to these, and the site layer derives
 * its gateposts from them.
 */
export function settlementEntrances(world: World, f: Feature): { x: number; y: number; dir: "n" | "s" | "e" | "w" }[] {
  const tier = settlementTier(f);
  if (tier === "town" || tier === "city") return urbanGates(world, f);
  if (tier === "hamlet") return hamletEntrances(world, f);
  return [];
}

/** The entrance of a settlement that faces a target point most directly. */
function facingEntrance(node: RoadSettlement, tx: number, ty: number): SettlementEntrance | null {
  let best: SettlementEntrance | null = null;
  let bestD = Infinity;
  for (const e of node.entrances) {
    const d = (e.x - tx) ** 2 + (e.y - ty) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/* --------------------------------- routing --------------------------------- */

interface HeapNode {
  x: number;
  y: number;
  g: number;
  f: number;
}

/** Binary min-heap over (f, g, y, x) — total, stable, deterministic. */
class RouteHeap {
  private h: HeapNode[] = [];
  private less(a: HeapNode, b: HeapNode): boolean {
    return a.f < b.f || (a.f === b.f && (a.g < b.g || (a.g === b.g && (a.y < b.y || (a.y === b.y && a.x < b.x)))));
  }
  push(n: HeapNode): void {
    this.h.push(n);
    let i = this.h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.h[i], this.h[p])) break;
      [this.h[p], this.h[i]] = [this.h[i], this.h[p]];
      i = p;
    }
  }
  pop(): HeapNode | undefined {
    const top = this.h[0];
    const last = this.h.pop();
    if (this.h.length && last) {
      this.h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.h.length && this.less(this.h[l], this.h[m])) m = l;
        if (r < this.h.length && this.less(this.h[r], this.h[m])) m = r;
        if (m === i) break;
        [this.h[m], this.h[i]] = [this.h[i], this.h[m]];
        i = m;
      }
    }
    return top;
  }
  get size(): number {
    return this.h.length;
  }
}

/**
 * Weighted A* over the surface, tuned for road surveying. Pays terrain and
 * climb costs (the same rules the walker does — `tileCost`, `stepRule`),
 * heavily prefers already-built road (shared segments emerge instead of
 * parallel duplicates), never crosses walls, doors, impassable ground or any
 * tile the `closed` predicate forbids (foreign settlement footprints), and
 * gives up honestly past its expansion budget. Returns the tile sequence from
 * start to goal, both included.
 */
function routeRoad(
  world: World,
  tiles: Map<number, RoadClass>,
  closed: (x: number, y: number) => boolean,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
): { x: number; y: number }[] | null {
  if (closed(sx, sy) || closed(gx, gy)) return null;
  if (sx === gx && sy === gy) return [{ x: sx, y: sy }];
  const key = (x: number, y: number): number => (y - sy + 4096) * 8192 + (x - sx + 4096);
  const heap = new RouteHeap();
  const gScore = new Map<number, number>([[key(sx, sy), 0]]);
  const came = new Map<number, number>();
  const cheb = Math.max(Math.abs(gx - sx), Math.abs(gy - sy));
  // generous: routes that must detour around rivers, peaks and marsh burn
  // many expansions before they find the way around
  const budget = 12000 + cheb * 400;
  heap.push({ x: sx, y: sy, g: 0, f: 0 });
  let iter = 0;
  while (heap.size && iter < budget) {
    iter++;
    const cur = heap.pop()!;
    if (cur.x === gx && cur.y === gy) {
      const path: { x: number; y: number }[] = [];
      let k = key(cur.x, cur.y);
      let x = cur.x;
      let y = cur.y;
      while (!(x === sx && y === sy)) {
        path.push({ x, y });
        const p = came.get(k);
        if (p === undefined) return null;
        x = (p % 8192) - 4096 + sx;
        y = Math.floor(p / 8192) - 4096 + sy;
        k = p;
      }
      path.push({ x: sx, y: sy });
      return path.reverse();
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= WORLD_SIZE || ny >= WORLD_SIZE) continue;
        if (closed(nx, ny)) continue;
        // roads keep to the ground: an icy peak is climbable but no wagon road
        // is cut across one, and no road is laid on open water either —
        // routes go around the high country and the rivers, or fail
        const nb = world.tile(nx, ny).biome;
        if (nb === "peak" || isWaterBiome(nb)) continue;
        if (!walkable(world, SURFACE, nx, ny, true)) continue;
        const step = stepRule(world, SURFACE, cur.x, cur.y, nx, ny, PLAYER_MOVER);
        if (!step.ok || step.drop > 1) continue;
        const site = world.siteAt(nx, ny);
        // no road surveys through any part of a building — wall, door, or
        // interior floor — nor through a gatepost
        if (site?.wall || site?.door || site?.buildingId) continue;
        // and no diagonal step squeezes between two solid tiles: a corner-cut
        // lands the lane inside the block it slipped past
        if (dx && dy) {
          const solid = (ax: number, ay: number): boolean => {
            const s = world.siteAt(ax, ay);
            return !!s && !!(s.wall || s.door || s.buildingId);
          };
          if (solid(cur.x + dx, cur.y) && solid(cur.x, cur.y + dy)) continue;
        }
        const base = tileCost(world, SURFACE, nx, ny);
        const cost = (base + climbCost(PLAYER_MOVER, step.rise)) * (dx && dy ? 1.01 : 1) * (tiles.has(tileKey(nx, ny)) ? 0.35 : 1);
        const ng = cur.g + cost;
        const nk = key(nx, ny);
        if (ng < (gScore.get(nk) ?? Infinity)) {
          gScore.set(nk, ng);
          came.set(nk, key(cur.x, cur.y));
          const adx = Math.abs(gx - nx);
          const ady = Math.abs(gy - ny);
          // octile heuristic — admissible for 8-directional walking
          const h = Math.max(adx, ady) + Math.min(adx, ady) * 0.41;
          heap.push({ x: nx, y: ny, g: ng, f: ng + h });
        }
      }
    }
  }
  return null;
}

/* --------------------------------- paths ----------------------------------- */

/** True when a tile would sit diagonally squeezed between two solid structures — a road lane is never laid there. */
function squeezedBetween(world: World, x: number, y: number): boolean {
  const solid = (ax: number, ay: number): boolean => {
    const s = world.siteAt(ax, ay);
    return !!s && !!(s.wall || s.door || s.buildingId);
  };
  return (
    (solid(x - 1, y) && solid(x, y - 1)) ||
    (solid(x + 1, y) && solid(x, y - 1)) ||
    (solid(x - 1, y) && solid(x, y + 1)) ||
    (solid(x + 1, y) && solid(x, y + 1))
  );
}

/** The walkable tile nearest the green's center, found by a deterministic spiral. */
function openGoalNear(world: World, node: RoadSettlement, cx: number, cy: number): { x: number; y: number } | null {
  for (let r = 0; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring order only
        const x = cx + dx;
        const y = cy + dy;
        if (Math.max(Math.abs(x - node.x), Math.abs(y - node.y)) > node.half) continue;
        if (!walkable(world, SURFACE, x, y, true)) continue;
        const site = world.siteAt(x, y);
        if (site?.wall || site?.door) continue;
        return { x, y };
      }
    }
  }
  return null;
}

/**
 * Carve one settlement's building paths: from just outside every building's
 * external door, a trodden-earth line to the village green. Paths keep to the
 * settlement's own ground, prefer streets and existing roads (they reuse
 * `routeRoad`, which discounts both), and are never carved through walls,
 * doors, water or peaks. A door whose street is blocked simply keeps none.
 */
function carvePaths(b: Builder, i: number): void {
  const node = b.nodes[i];
  const world = b.world;
  const goal = openGoalNear(world, node, node.x, node.y);
  if (!goal) return;
  const closed = (x: number, y: number): boolean => {
    if (Math.max(Math.abs(x - node.x), Math.abs(y - node.y)) > node.half) return true;
    const owner = b.zone.get(tileKey(x, y));
    return owner !== undefined && owner !== node.id;
  };
  const layout = world.settlementLayout(b.features[i]);
  for (const building of layout.buildings) {
    for (const door of building.doors) {
      if (!door.external || !door.dir) continue;
      const [dx, dy] = DIR_VEC[door.dir as Dir4];
      const sx = building.x + door.lx + dx;
      const sy = building.y + door.ly + dy;
      if (closed(sx, sy)) continue;
      if (!walkable(world, SURFACE, sx, sy, true)) continue;
      const site = world.siteAt(sx, sy);
      if (site?.wall || site?.door) continue;
      const route = routeRoad(world, b.net.tiles, closed, sx, sy, goal.x, goal.y);
      if (!route) continue;
      for (const p of route) {
        const k = tileKey(p.x, p.y);
        if (!b.net.tiles.has(k)) b.net.paths.add(k);
      }
    }
  }
}

/* ------------------------------- the network -------------------------------- */

const networks = new WeakMap<World, RoadNetwork>();

/** True while a network is being built — roadAt must not re-enter the builder. */
let building = false;

/**
 * The road network of a world — built lazily and pumped in deterministic
 * slices (see pumpRoads). The graph (settlements, candidates, trunks, loops,
 * bridges) is one fast synchronous pass once the map census is done; the
 * census and the route surveys are the slow parts, and they are what the
 * pump slices. The finished network is identical however the work is split.
 */
export function roadNetworkOf(world: World): RoadNetwork {
  const hit = networks.get(world);
  if (hit) return hit;
  const seed = world.seed;
  const fac = getFactions(seed, world);
  const net: RoadNetwork = {
    seed,
    settlements: [],
    byId: new Map(),
    roads: [],
    isolated: [],
    tiles: new Map(),
    bridges: new Set(),
    paths: new Set(),
    entranceTiles: new Set(),
    finished: false,
  };
  const ncells = Math.ceil(WORLD_SIZE / 24); // FEATURE_CELL — kept numeric to avoid a world import cycle
  const builder: Builder = {
    world,
    net,
    fac,
    phase: "enum",
    cursor: 0,
    ncells,
    byId: net.byId,
    nodes: net.settlements,
    zone: new Map(),
    pending: [],
    realized: new Set(),
    features: [],
    pathCursor: 0,
    spurs: new Set(),
  };
  builders.set(world, builder);
  networks.set(world, net);
  return net;
}

/** Phases of the deterministic build: census → graph → surveys → rescue → paths → done. */
type BuildPhase = "enum" | "graph" | "survey" | "rescue" | "paths" | "done";

/** Survey-build state between pumps. */
interface Builder {
  world: World;
  net: RoadNetwork;
  fac: ReturnType<typeof getFactions>;
  phase: BuildPhase;
  /** Feature-cell census cursor (row-major) during the enum phase. */
  cursor: number;
  ncells: number;
  byId: Map<string, RoadSettlement>;
  nodes: RoadSettlement[];
  zone: Map<number, string>;
  pending: Cand[];
  realized: Set<string>;
  /** The census features, in the order their settlements were recorded. */
  features: Feature[];
  /** Settlement index handled by the paths phase (one per pump slice). */
  pathCursor: number;
  /** Settlements whose entrance-to-green lane is already laid. */
  spurs: Set<string>;
}

interface Cand {
  a: string;
  b: string;
  d: number;
  cls: RoadClass;
  cross: boolean;
  kind: RoadKind;
}

const builders = new WeakMap<World, Builder>();

/* ------------------------------ graph phases -------------------------------- */

/** Phase 2, one fast pass: entrances, candidate pool, layered MSTs, loops, bridges. */
function buildGraph(b: Builder): void {
  const seed = b.world.seed;
  const nodes = b.nodes;
  // entrances: towns and cities gate their ring road; hamlets keep four
  // deliberate mid-edge gaps in the building ring
  for (let i = 0; i < nodes.length; i++) {
    const f = b.features[i];
    nodes[i].entrances = settlementEntrances(b.world, f).map((e) => ({
      id: `e:${e.x}:${e.y}`,
      x: e.x,
      y: e.y,
      settlement: nodes[i].id,
      dir: e.dir,
    }));
    for (const e of nodes[i].entrances) b.net.entranceTiles.add(tileKey(e.x, e.y));
  }

  /* candidate edges: hierarchical reach, nearest-first, capped per node —
   * strictly national. Cross-national roads come from the bridge phase,
   * which links disconnected components by geography, not by decree. */
  const cand = new Map<string, Cand>();
  for (const n of nodes) {
    const kept: Cand[] = [];
    const peers: Cand[] = [];
    for (const m of nodes) {
      if (m.id === n.id) continue;
      const reach = REACH[`${n.tier}:${m.tier}`] ?? REACH[`${m.tier}:${n.tier}`];
      if (!reach) continue;
      const d = Math.hypot(m.x - n.x, m.y - n.y);
      if (d > reach) continue;
      if (n.nation !== m.nation) continue;
      const [a, bb] = pairKey(n.id, m.id);
      const c: Cand = { a, b: bb, d, cls: roadClassFor(n.tier, m.tier), cross: false, kind: "trunk" };
      kept.push(c);
      // a settlement always keeps room for its own kind (and, for a city, its
      // towns): hamlets must not crowd the great roads out of the pool
      if (n.tier === m.tier || (n.tier === "city" && m.tier === "town")) peers.push(c);
    }
    // both endpoints keep their own nearest list; the union of the two caps
    // is the pair pool — no pair vanishes because only one side saw it
    kept.sort((x, y) => x.d - y.d || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
    peers.sort((x, y) => x.d - y.d || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
    for (const c of [...kept.slice(0, 6), ...peers.slice(0, 2)]) cand.set(`${c.a}|${c.b}`, c);
  }
  const candsOf = (id: string): Cand[] => {
    const out: Cand[] = [];
    for (const c of cand.values()) if (c.a === id || c.b === id) out.push(c);
    return out;
  };

  /* national trunks, built in layers (Prim, deterministic, forest on splits) */
  const unions = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (unions.has(r) && unions.get(r) !== r) r = unions.get(r)!;
    return r;
  };
  const join = (a: string, bb: string): void => {
    unions.set(find(a), find(bb));
  };
  const byNation = new Map<string, RoadSettlement[]>();
  for (const n of nodes) {
    const g = byNation.get(n.nation) ?? [];
    g.push(n);
    byNation.set(n.nation, g);
  }
  const chosen: Cand[] = [];
  const mst = (pool: RoadSettlement[], cls: RoadClass): void => {
    const ids = new Set(pool.map((p) => p.id));
    const poolCands = (id: string): Cand[] => candsOf(id).filter((c) => c.cls === cls && ids.has(c.a) && ids.has(c.b));
    for (const nation of [...byNation.keys()].sort()) {
      const group = pool.filter((p) => p.nation === nation);
      if (group.length < 2) continue;
      const inTree = new Set<string>();
      const frontier: Cand[] = [];
      while (inTree.size < group.length) {
        let best: Cand | null = null;
        for (const c of frontier) {
          const inA = inTree.has(c.a);
          const inB = inTree.has(c.b);
          if (inA === inB) continue;
          const keyC = `${c.a}|${c.b}`;
          if (!best || c.d < best.d || (c.d === best.d && keyC < `${best.a}|${best.b}`)) best = c;
        }
        if (best) {
          chosen.push({ ...best, kind: "trunk" });
          join(best.a, best.b);
          inTree.add(inTree.has(best.a) ? best.b : best.a);
          for (const id of [best.a, best.b]) frontier.push(...poolCands(id));
          continue;
        }
        const next = group.find((g) => !inTree.has(g.id));
        if (!next) break;
        inTree.add(next.id);
        frontier.push(...poolCands(next.id));
      }
    }
  };
  // the hierarchy builds in layers: cities anchor the great roads (with their
  // towns), the towns mesh regionally, and hamlets hang local branches off
  // whichever neighbor lies cheapest — town first, then another hamlet
  mst(nodes.filter((n) => n.tier !== "hamlet"), "major");
  mst(nodes.filter((n) => n.tier === "town"), "regional");
  mst(nodes, "local");

  /* supplementary loops: short second chances — alternative routes, slight redundancy */
  {
    const inNet = new Set(chosen.map((e) => `${e.a}|${e.b}`));
    const loopsPerNode = new Map<string, number>();
    const rest = [...cand.values()]
      .filter((c) => !inNet.has(`${c.a}|${c.b}`) && c.d <= 200)
      .sort((x, y) => x.d - y.d || `${x.a}|${x.b}`.localeCompare(`${y.a}|${y.b}`));
    for (const c of rest) {
      if ((loopsPerNode.get(c.a) ?? 0) >= 2 || (loopsPerNode.get(c.b) ?? 0) >= 2) continue;
      const [ax, ay] = c.a.split(":").slice(1).map(Number);
      const [bx, by] = c.b.split(":").slice(1).map(Number);
      if (hash01(seed ^ 0x90ad, ax * 61 + bx, ay * 61 + by) >= 0.3) continue;
      chosen.push({ ...c, kind: "loop" });
      join(c.a, c.b);
      loopsPerNode.set(c.a, (loopsPerNode.get(c.a) ?? 0) + 1);
      loopsPerNode.set(c.b, (loopsPerNode.get(c.b) ?? 0) + 1);
    }
  }

  /* bridges: the closest pair between disconnected components — the only
   * cross-national roads, emerging from geography rather than decrees */
  {
    let bridges = 0;
    while (bridges < 40) {
      const comps = new Map<string, RoadSettlement[]>();
      for (const n of nodes) {
        const r = find(n.id);
        const g = comps.get(r) ?? [];
        g.push(n);
        comps.set(r, g);
      }
      if (comps.size <= 1) break;
      const roots = [...comps.keys()].sort();
      let best: Cand | null = null;
      for (let i = 0; i < roots.length; i++) {
        for (let j = i + 1; j < roots.length; j++) {
          for (const p of comps.get(roots[i])!) {
            for (const q of comps.get(roots[j])!) {
              const d = Math.hypot(p.x - q.x, p.y - q.y);
              const [a, bb] = pairKey(p.id, q.id);
              const keyB = `${a}|${bb}`;
              if (!best || d < best.d || (d === best.d && keyB < `${best.a}|${best.b}`)) {
                best = { a, b: bb, d, cls: roadClassFor(p.tier, q.tier), cross: p.nation !== q.nation, kind: "bridge" };
              }
            }
          }
        }
      }
      if (!best) break;
      chosen.push(best);
      join(best.a, best.b);
      bridges++;
    }
  }

  /* the survey queue: routes are surveyed shortest first — short roads exist
   * before long ones, so long routes reuse them (0.35 cost) */
  b.pending = chosen
    .map((e) => ({ e, d: e.d }))
    .sort((x, y) => x.d - y.d || `${x.e.a}|${x.e.b}`.localeCompare(`${y.e.a}|${y.e.b}`))
    .map(({ e }) => e);
  // closed country: every tile of every footprint, precomputed once
  for (const n of nodes) {
    for (let dy = -n.half; dy <= n.half; dy++) {
      for (let dx = -n.half; dx <= n.half; dx++) {
        const k = tileKey(n.x + dx, n.y + dy);
        if (!b.zone.has(k)) b.zone.set(k, n.id);
      }
    }
  }
  b.phase = "survey";
}

/** Survey one planned connection and, if the terrain allows it, realize its road. */
function realize(b: Builder, e: Cand): void {
  const { net, byId, zone } = b;
  const na = byId.get(e.a)!;
  const nb = byId.get(e.b)!;
  const ea = facingEntrance(na, nb.x, nb.y);
  const eb = facingEntrance(nb, na.x, na.y);
  const road: Road = {
    id: `r:${e.a}:${e.b}`,
    a: e.a,
    b: e.b,
    cls: e.cls,
    kind: e.kind,
    crossNational: e.cross,
    status: "failed",
    route: null,
    entranceA: ea?.id ?? null,
    entranceB: eb?.id ?? null,
    shared: 0,
  };
  if (!ea || !eb) {
    road.reason = "no entrance could face the far settlement";
    net.roads.push(road);
    return;
  }
  const allowed = new Set([e.a, e.b]);
  // closed country is every foreign footprint — and, inside either endpoint's
  // own footprint, everything past a small apron around its entrance. Roads
  // meet the town at its gate; they do not cut across it. The interior is
  // served by the spur to the green and by the settlement's own streets.
  const apron = (x: number, y: number): boolean => {
    for (const en of [ea, eb]) {
      const n = byId.get(en.settlement)!;
      if (Math.max(Math.abs(x - n.x), Math.abs(y - n.y)) > n.half) continue;
      return Math.max(Math.abs(x - en.x), Math.abs(y - en.y)) <= 3;
    }
    return false;
  };
  const closed = (x: number, y: number): boolean => {
    const owner = zone.get(tileKey(x, y));
    if (owner === undefined) return false;
    if (!allowed.has(owner)) return true;
    return !apron(x, y);
  };
  const route = routeRoad(b.world, net.tiles, closed, ea.x, ea.y, eb.x, eb.y);
  if (!route) {
    road.reason = "no traversable route within the survey budget";
    net.roads.push(road);
    return;
  }
  for (const p of route) {
    const k = tileKey(p.x, p.y);
    const cur = net.tiles.get(k);
    if (cur !== undefined) {
      road.shared++;
      if (ROAD_CLASS_RANK[e.cls] > ROAD_CLASS_RANK[cur]) net.tiles.set(k, e.cls);
    } else net.tiles.set(k, e.cls);
  }
  // the swath: a road is wider than the survey line. Each class stamps a
  // solid band — a square brush around every centerline tile, plus one
  // leaning lane for even widths — so diagonal roads are ribbons, not
  // corner-dashed checkers. The lean lane is stamped with the neighbour
  // chords too, so curves keep no pinholes at direction changes. Nothing
  // spills onto walls, water, peaks or foreign ground.
  const world2 = b.world;
  const width = ROAD_WIDTH[e.cls];
  const r = (width - 1) >> 1;
  const lean = width % 2 === 0 ? width / 2 : 0;
  const stamp = (wx: number, wy: number): void => {
    const k = tileKey(wx, wy);
    const nb = world2.tile(wx, wy).biome;
    if (isWaterBiome(nb) || nb === "peak") return;
    if (closed(wx, wy)) return;
    if (!walkable(world2, SURFACE, wx, wy, true)) return;
    const site = world2.siteAt(wx, wy);
    // the swath never covers any part of a building, nor a tile squeezed
    // diagonally between two structures — no road bleeds through a wall corner
    if (site?.wall || site?.door || site?.buildingId) return;
    if (squeezedBetween(world2, wx, wy)) return;
    const cur = net.tiles.get(k);
    if (cur === undefined || ROAD_CLASS_RANK[e.cls] > ROAD_CLASS_RANK[cur]) net.tiles.set(k, e.cls);
  };
  for (let i = 0; i < route.length; i++) {
    const p = route[i];
    const prev = route[Math.max(0, i - 2)];
    const next = route[Math.min(route.length - 1, i + 2)];
    const dirx = Math.sign(next.x - prev.x);
    const diry = Math.sign(next.y - prev.y);
    // a diagonal lane line is corner-connected only — its two cardinal
    // neighbours make it solid (they coincide with existing tiles on
    // straight routes)
    const leanStamp = (lx: number, ly: number, sx: number, sy: number): void => {
      stamp(lx, ly);
      if (sx !== 0) stamp(lx + sx, ly);
      if (sy !== 0) stamp(lx, ly + sy);
    };
    if (lean) {
      for (const j of [Math.max(0, i - 1), i, Math.min(route.length - 1, i + 1)]) {
        const qprev = route[Math.max(0, j - 2)];
        const qnext = route[Math.min(route.length - 1, j + 2)];
        leanStamp(p.x - Math.sign(qnext.y - qprev.y) * lean, p.y + Math.sign(qnext.x - qprev.x) * lean, Math.sign(qnext.x - qprev.x), Math.sign(qnext.y - qprev.y));
      }
    }
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) stamp(p.x + dx, p.y + dy);
    }
  }
  road.status = "built";
  road.route = route;
  net.roads.push(road);
  b.realized.add(e.a);
  b.realized.add(e.b);

  // the road walks in: from each endpoint's entrance, a lane follows the
  // settlement's own public ground down to the green at its heart — the
  // national road ends at the gate, but it connects to the town center. One
  // lane per gate: the first road through it lays the lane, and later roads
  // reuse it (routeRoad prefers built road). Lanes converge on the green.
  for (const en of [ea, eb]) {
    const spurKey = `${en.settlement}:${en.id}`;
    if (b.spurs.has(spurKey)) continue;
    b.spurs.add(spurKey);
    const n = byId.get(en.settlement)!;
    const goal = openGoalNear(b.world, n, n.x, n.y);
    if (!goal) continue;
    const lane = spurLane(b.world, n, en, zone, goal);
    if (!lane) continue;
    for (const p of lane) {
      const k = tileKey(p.x, p.y);
      const nb2 = b.world.tile(p.x, p.y).biome;
      if (isWaterBiome(nb2) || nb2 === "peak") continue;
      if (!walkable(b.world, SURFACE, p.x, p.y, true)) continue;
      const site = b.world.siteAt(p.x, p.y);
      if (site?.wall || site?.door || site?.buildingId) continue;
      const cur = net.tiles.get(k);
      if (cur === undefined || ROAD_CLASS_RANK[e.cls] > ROAD_CLASS_RANK[cur]) net.tiles.set(k, e.cls);
    }
  }
}

/**
 * Advance the build for at most `msBudget` milliseconds. Roads appear on the
 * ground in the same deterministic order whether pumped in slices or drained
 * at once. Returns true when nothing remains to build.
 */
export function pumpRoads(world: World, msBudget = 40): boolean {
  const b = builders.get(world);
  if (!b || b.net.finished) return true;
  building = true;
  try {
    const deadline = Date.now() + msBudget;
    while (Date.now() < deadline) {
      switch (b.phase) {
        case "enum": {
          // the census: ~1500 feature cells per slice keeps each pump short
          const end = Math.min(b.ncells * b.ncells, b.cursor + 1500);
          for (; b.cursor < end; b.cursor++) {
            const cx = b.cursor % b.ncells;
            const cy = Math.floor(b.cursor / b.ncells);
            const f = b.world.featureCell(cx, cy);
            if (!f || !isSettlement(f)) continue;
            const tier = settlementTier(f) ?? "hamlet";
            const half = getSettlementFootprint(tier).w >> 1;
            b.features.push(f);
            const node: RoadSettlement = {
              id: settlementId(f),
              x: f.x,
              y: f.y,
              tier,
              nation: b.fac.nationAt(f.x, f.y)?.id ?? "",
              half,
              entrances: [],
            };
            b.nodes.push(node);
            b.byId.set(node.id, node);
          }
          if (b.cursor >= b.ncells * b.ncells) b.phase = "graph";
          return false; // re-check the clock after each slice
        }
        case "graph":
          buildGraph(b);
          return false;
        case "survey": {
          const e = b.pending.shift();
          if (e) {
            realize(b, e);
            return false;
          }
          // planned queue drained: the rescue pass — a settlement nothing
          // reached gets one last, honest chance, the nearest three settled
          // places that do have a road, no tier preference
          b.phase = "rescue";
          const stranded = b.nodes.filter((n) => !b.realized.has(n.id)).map((n) => n.id);
          for (const id of stranded) {
            const n = b.byId.get(id)!;
            const pool = b.nodes
              .filter((m) => m.id !== id && b.realized.has(m.id))
              .map((m) => ({ m, d: Math.hypot(m.x - n.x, m.y - n.y) }))
              .sort((x, y) => x.d - y.d || x.m.id.localeCompare(y.m.id))
              .slice(0, 6);
            for (const { m } of pool) {
              if (b.realized.has(id)) break;
              const [a, bb] = pairKey(id, m.id);
              b.pending.push({ a, b: bb, d: Math.hypot(m.x - n.x, m.y - n.y), cls: roadClassFor(n.tier, m.tier), cross: n.nation !== m.nation, kind: "bridge" });
            }
          }
          b.pending.sort((x, y) => x.d - y.d || `${x.a}|${x.b}`.localeCompare(`${y.a}|${y.b}`));
          return false;
        }
        case "rescue": {
          const e = b.pending.shift();
          if (e) {
            realize(b, e);
            return false;
          }
          // the honest ledger: settlements nothing reached
          b.net.isolated = b.nodes.filter((n) => !b.realized.has(n.id)).map((n) => n.id);
          b.phase = "paths";
          return false;
        }
        case "paths": {
          // one settlement per slice: its layout may need generating, and the
          // pump keeps every slice short
          if (b.pathCursor >= b.nodes.length) {
            b.net.finished = true;
            b.phase = "done";
            builders.delete(b.world);
            return true;
          }
          carvePaths(b, b.pathCursor++);
          return false;
        }
        default:
          return true;
      }
    }
    return false;
  } finally {
    building = false;
  }
}

/** Drain the whole build synchronously (tests, diagnostics, determinism checks). */
export function finishRoads(world: World): RoadNetwork {
  const net = roadNetworkOf(world);
  while (!pumpRoads(world, 2000)) {
    // drain
  }
  return net;
}

/**
 * Warm the road network in the background, one time slice per interval, like
 * warmOverviewAsync. Roads appear on the map as they are surveyed; the final
 * network is identical to a synchronous build.
 */
export function warmRoadsAsync(world: World, msPerChunk = 40): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  const begin = setTimeout(() => {
    id = setInterval(() => {
      if (pumpRoads(world, msPerChunk)) stop();
    }, 30);
  }, 250);
  const stop = (): void => {
    clearTimeout(begin);
    if (id) clearInterval(id);
  };
  return stop;
}

/** The strongest road class covering this world tile, or null for bare country. */
export function roadAt(world: World, x: number, y: number): RoadClass | null {
  if (building || !world.inBounds(x, y)) return null;
  return roadNetworkOf(world).tiles.get(tileKey(x, y)) ?? null;
}

/** True when the road tile here is a bridge span over open water. */
export function bridgeAt(world: World, x: number, y: number): boolean {
  if (building || !world.inBounds(x, y)) return false;
  return roadNetworkOf(world).bridges.has(tileKey(x, y));
}

/** True when a trodden building path crosses this tile. */
export function pathAt(world: World, x: number, y: number): boolean {
  if (building || !world.inBounds(x, y)) return false;
  return roadNetworkOf(world).paths.has(tileKey(x, y));
}

/** Every built road at a settlement — the interface later phases (caravans, patrols) query. */
export function settlementRoads(net: RoadNetwork, id: string): Road[] {
  return net.roads.filter((r) => r.status === "built" && (r.a === id || r.b === id));
}

/** The deliberate entrance standing on this world tile, if any. */
export function settlementEntranceAt(net: RoadNetwork, x: number, y: number): SettlementEntrance | null {
  if (!net.entranceTiles.has(tileKey(x, y))) return null;
  for (const n of net.settlements) {
    for (const e of n.entrances) if (e.x === x && e.y === y) return e;
  }
  return null;
}

/** A downsampled route polyline for the small-scale maps. */
export interface MapRoadLine {
  road: Road;
  /** Every `stride`-th route tile, endpoints included. */
  pts: { x: number; y: number }[];
}

const lineCache = new WeakMap<RoadNetwork, Map<number, MapRoadLine[]>>();

/**
 * Road polylines for the region/world maps: built roads only, downsampled by
 * `stride` world tiles, cached per network so a map render never re-walks the
 * route arrays. Consumers gate what is shown (discovery rules) — this is the
 * geometry, not the permission.
 */
export function mapRoadLines(net: RoadNetwork, stride: number): MapRoadLine[] {
  // mid-build the network still grows: no caching until it is finished
  if (!net.finished) {
    const live = buildLines(net, stride);
    return live;
  }
  let byStride = lineCache.get(net);
  if (!byStride) {
    byStride = new Map();
    lineCache.set(net, byStride);
  }
  const hit = byStride.get(stride);
  if (hit) return hit;
  const out = buildLines(net, stride);
  byStride.set(stride, out);
  return out;
}

function buildLines(net: RoadNetwork, stride: number): MapRoadLine[] {
  const out: MapRoadLine[] = [];
  for (const r of net.roads) {
    if (r.status !== "built" || !r.route) continue;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < r.route.length; i += stride) pts.push(r.route[i]);
    const last = r.route[r.route.length - 1];
    const end = pts[pts.length - 1];
    if (!end || end.x !== last.x || end.y !== last.y) pts.push(last);
    out.push({ road: r, pts });
  }
  return out;
}
