/**
 * Population ecology (Phase 7) — the feedback loop that makes monster
 * populations emerge from ecological conditions instead of spawn limits:
 *
 *   resources → carrying capacity → population density
 *   → competition / reproduction / survival → births and deaths
 *   → population change → resource pressure
 *
 * Individual populations near the player are the wild creatures the wildlife
 * sim already manages; this module never spawns offspring (reproduction stays
 * the biological authority) and never deletes creatures arbitrarily — mortality
 * happens through ecological pressure on real bodies, delegated to sim's
 * canonical death path. Aggregate per-region populations are recorded for the
 * later distant-world simulation (Phase 11).
 *
 * Territories (Phase 6) are the ecological unit: this module queries and
 * prices the existing Territory objects — it defines no second territory
 * representation. Everything runs on a slow cadence (ECOLOGY_INTERVAL), never
 * per frame.
 */
import { BIOMES, SPECIES, developmentTypeFor } from "./data";
import { recordLineageDeath } from "./lineage";
import { bodyFootprint, foodDemand, footprintClass, isJuvenile, physicalSize } from "./growth";
import { heightOf, layerOf, sameLayer } from "./height";
import { clamp, hash01, hashString } from "./rng";
import { isBreedingAvailable } from "./reproduction";
import { TERRITORY_RADIUS, territoryAt } from "./territory";
import type { EcologyState, GameState, RegionPopulation, Territory, WildCreature } from "./types";
import { seasonIndex, type World } from "./world";

/* --------------------------------- Config ----------------------------------- */

/** Ecological tick cadence (ticks). ~3 in-world hours — slower than combat. */
export const ECOLOGY_INTERVAL = 36;
/** Adult-equivalents a prime, full-size territory supports before modifiers. */
export const ECO_BASE_CAPACITY = 6;
/** Food supply (units) considered "rich" — normalizes the resource factor. */
export const FOOD_REFERENCE = 3;
/** Baseline juvenile mortality per ecological interval under fair conditions. */
export const JUVENILE_MORTALITY = 0.008;
/**
 * Technical safety cap on live wild bodies. This is a performance/simulation
 * safeguard, NOT an ecological mechanic — populations are shaped by carrying
 * capacity; this only bounds worst-case memory and tick cost.
 */
export const CREATURE_CAP = 360;
/** Fraction of a territory's capacity one species may claim (competition headroom). */
export const SPECIES_SHARE = 0.6;
const REGION_CELL = 160;
const REGION_MAX_KEYS = 400;

/* --------------------------------- Census ----------------------------------- */

export interface TerritoryCensus {
  territory: Territory;
  bodies: WildCreature[];
  adults: number;
  juveniles: number;
  bySpecies: Map<string, { adults: number; juveniles: number }>;
  /** Carnivores of other species hunting in this range. */
  predators: number;
  /** Other species sharing the range's forage. */
  competitors: number;
  /** Total food demand (growth-derived) of every body in the range. */
  demand: number;
  /** Active nests registered to this territory. */
  nests: number;
}

/** One pass over the live creatures, grouped into their territories (player's layer only). */
export function buildCensus(gs: GameState, world: World, layer: number): Map<string, TerritoryCensus> {
  const territories = Object.values(gs.territories).filter((t) => (t.layer ?? 0) === layer);
  const map = new Map<string, TerritoryCensus>();
  for (const t of territories) {
    map.set(t.id, { territory: t, bodies: [], adults: 0, juveniles: 0, bySpecies: new Map(), predators: 0, competitors: 0, demand: 0, nests: 0 });
  }
  for (const c of Object.values(gs.creatures)) {
    if (!sameLayer(gs, c)) continue;
    const t = territories.find((tt) => Math.max(Math.abs(c.x - tt.x), Math.abs(c.y - tt.y)) <= tt.radius);
    if (!t) continue;
    const e = map.get(t.id)!;
    const juv = isJuvenile(c.bornTick, c.speciesId, gs.tick);
    e.bodies.push(c);
    if (juv) e.juveniles++;
    else e.adults++;
    const mine = e.bySpecies.get(c.speciesId) ?? { adults: 0, juveniles: 0 };
    if (juv) mine.juveniles++;
    else mine.adults++;
    e.bySpecies.set(c.speciesId, mine);
    const sp = SPECIES[c.speciesId];
    if (c.speciesId !== t.speciesId) {
      if (sp.diet === "carnivore") e.predators++;
      else e.competitors++;
    }
    e.demand += foodDemand(c, c.speciesId, gs.tick);
  }
  for (const e of map.values()) {
    for (const nid of e.territory.nestIds) {
      const n = gs.nests[nid];
      if (n && n.state === "active") e.nests++;
    }
  }
  return map;
}

/* ------------------------------ Food & capacity ------------------------------ */

const FOOD_SAMPLES: [number, number][] = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]];

/** Forage-based food supply around a territory center (units per interval). */
export function foodSupply(world: World, t: Territory): number {
  let s = 0;
  for (const [fx, fy] of FOOD_SAMPLES) {
    const x = Math.round(t.x + fx * t.radius);
    const y = Math.round(t.y + fy * t.radius);
    if (!world.inBounds(x, y)) continue;
    const b = BIOMES[world.tile(x, y).biome];
    s += b.forageChance * (1 + b.forage.reduce((a, [, w]) => a + w, 0) / 8);
  }
  return s;
}

/**
 * The carrying-capacity factors, explicit and independently adjustable.
 * Capacity = base × biome × resource × quality × nest × predator × competition × suitability.
 */
export interface CapacityFactors {
  /** ECO_BASE_CAPACITY scaled by range area. */
  base: number;
  /** Biome density (0.1–1): how much life the ground itself supports. */
  biomeSuitability: number;
  /** Forage richness relative to FOOD_REFERENCE (0.15–1.5). */
  resourceAvailability: number;
  /** The territory's own quality score (0.2–1). */
  territoryQuality: number;
  /** Nesting provision for egg-laying species (0.55–1). */
  nestAvailability: number;
  /** Predator suppression (≤1). */
  predatorModifier: number;
  /** Interspecific competition suppression (≤1). */
  competitionModifier: number;
  /** Current weather and season suitability (0.72–1). */
  suitability: number;
}

export function capacityFactors(gs: GameState, world: World, t: Territory, cens?: TerritoryCensus, food?: number): CapacityFactors {
  const f = food ?? foodSupply(world, t);
  const w = world.weather(t.x, t.y, gs.tick).id;
  let suitability = w === "storm" || w === "sandstorm" ? 0.8 : w === "snow" ? 0.85 : w === "rain" ? 0.95 : 1;
  if (seasonIndex(gs.tick) === 3) suitability *= 0.9;
  return {
    base: ECO_BASE_CAPACITY * (t.radius / TERRITORY_RADIUS) ** 2,
    biomeSuitability: clamp(BIOMES[world.tile(t.x, t.y).biome].density, 0.1, 1),
    resourceAvailability: clamp(f / FOOD_REFERENCE, 0.15, 1.5),
    territoryQuality: clamp(t.quality / 100, 0.2, 1),
    nestAvailability: developmentTypeFor(t.speciesId, "sexual") === "egg" ? 0.55 + 0.45 * Math.min(1, (cens?.nests ?? 0) / 2) : 1,
    predatorModifier: 1 / (1 + (cens?.predators ?? 0) * 0.15),
    competitionModifier: 1 / (1 + (cens?.competitors ?? 0) * 0.05),
    suitability,
  };
}

/** The carrying-capacity formula — one place to tune the whole ecosystem. */
export function carryingCapacity(f: CapacityFactors): number {
  return Math.max(
    1,
    Math.round(f.base * f.biomeSuitability * f.resourceAvailability * f.territoryQuality * f.nestAvailability * f.predatorModifier * f.competitionModifier * f.suitability),
  );
}

/* --------------------------------- Report ------------------------------------ */

export interface TerritoryEcology {
  territoryId: string;
  speciesId: string;
  x: number;
  y: number;
  radius: number;
  layer: number;
  adults: number;
  juveniles: number;
  reproductive: number;
  capacity: number;
  /** Population relative to capacity (adults + half-weight juveniles). */
  density: number;
  food: number;
  foodDemand: number;
  foodPerCapita: number;
  nests: number;
  nestAvailability: number;
  predatorPressure: number;
  competitionPressure: number;
  quality: number;
  suitability: number;
  births: number;
  deaths: number;
  juvenileDeaths: number;
  /** 0–1: how hard this range pushes its residents to leave (Phase 9 behavior hook). */
  migrationPressure: number;
  factors: CapacityFactors;
}

/** Full ecological assessment of one territory (cheap; used by UI, gates and the tick). */
export function assessTerritory(gs: GameState, world: World, t: Territory, cens?: TerritoryCensus): TerritoryEcology {
  const food = foodSupply(world, t);
  const factors = capacityFactors(gs, world, t, cens, food);
  const capacity = carryingCapacity(factors);
  const adults = cens?.adults ?? 0;
  const juveniles = cens?.juveniles ?? 0;
  const demand = cens?.demand ?? 0;
  const vital = gs.ecology?.vitals[t.speciesId];
  const perCapita = food / Math.max(0.001, demand);
  const predatorPressure = Math.min(1.5, (cens?.predators ?? 0) * 0.18);
  const competitionPressure = Math.min(1.5, (cens?.competitors ?? 0) * 0.08);
  const density = (adults + juveniles * 0.5) / Math.max(1, capacity);
  let reproductive = 0;
  for (const b of cens?.bodies ?? []) if (isBreedingAvailable(b, gs.tick)) reproductive++;
  return {
    territoryId: t.id,
    speciesId: t.speciesId,
    x: t.x,
    y: t.y,
    radius: t.radius,
    layer: t.layer ?? 0,
    adults,
    juveniles,
    reproductive,
    capacity,
    density,
    food,
    foodDemand: demand,
    foodPerCapita: perCapita,
    nests: cens?.nests ?? 0,
    nestAvailability: factors.nestAvailability,
    predatorPressure,
    competitionPressure,
    quality: t.quality,
    suitability: factors.suitability,
    births: vital?.births ?? 0,
    deaths: vital?.deaths ?? 0,
    juvenileDeaths: vital?.juvenileDeaths ?? 0,
    migrationPressure: clamp(
      0.5 * Math.max(0, density - 1) + 0.4 * Math.max(0, 1 - perCapita) + 0.3 * predatorPressure + 0.25 * Math.max(0, 0.5 - t.quality / 100) + 0.2 * (1 - factors.suitability),
      0,
      1,
    ),
    factors,
  };
}

/* ---------------------------- Reproduction gate ------------------------------ */

/**
 * Ecology's input to breeding: environmental conditions decide whether a pair
 * even attempts courtship — and, since courtship that passes this gate
 * conceives (beginBreeding is deterministic), this probability IS the wild
 * conception chance. It never creates offspring — the reproduction engine
 * remains the biological authority; this only weighs permission.
 * Unclaimed wilderness (no territory) is unrestricted, as before.
 */
export function allowsBreeding(gs: GameState, world: World, c: WildCreature, rng: { next(): number }, eco?: TerritoryEcology): boolean {
  const t = territoryAt(gs, c.x, c.y, c.layer);
  if (!t) return true;
  // the census matters: without it the assessment sees no bodies and every
  // range looks empty. Callers with a cached assessment pass it in; direct
  // callers get a fresh census-backed one so density and food truly gate.
  const assessed = eco ?? assessTerritory(gs, world, t, buildCensus(gs, world, layerOf(gs)).get(t.id));
  if (assessed.foodPerCapita < 0.3 || assessed.density > 1.6) return false;
  // 1.15× (floor 0.05): a modestly more fertile conception rate under fair
  // conditions — still fully resource-, density- and predator-limited
  const raw = 1.15 * Math.min(1, assessed.foodPerCapita) * (1 - 0.4 * Math.max(0, assessed.density - 0.8)) * (1 - 0.35 * Math.min(1, assessed.predatorPressure)) * assessed.nestAvailability * assessed.suitability;
  const p = clamp(raw, 0.05, 0.95);
  return rng.next() < p;
}

/* ------------------------------- Spawn gate ---------------------------------- */

/**
 * Ecological constraint on spawning: a territory at (or over) capacity, or one
 * where this species already holds its share, receives no new immigrants.
 * Returns true when spawning may proceed. Technical caps are separate.
 */
export function spawnAllowedByEcology(gs: GameState, world: World, layer: number, x: number, y: number, speciesId: string, index: Map<string, TerritoryCensus>): boolean {
  const t = territoryAt(gs, x, y, layer);
  if (!t) return true;
  const cens = index.get(t.id);
  const cap = carryingCapacity(capacityFactors(gs, world, t, cens));
  if (!cens) return cap >= 1;
  const mine = cens.bySpecies.get(speciesId);
  const minePop = mine ? mine.adults + mine.juveniles : 0;
  return cens.adults + cens.juveniles < cap && minePop < Math.ceil(cap * SPECIES_SHARE);
}

/* --------------------------------- Vitals ------------------------------------ */

function ensureEcology(gs: GameState): EcologyState {
  if (!gs.ecology) gs.ecology = { vitals: {}, regions: {}, lastTick: gs.tick };
  return gs.ecology;
}

function regionOf(gs: GameState, x: number, y: number, speciesId: string): { e: EcologyState; r: RegionPopulation } {
  const e = ensureEcology(gs);
  const key = `r:${Math.floor(x / REGION_CELL)},${Math.floor(y / REGION_CELL)}`;
  const list = e.regions[key] ?? (e.regions[key] = []);
  let r = list.find((p) => p.speciesId === speciesId);
  if (!r) {
    r = { speciesId, pop: 0, juveniles: 0, births: 0, deaths: 0, tick: gs.tick };
    list.push(r);
  }
  if (Object.keys(e.regions).length > REGION_MAX_KEYS) {
    for (const k of Object.keys(e.regions)) {
      if (e.regions[k].every((p) => p.pop <= 0)) delete e.regions[k];
      if (Object.keys(e.regions).length <= REGION_MAX_KEYS) break;
    }
  }
  return { e, r };
}

/** A birth entered the world (event-driven vitals; never creates creatures). */
export function ecoOnBirth(gs: GameState, speciesId: string, x: number, y: number, juvenile: boolean): void {
  const { e, r } = regionOf(gs, x, y, speciesId);
  const v = e.vitals[speciesId] ?? (e.vitals[speciesId] = { births: 0, deaths: 0, juvenileDeaths: 0 });
  v.births++;
  r.pop++;
  if (juvenile) r.juveniles++;
  r.births++;
  r.tick = gs.tick;
}

/** A death left the world (event-driven vitals; never deletes creatures itself). */
export function ecoOnDeath(gs: GameState, speciesId: string, x: number, y: number, juvenile: boolean): void {
  const { e, r } = regionOf(gs, x, y, speciesId);
  const v = e.vitals[speciesId] ?? (e.vitals[speciesId] = { births: 0, deaths: 0, juvenileDeaths: 0 });
  v.deaths++;
  if (juvenile) v.juvenileDeaths++;
  r.pop = Math.max(0, r.pop - 1);
  if (juvenile) r.juveniles = Math.max(0, r.juveniles - 1);
  r.deaths++;
  r.tick = gs.tick;
}

/** Records any wild body's death with the right juvenile flag (and its lineage exit). */
export function ecoOnCreatureDeath(gs: GameState, c: WildCreature): void {
  ecoOnDeath(gs, c.speciesId, c.x, c.y, isJuvenile(c.bornTick, c.speciesId, gs.tick));
  recordLineageDeath(gs, c);
}

/* ------------------------------- The tick ------------------------------------ */

/** Juvenile survival chance per interval under these conditions (pure; exported for balance tests). */
export function juvenileMortalityChance(eco: TerritoryEcology, nestSecure: boolean): number {
  return clamp(
    JUVENILE_MORTALITY * (1 / Math.max(0.35, eco.foodPerCapita)) * (1 + eco.density) * (1 + eco.predatorPressure) * (1 + (1 - eco.suitability)) * (nestSecure ? 1 : 1.6),
    0,
    0.5,
  );
}

/** Adult ecological mortality per interval under starvation and crowding (pure; exported for balance tests). */
export function adultMortalityChance(eco: TerritoryEcology): number {
  if (eco.density <= 1.25 || eco.foodPerCapita >= 0.8) return 0;
  return Math.min(0.15, 0.02 * (eco.density - 1) * (1 / Math.max(0.3, eco.foodPerCapita)));
}

/**
 * One ecological interval: juvenile survival, hunger and mortality pressure on
 * over-capacity ranges, and growth resolution. Removals are delegated to the
 * `remove` callback (sim's canonical death path) so nests, territories and
 * logging stay consistent with every other cause of death.
 */
export function ecologyTick(gs: GameState, world: World, remove: (id: string, cause: "juvenile" | "scarcity") => void): void {
  const e = ensureEcology(gs);
  if (gs.tick - e.lastTick < ECOLOGY_INTERVAL) return;
  e.lastTick = gs.tick;
  const layer = layerOf(gs);
  const census = buildCensus(gs, world, layer);
  for (const cens of census.values()) {
    const eco = assessTerritory(gs, world, cens.territory, cens);
    const scarcity = Math.max(0, 1 - eco.foodPerCapita);
    for (const c of cens.bodies) {
      if (!gs.creatures[c.id]) continue;
      if (isJuvenile(c.bornTick, c.speciesId, gs.tick)) {
        const nestSecure = c.repro?.nestId ? gs.nests[c.repro.nestId]?.state === "active" : true;
        if (hash01(gs.seed ^ hashString(c.id), gs.tick, 0xec0) < juvenileMortalityChance(eco, nestSecure)) {
          remove(c.id, "juvenile");
          continue;
        }
      } else {
        if (scarcity > 0) c.satiety = Math.max(0, c.satiety - scarcity * 0.6);
        if (hash01(gs.seed ^ hashString(c.id), gs.tick, 0xec1) < adultMortalityChance(eco)) {
          remove(c.id, "scarcity");
          continue;
        }
      }
    }
  }
  resolveGrowth(gs, world);
}

/* ---------------------------- Growth resolution ------------------------------ */

/** All tiles of an fp×fp body at (x,y) are free (terrain + other bodies). */
function spotFree(gs: GameState, world: World, layer: number, x: number, y: number, fp: number, ignoreId?: string, ignoreUid?: string): boolean {
  const hf = heightOf(world);
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (!world.inBounds(tx, ty)) return false;
      if (layer < 0) {
        if (!hf.caveOpen(layer, tx, ty)) return false;
      } else if (!world.passable(tx, ty) || world.siteAt(tx, ty)?.wall) return false;
      if (gs.player.x === tx && gs.player.y === ty) return false;
      for (const o of Object.values(gs.creatures)) {
        if (o.id === ignoreId || !sameLayer(gs, o)) continue;
        const ofp = bodyFootprint(o, gs.tick);
        if (tx >= o.x && tx < o.x + ofp && ty >= o.y && ty < o.y + ofp) return false;
      }
      for (const m of gs.party) {
        if (m.uid === ignoreUid) continue;
        const pos = gs.field[m.uid];
        if (!pos) continue;
        const mfp = bodyFootprint(m, gs.tick);
        if (tx >= pos.x && tx < pos.x + mfp && ty >= pos.y && ty < pos.y + mfp) return false;
      }
    }
  }
  return true;
}

/**
 * The one growth-transition pathway: when a body's phenotype class outgrows
 * its placement cap, the transition applies at the current spot, a nearby
 * spot, or is delayed (fpCap holds) — a creature never becomes stuck inside
 * invalid geometry, and nothing expands into occupied or impassable tiles.
 */
export function resolveGrowth(gs: GameState, world: World): void {
  const layer = layerOf(gs);
  for (const c of Object.values(gs.creatures)) {
    if (!sameLayer(gs, c) || c.bornTick === undefined) continue;
    const want = footprintClass(physicalSize(c, c.speciesId, gs.tick));
    if (c.fpCap === undefined) {
      // first management: freeze the currently-occupied class
      c.fpCap = want;
      continue;
    }
    if (want <= c.fpCap) continue;
    let done = false;
    for (let r = 0; r <= 2 && !done; r++) {
      for (let dy = -r; dy <= r && !done; dy++) {
        for (let dx = -r; dx <= r && !done; dx++) {
          const x = c.x + dx;
          const y = c.y + dy;
          if (!spotFree(gs, world, layer, x, y, want, c.id)) continue;
          c.x = x;
          c.y = y;
          c.fpCap = want;
          done = true;
        }
      }
    }
  }
  for (const m of gs.party) {
    const pos = gs.field[m.uid];
    const want = footprintClass(physicalSize(m, m.speciesId, gs.tick));
    if (m.fpCap === undefined) {
      m.fpCap = want;
      continue;
    }
    if (want <= m.fpCap) continue;
    if (!pos) {
      m.fpCap = want;
      continue;
    }
    let placed = false;
    for (let r = 0; r <= 2 && !placed; r++) {
      for (let dy = -r; dy <= r && !placed; dy++) {
        for (let dx = -r; dx <= r && !placed; dx++) {
          const x = pos.x + dx;
          const y = pos.y + dy;
          if (!spotFree(gs, world, layer, x, y, want, undefined, m.uid)) continue;
          gs.field[m.uid] = { x, y };
          m.fpCap = want;
          placed = true;
        }
      }
    }
  }
}

/* -------------------------------- Migration ---------------------------------- */

/** Backfills and sanitizes ecology state for older saves — idempotent, runs on every load. */
export function migrateEcology(gs: GameState): void {
  const e = ensureEcology(gs);
  if (!Number.isFinite(e.lastTick)) e.lastTick = gs.tick;
  for (const key of Object.keys(e.regions)) {
    const list = e.regions[key].filter((p) => p && typeof p.speciesId === "string" && Number.isFinite(p.pop));
    if (list.length) e.regions[key] = list;
    else delete e.regions[key];
  }
}
