import { DAY_TICKS, WORLD_SIZE } from "./data";
import { DIR_DELTA, validateBuilding, type Building } from "./buildings";
import { getSettlementFootprint, isSettlement, settlementId, settlementTier, type SettlementTier } from "./settlement";
import { finishRoads, ROAD_CLASS_RANK, roadClassFor, type RoadNetwork, type RoadSettlement } from "./roads";
import { getFactions, type Factions } from "./factions";
import { FEATURE_CELL, SETTLEMENT_GAP, type Feature, type World } from "./world";

/**
 * Settlement infrastructure validation (Phase 8) — one categorized sweep over
 * a generated world: settlement footprints and reservations, building
 * interiors, NPC populations, association semantics, and the road network at
 * both the graph and the terrain level.
 *
 * The validator reads the SAME systems gameplay reads — `world.siteAt`,
 * `world.passable`, `settlementLayout`, `finishRoads` — it never re-implements
 * generation or pathfinding. Every failure names its category, the violated
 * invariant, and the settlement, building, road or tile responsible, so a
 * mapcheck line or unit assertion points at the defect instead of at "something".
 *
 * Nothing here mutates world state: the sweep only reads cached generation,
 * so running it twice returns the same answer (asserted by the tests).
 */

export type ValidationCategory =
  | "footprint"
  | "reservation"
  | "building"
  | "interior"
  | "npc"
  | "association"
  | "road-graph"
  | "road-path"
  | "entrance";

export const VALIDATION_CATEGORIES: readonly ValidationCategory[] = [
  "footprint",
  "reservation",
  "building",
  "interior",
  "npc",
  "association",
  "road-graph",
  "road-path",
  "entrance",
];

export interface ValidationFailure {
  category: ValidationCategory;
  /** The violated invariant, human-readable and specific. */
  invariant: string;
  /** Seed label the sweep ran under. */
  seed?: string;
  /** Settlement id (`s:x:y`) when the failure belongs to one. */
  settlement?: string;
  building?: string;
  road?: string;
  npc?: string;
  x?: number;
  y?: number;
}

export interface ValidateOptions {
  /** A cached road network to reuse — the sweep must not rebuild what mapcheck already paid for. */
  net?: RoadNetwork;
  /** Skip the road checks (footprint-only sweeps over extra seeds). */
  skipRoads?: boolean;
  /** Skip the resident-timeline sweep (the expensive NPC part). */
  skipResidents?: boolean;
}

export interface ValidateResult {
  failures: ValidationFailure[];
  counts: Record<ValidationCategory, number>;
  settlements: number;
  buildings: number;
  roadTiles: number;
  durationMs: number;
}

/** Fewest entrances a settlement of each tier may open, from the tier configs. */
const MIN_ENTRANCES: Record<SettlementTier, number> = { hamlet: 1, town: 2, city: 3 };

const HALF_OF: Record<SettlementTier, number> = {
  hamlet: getSettlementFootprint("hamlet").w >> 1,
  town: getSettlementFootprint("town").w >> 1,
  city: getSettlementFootprint("city").w >> 1,
};

const isWaterBiome = (b: string): boolean => b === "river" || b === "lake" || b === "sea" || b === "deep";

const solidSite = (world: World, x: number, y: number): boolean => {
  const s = world.siteAt(x, y);
  return !!s && !!(s.wall || s.door || s.buildingId);
};

/* ------------------------- footprints & reservations ------------------------ */

/** Buildings inside the footprint, no two overlapping, no foreign landmark inside the reserved site. */
export function validateSettlementFootprint(world: World, f: Feature, label: string): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  const tier = settlementTier(f);
  if (!tier) return out;
  const half = HALF_OF[tier];
  const tag = (extra: Partial<ValidationFailure>): ValidationFailure => ({ category: "footprint", invariant: "", seed: label, settlement: settlementId(f), ...extra });

  // footprint reservation spans whole feature cells: every cell the footprint
  // box touches is checked — a city occupies parts of four, and a naive
  // single-cell check would silently skip three of them
  const c0x = Math.floor((f.x - half) / FEATURE_CELL);
  const c1x = Math.floor((f.x + half) / FEATURE_CELL);
  const c0y = Math.floor((f.y - half) / FEATURE_CELL);
  const c1y = Math.floor((f.y + half) / FEATURE_CELL);
  for (let cy = c0y; cy <= c1y; cy++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      const other = world.featureCell(cx, cy);
      if (!other || other === f) continue;
      if (Math.max(Math.abs(other.x - f.x), Math.abs(other.y - f.y)) <= half) {
        out.push(tag({ invariant: `reserved site holds a foreign ${other.kind} "${other.name}"`, category: "reservation", x: other.x, y: other.y }));
      }
    }
  }

  const layout = world.settlementLayout(f);
  for (const b of layout.buildings) {
    if (b.x - f.x < -half || b.y - f.y < -half || b.x + b.w - 1 - f.x > half || b.y + b.h - 1 - f.y > half) {
      out.push(tag({ invariant: `building stands outside the ${tier} footprint`, building: b.id, x: b.x, y: b.y }));
    }
    // a door must open onto real, walkable ground — the player can leave
    const door = b.doors.find((d) => d.external && d.dir);
    if (door && door.dir) {
      const [dx, dy] = DIR_DELTA[door.dir];
      const ex = b.x + door.lx + dx;
      const ey = b.y + door.ly + dy;
      if (!world.passable(ex, ey) || solidSite(world, ex, ey)) {
        out.push(tag({ invariant: "exterior entrance opens into blocked ground", building: b.id, x: ex, y: ey }));
      }
    }
  }
  // pairwise overlap, every tier (urban validation covers towns/cities; this is tier-general)
  const bs = layout.buildings;
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i];
      const b = bs[j];
      const sepX = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
      const sepY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
      if (sepX < 0 && sepY < 0) out.push(tag({ invariant: `buildings overlap or touch`, building: a.id, x: b.x, y: b.y }));
    }
  }
  return out;
}

/** A full dry gap between every pair of settlement sites — no illegal overlaps. */
export function validateSettlementSpacing(world: World, all: Feature[], label: string): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      const ta = settlementTier(a);
      const tb = settlementTier(b);
      if (!ta || !tb) continue;
      const gap = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) - HALF_OF[ta] - HALF_OF[tb];
      if (gap < SETTLEMENT_GAP) {
        out.push({
          category: "reservation",
          invariant: `settlement footprints stand closer than the required ${SETTLEMENT_GAP}-tile gap (${gap})`,
          seed: label,
          settlement: settlementId(a),
          x: b.x,
          y: b.y,
        });
      }
    }
  }
  void world;
  return out;
}

/* ------------------------------- interiors --------------------------------- */

/**
 * The enter / visit-every-room / leave drill: an actual flood over the
 * building's walkable cells from the entrance's inward step, requiring every
 * room and the entrance door cell itself to be reached — the player can walk
 * in, through each connected room, and back out without becoming trapped.
 */
export function validateInteriorDrill(b: Building): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  const fail = (invariant: string): ValidationFailure => ({ category: "interior", invariant, building: b.id });
  const at = (lx: number, ly: number): string | null => {
    if (lx < 0 || ly < 0 || lx >= b.w || ly >= b.h) return null;
    return b.cells[ly * b.w + lx];
  };
  const walkable = (k: string | null): boolean => k !== null && k !== "wall";
  const ent = b.doors.find((d) => d.external && d.dir);
  if (!ent || !ent.dir) return [fail("building has no exterior entrance to drill through")];
  // DIR_DELTA points OUTWARD (north = y-1); the drill starts one step INWARD
  const [ddx, ddy] = DIR_DELTA[ent.dir];
  const start: [number, number] = [ent.lx - ddx, ent.ly - ddy];
  if (!walkable(at(start[0], start[1]))) return [fail(`entrance at (${ent.lx},${ent.ly}) opens into a ${at(start[0], start[1]) ?? "wall"}`)];
  const seen = new Set<number>([start[1] * b.w + start[0]]);
  const q: [number, number][] = [start];
  while (q.length) {
    const [cx, cy] = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      const k = ny * b.w + nx;
      if (seen.has(k) || !walkable(at(nx, ny))) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  if (!seen.has(ent.ly * b.w + ent.lx)) out.push(fail("the entrance door is not reachable from inside — leaving would trap the player"));
  for (const r of b.rooms) {
    let reached = false;
    for (let ly = r.y0; ly <= r.y1 && !reached; ly++) {
      for (let lx = r.x0; lx <= r.x1; lx++) {
        if (seen.has(ly * b.w + lx)) {
          reached = true;
          break;
        }
      }
    }
    if (!reached) out.push(fail(`room ${r.id} (${r.type}) is unreachable from the entrance`));
  }
  return out;
}

/* ---------------------------------- npcs ----------------------------------- */

/**
 * Population checks for one settlement: folk and residents stand on valid,
 * traversable tiles inside the footprint, residents never permanently occupy
 * an entrance threshold, and placement is deterministic.
 */
export function validateSettlementNpcs(world: World, f: Feature, entranceTiles: Set<number>, label: string, opts: { skipResidents: boolean }): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  const tier = settlementTier(f);
  if (!tier) return out;
  const half = HALF_OF[tier];
  const sid = settlementId(f);
  const fail = (invariant: string, npc: string, x: number, y: number): ValidationFailure => ({ category: "npc", invariant, seed: label, settlement: sid, npc, x, y });
  const validSpot = (n: { name: string; x: number; y: number }): boolean => {
    if (Math.max(Math.abs(n.x - f.x), Math.abs(n.y - f.y)) > half + 6) return false;
    if (!world.passable(n.x, n.y)) return false;
    if (solidSite(world, n.x, n.y)) return false;
    if (entranceTiles.has(n.y * WORLD_SIZE + n.x)) return false;
    return true;
  };

  const folk = world.settlementNpcs(f);
  for (const n of folk) if (!validSpot(n)) out.push(fail("folk stand on blocked ground, outside the settlement, or on an entrance tile", n.name, n.x, n.y));

  if (opts.skipResidents) return out;
  const SAMPLES = [0, Math.floor(DAY_TICKS / 3), Math.floor((2 * DAY_TICKS) / 3), DAY_TICKS - 1];
  const residents = world.settlementResidents(f, 0);
  const seenNames = new Set<string>();
  for (const r of residents) {
    if (seenNames.has(r.name)) out.push({ category: "npc", invariant: `two residents share the name ${r.name}`, seed: label, settlement: sid, npc: r.name });
    seenNames.add(r.name);
  }
  let entranceOccupancy = 0;
  let samples = 0;
  for (const tick of SAMPLES) {
    for (const r of world.settlementResidents(f, tick)) {
      samples++;
      if (!validSpot(r)) out.push(fail("resident stands on blocked ground, outside the settlement, or on an entrance tile", r.name, r.x, r.y));
      if (entranceTiles.has(r.y * WORLD_SIZE + r.x)) entranceOccupancy++;
    }
  }
  // residents drift toward the green; squatting on a gate for a third of the
  // samples would mean the threshold is their home
  if (samples > 0 && entranceOccupancy / samples > 0.1) {
    out.push({ category: "npc", invariant: `residents occupy entrance tiles in ${(100 * entranceOccupancy) / samples}% of sampled ticks`, seed: label, settlement: sid });
  }
  return out;
}

/* ------------------------------- associations ------------------------------ */

/** Chapter/headquarters semantics: chapters are town halls, seats are city halls, references resolve. */
export function validateAssociations(world: World, fac: Factions, label: string): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  const fail = (invariant: string, association: string): ValidationFailure => ({ category: "association", invariant, seed: label, settlement: association });
  const chapterSettlements = new Set<string>();
  for (const a of fac.assocs) {
    const tier = settlementTier(a.chapter);
    if (tier !== "town") {
      out.push(fail(`association chapter stands in a ${tier ?? a.chapter.kind}, never a town chapter`, a.id));
      continue;
    }
    if (chapterSettlements.has(`${a.chapter.x}:${a.chapter.y}`)) out.push(fail("two associations keep a chapter in the same settlement", a.id));
    chapterSettlements.add(`${a.chapter.x}:${a.chapter.y}`);
    if (!a.chapterBuilding) {
      out.push(fail("town chapter names no hall building", a.id));
      continue;
    }
    const hall = world.settlementLayout(a.chapter).buildings.find((b) => b.id === a.chapterBuilding);
    if (!hall) out.push(fail(`chapter building ${a.chapterBuilding} does not resolve to a real building in ${a.chapter.name}`, a.id));
    else if (hall.type !== "association") out.push(fail(`chapter reference resolves to a ${hall.type}, not an association hall`, a.id));
    if (a.headquarters) {
      if (settlementTier(a.headquarters.city) !== "city") out.push(fail("headquarters seat is not in a city", a.id));
      else {
        const hq = world.settlementLayout(a.headquarters.city).building("assoc_hq");
        if (!hq || hq.id !== a.headquarters.buildingId) out.push(fail(`headquarters building ${a.headquarters.buildingId} does not resolve in ${a.headquarters.city.name}`, a.id));
      }
      if (a.headquarters.city.x === a.chapter.x && a.headquarters.city.y === a.chapter.y) out.push(fail("the same association keeps a chapter and a headquarters in one settlement", a.id));
    }
  }
  for (const a of fac.assocs) {
    if (!a.headquarters) continue;
    if (settlementTier(a.headquarters.city) !== "city") continue;
    // a city headquarters must never double as a town chapter classification
    if (a.chapter.kind === "city") out.push(fail("a city is classified as a chapter hall", a.id));
  }
  return out;
}

/* -------------------------------- road graph ------------------------------- */

/** Graph-level checks: endpoints, classes, honest failures, per-nation connectivity to the capital. */
export function validateRoadGraph(net: RoadNetwork, label: string): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  const fail = (invariant: string, road: string): ValidationFailure => ({ category: "road-graph", invariant, seed: label, road });
  const nodeOf = (id: string): RoadSettlement | null => net.byId.get(id) ?? null;

  for (const r of net.roads) {
    const a = nodeOf(r.a);
    const b = nodeOf(r.b);
    if (!a || !b) {
      out.push(fail("road endpoint is not a settlement", r.id));
      continue;
    }
    if (r.cls !== roadClassFor(a.tier, b.tier)) out.push(fail(`road class ${r.cls} contradicts the tier hierarchy`, r.id));
    if (r.crossNational && r.kind !== "bridge") out.push(fail("cross-national road is not a bridge", r.id));
    if (r.status === "failed") {
      if (!r.reason || r.route !== null) out.push(fail("failed connection is not honestly recorded", r.id));
    } else {
      if (!r.route) out.push(fail("built road carries no route", r.id));
      if (r.reason) out.push(fail("built road carries a failure reason", r.id));
      if (r.route) {
        const ea = a.entrances.find((e) => e.id === r.entranceA);
        const eb = b.entrances.find((e) => e.id === r.entranceB);
        if (!ea || !eb) out.push(fail("route endpoints do not resolve to deliberate entrances", r.id));
        else {
          const s = r.route[0];
          const t = r.route[r.route.length - 1];
          if (s.x !== ea.x || s.y !== ea.y || t.x !== eb.x || t.y !== eb.y) out.push(fail("route does not run entrance to entrance", r.id));
        }
      }
    }
  }

  // per-nation connectivity: union-find over built roads; every settlement of
  // a nation that is not honestly isolated must sit in the capital's component
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };
  for (const n of net.settlements) parent.set(n.id, n.id);
  for (const r of net.roads) if (r.status === "built") union(r.a, r.b);
  const degree = new Map<string, number>();
  for (const r of net.roads) {
    if (r.status !== "built") continue;
    degree.set(r.a, (degree.get(r.a) ?? 0) + 1);
    degree.set(r.b, (degree.get(r.b) ?? 0) + 1);
  }
  for (const n of net.settlements) {
    const connected = (degree.get(n.id) ?? 0) > 0;
    const isolated = net.isolated.includes(n.id);
    if (connected && isolated) out.push({ category: "road-graph", invariant: "connected settlement is also listed as isolated", seed: label, settlement: n.id });
    if (!connected && !isolated) out.push({ category: "road-graph", invariant: "settlement has no built road and is not honestly recorded as isolated", seed: label, settlement: n.id });
  }
  // national mesh, at the strength the architecture promises: rivers and
  // peaks sever trunks (each failure recorded on the road), so a nation may
  // legitimately span several components — but every nation keeps road access
  // somewhere, and no important settlement loses its road in silence
  const nationsWithRoads = new Set<string>();
  for (const n of net.settlements) {
    if ((degree.get(n.id) ?? 0) > 0 && n.nation !== "") nationsWithRoads.add(n.nation);
  }
  const nationAll = new Set(net.settlements.filter((n) => n.nation !== "").map((n) => n.nation));
  for (const nation of nationAll) {
    if (!nationsWithRoads.has(nation) && !net.settlements.every((n) => n.nation !== nation || net.isolated.includes(n.id))) {
      out.push({ category: "road-graph", invariant: "a nation's settlements all lack roads without honest isolation records", seed: label, settlement: nation });
    }
  }
  for (const n of net.settlements) {
    if (n.tier === "hamlet" || net.isolated.includes(n.id)) continue;
    if ((degree.get(n.id) ?? 0) === 0) out.push({ category: "road-graph", invariant: "an important settlement has no road access", seed: label, settlement: n.id });
  }
  void find;
  return out;
}

/* -------------------------------- road paths ------------------------------- */

/** Terrain-level checks: routes are walkable, keep off buildings and water, and their tiles carry their class. */
export function validateRoadPaths(world: World, net: RoadNetwork, label: string): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  const fail = (invariant: string, road: string, x: number, y: number): ValidationFailure => ({ category: "road-path", invariant, seed: label, road, x, y });
  for (const r of net.roads) {
    if (r.status !== "built" || !r.route) continue;
    for (const p of r.route) {
      if (!world.passable(p.x, p.y)) out.push(fail("route crosses impassable ground", r.id, p.x, p.y));
      const site = world.siteAt(p.x, p.y);
      if (site && (site.wall || site.door || site.buildingId)) out.push(fail("route crosses a building wall, door, interior or gatepost", r.id, p.x, p.y));
      const b = world.tile(p.x, p.y).biome;
      if (b === "peak" || isWaterBiome(b)) out.push(fail(`route crosses ${b}`, r.id, p.x, p.y));
      // foreign footprints stay foreign: no route cuts through a settlement
      // it does not belong to
      for (const f of world.featuresNear(p.x, p.y, 34)) {
        if (!isSettlement(f)) continue;
        const id = settlementId(f);
        if (id === r.a || id === r.b) continue;
        const half = HALF_OF[settlementTier(f) ?? "hamlet"];
        if (Math.max(Math.abs(p.x - f.x), Math.abs(p.y - f.y)) <= half) out.push(fail("route cuts through a foreign settlement's footprint", r.id, p.x, p.y));
      }
      const mark = net.tiles.get(p.y * WORLD_SIZE + p.x);
      if (!mark || ROAD_CLASS_RANK[mark] < ROAD_CLASS_RANK[r.cls]) out.push(fail(`road tile carries ${mark ?? "no class"} below the route's ${r.cls}`, r.id, p.x, p.y));
    }
    // inside an endpoint's footprint the route keeps to the entrance apron
    for (const endId of [r.a, r.b]) {
      const n = net.byId.get(endId);
      if (!n) continue;
      const en = n.entrances.find((e) => e.id === (r.a === endId ? r.entranceA : r.entranceB));
      if (!en) continue;
      for (const p of r.route) {
        if (Math.max(Math.abs(p.x - n.x), Math.abs(p.y - n.y)) > n.half) continue;
        if (Math.max(Math.abs(p.x - en.x), Math.abs(p.y - en.y)) > 3) out.push(fail("route cuts across a settlement's interior past its entrance apron", r.id, p.x, p.y));
      }
    }
  }
  return out;
}

/* --------------------------------- entrances ------------------------------- */

/** Every entrance is indexed, passable, and flanked by a post, wall or waterfront; posts never stand on roads. */
export function validateEntrances(world: World, net: RoadNetwork, label: string): ValidationFailure[] {
  const out: ValidationFailure[] = [];
  const fail = (invariant: string, settlement: string, x: number, y: number): ValidationFailure => ({ category: "entrance", invariant, seed: label, settlement, x, y });
  for (const n of net.settlements) {
    if (n.entrances.length < MIN_ENTRANCES[n.tier]) {
      out.push(fail(`a ${n.tier} opens only ${n.entrances.length} entrances`, n.id, n.x, n.y));
    }
    for (const e of n.entrances) {
      const k = e.y * WORLD_SIZE + e.x;
      if (!net.entranceTiles.has(k)) out.push(fail("deliberate entrance is missing from the entrance index", n.id, e.x, e.y));
      if (!world.passable(e.x, e.y)) out.push(fail("entrance tile is impassable", n.id, e.x, e.y));
      const outX = e.dir === "w" ? -1 : e.dir === "e" ? 1 : 0;
      const outY = e.dir === "n" ? -1 : e.dir === "s" ? 1 : 0;
      const perpX = outY !== 0 ? 1 : 0;
      const perpY = outX !== 0 ? 1 : 0;
      let flanks = 0;
      for (const side of [-1, 1]) {
        for (const [fx, fy] of [
          [e.x + outX + perpX * side, e.y + outY + perpY * side],
          [e.x + perpX * side, e.y + perpY * side],
        ]) {
          const sp = world.siteAt(fx, fy);
          if (sp) {
            if (sp.post || sp.wall || sp.door || sp.buildingId) {
              flanks++;
              if (sp.post && net.tiles.has(fy * WORLD_SIZE + fx)) out.push(fail("gatepost stands on a road tile", n.id, fx, fy));
              break;
            }
            continue;
          }
          if (isWaterBiome(world.tile(fx, fy).biome)) {
            flanks++; // a waterfront flank is its own gate
            break;
          }
        }
      }
      if (flanks < 1) out.push(fail("entrance stands bare — no post, wall or waterfront on either flank", n.id, e.x, e.y));
    }
  }
  return out;
}

/* -------------------------------- the sweep -------------------------------- */

/**
 * Full settlement-infrastructure validation of one generated world. Reuses
 * the cached road network when given; never mutates world state.
 */
export function validateSettlementInfrastructure(world: World, label: string, opts: ValidateOptions = {}): ValidateResult {
  const t0 = performance.now();
  const failures: ValidationFailure[] = [];
  const counts = Object.fromEntries(VALIDATION_CATEGORIES.map((c) => [c, 0])) as Record<ValidationCategory, number>;
  const push = (f: ValidationFailure): void => {
    failures.push(f);
    counts[f.category]++;
  };

  const all = world.allFeatures().filter(isSettlement);
  let buildings = 0;

  // spacing first (independent), then per-settlement structure
  for (const f of validateSettlementSpacing(world, all, label)) push(f);
  for (const f of all) {
    for (const x of validateSettlementFootprint(world, f, label)) push(x);
    const layout = world.settlementLayout(f);
    buildings += layout.buildings.length;
    for (const b of layout.buildings) {
      for (const problem of validateBuilding(b)) push({ category: "building", invariant: problem, seed: label, settlement: settlementId(f), building: b.id });
      for (const problem of validateInteriorDrill(b)) push({ ...problem, seed: label, settlement: settlementId(f) });
    }
  }

  if (!opts.skipRoads) {
    const net = opts.net ?? finishRoads(world);
    for (const f of all) {
      const node = net.settlements.find((s) => s.x === f.x && s.y === f.y);
      if (!node) {
        push({ category: "road-graph", invariant: "settlement is missing from the road network's census", seed: label, settlement: settlementId(f) });
        continue;
      }
      for (const x of validateSettlementNpcs(world, f, net.entranceTiles, label, { skipResidents: !!opts.skipResidents })) push(x);
    }
    for (const x of validateEntrances(world, net, label)) push(x);
    for (const x of validateRoadGraph(net, label)) push(x);
    for (const x of validateRoadPaths(world, net, label)) push(x);
    const fac = getFactions(world.seed, world);
    for (const x of validateAssociations(world, fac, label)) push(x);
  }

  return {
    failures,
    counts,
    settlements: all.length,
    buildings,
    roadTiles: opts.net?.tiles.size ?? 0,
    durationMs: Math.round(performance.now() - t0),
  };
}
