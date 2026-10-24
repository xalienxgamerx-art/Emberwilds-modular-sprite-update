/**
 * Persistent distant-world simulation (Phase 11) — the abstraction and
 * materialization layer between the detailed local simulation (sim.ts) and
 * the world that keeps living while the player is far away.
 *
 * Two representations, one set of rules:
 *
 *   • Local: individual wild creatures within the active radius keep the full
 *     Phase 9/10 simulation (identity, genotype, behavior, nests, territories).
 *   • Distant: when the player leaves a chunk-region, its ordinary wildlife is
 *     folded into bounded aggregate populations (one per species per chunk).
 *     They keep breeding, dying, competing, predating and migrating through the
 *     SAME ecological formulas (ecology.ts capacity, mortality and assessment;
 *     wildlife.ts predation rule) — never a second biology.
 *
 * Transitions are conservative: state is transferred first, bodies removed
 * only after the aggregate holds it; materialization is bounded (MAT_CAP_*)
 * and reconciles against the population's CURRENT count, so the dead stay
 * dead, migrants stay gone, and no creature is ever duplicated or respawned
 * from a stale snapshot. Elapsed time is processed in bounded day-steps with
 * an exactly-once guarantee carried by each region's `lastTick`.
 *
 * Anchored spawns (lair packs, mouth burrowers) and exceptional individuals
 * (established lineages, near-ceiling genes) are never absorbed: the former
 * respawn from world features, the latter persist as real bodies. Monsters the
 * player has personally met (`known`) are likewise never absorbed — every
 * encountered individual persists for the life of the world.
 *
 * Distant reproduction runs through the one shared birth path: a conception is
 * a reproductive-development record — an egg laid in a persistent, population-
 * owned nest (for egg-layers) or a gestation — and the population grows only
 * when it completes. Unloading is never a lifecycle event: a folded body's
 * active nests pass into its population's care instead of being abandoned.
 */
import { BIOMES, DAY_TICKS, PERSONALITIES, SPECIES, WORLD_SIZE, developmentTypeFor, footprintOf } from "./data";
import { DEVELOPMENT_TICKS, NEST_CAPACITY, createNest } from "./breeding";
import { ALLELE_MAX, ALLELE_MIN, driftGenome, expressGene, expressGenome, founderLineage, genomeFromGenes, GENE_KEYS } from "./genetics";
import { partyMonAt } from "./combat";
import { adultMortalityChance, assessTerritory, CREATURE_CAP, ecoOnBirth, ecoOnDeath, juvenileMortalityChance, type TerritoryCensus, type TerritoryEcology } from "./ecology";
import { isJuvenile, JUVENILE_TICKS, NEWBORN_TICKS } from "./growth";
import { UW, heightOf, layerOf } from "./height";
import { skillsForLevel } from "./monster";
import { clamp, hash01, hash3, hashString, Rng } from "./rng";
import { CHUNK, activeBodyCount, creatureAt, fitsFootprint, makeCreature } from "./sim";
import { ensureTerritory, homeAnchor, territoryAt } from "./territory";
import { predatesOn } from "./wildlife";
import type { AbstractPop, ChildBlueprint, DevelopmentType, DistantRegion, GameState, Genes, Nest, PersonalityId, ReproductiveDevelopment, ReproPairing, Sex, Territory, WildCreature } from "./types";
import { type World } from "./world";

/* --------------------------------- Config ----------------------------------- */

/** One abstract step = one in-world day (288 ticks). */
export const DISTANT_INTERVAL = DAY_TICKS;
/** Distant regions processed per tick (bounded work; keeps up at any population). */
export const DISTANT_BUDGET = 2;
/** Bounded catch-up: at most this many day-steps run per region per update. */
export const MAX_CATCHUP_STEPS = 45;
/** Technical safeguard per population — performance bound, NOT an ecological cap. */
export const POP_CAP = 180;
/** Bodies materialized per species per chunk load. */
export const MAT_CAP_SPECIES = 5;
/** Total bodies materialized per chunk load. */
export const MAT_CAP_REGION = 12;
/** Per-fertile-adult daily birth chance at fair conditions (aggregate of the mating rules). */
export const DISTANT_BIRTH_RATE = 0.12;
/** Prey fraction lost per unit of predator pressure per day. */
export const DISTANT_PREDATION = 0.25;
/** Same migration pressure threshold as individual migration (Phase 9). */
export const MIGRATION_PRESSURE = 0.55;
/** Fraction of a population that disperses when pressure bites. */
export const MIGRATION_FRACTION = 0.2;
/** Technical bound on tracked regions (oldest empty ones are pruned). */
const REGION_CAP = 400;
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Chunk coords inside the world (evaluated lazily — sim exports are not ready at module init). */
const inWorldChunk = (cx: number, cy: number): boolean => cx >= 0 && cy >= 0 && cx < WORLD_SIZE / CHUNK && cy < WORLD_SIZE / CHUNK;

/* ------------------------------- Region state -------------------------------- */

export const distantKey = (layer: number, cx: number, cy: number): string => `d:${layer}:${cx},${cy}`;

function ensureDistant(gs: GameState): Record<string, DistantRegion> {
  if (!gs.distant) gs.distant = {};
  return gs.distant;
}

/** Creates or returns the abstract region for a chunk (deterministic identity). */
export function ensureRegion(gs: GameState, layer: number, cx: number, cy: number): DistantRegion {
  const d = ensureDistant(gs);
  const key = distantKey(layer, cx, cy);
  let r = d[key];
  if (!r) {
    r = { key, layer, cx, cy, pops: [], lastTick: gs.tick, abstracted: false };
    d[key] = r;
  }
  return r;
}

function ensurePop(reg: DistantRegion, speciesId: string, seed: number): AbstractPop {
  let p = reg.pops.find((q) => q.speciesId === speciesId);
  if (!p) {
    p = {
      speciesId,
      count: 0,
      juveniles: 0,
      genes: {} as Genes,
      satiety: 60,
      level: 5,
      lineageId: null,
      seed,
    };
    reg.pops.push(p);
  }
  return p;
}

/** Feature-anchored spawns keep their own deterministic respawn rules and are never abstracted. */
export const isAnchoredSpawn = (id: string): boolean => id.startsWith("l:") || id.startsWith("m:");

/** Established lineages and near-ceiling genes stay individuals — abstraction never erases them. */
export function isExceptionalCreature(c: WildCreature): boolean {
  if ((c.gen ?? 1) >= 3) return true;
  if (!c.genes) return false;
  for (const k of GENE_KEYS) if (expressGene(c.genes[k]) >= 90) return true;
  return false;
}

/* ------------------------------- Abstraction --------------------------------- */

function blendGenes(old: Genes, add: Genes, n: number): Genes {
  if (n <= 0 || !Object.keys(old).length) return { ...add };
  const out = {} as Genes;
  for (const k of GENE_KEYS) out[k] = (old[k] * n + add[k]) / (n + 1);
  return out;
}

/**
 * Folds one leaving body into its home chunk's abstract population.
 * Returns true when the caller may delete the body; false when it must
 * remain an individual (anchored spawns, exceptional creatures).
 */
export function abstractDroppedCreature(gs: GameState, c: WildCreature): boolean {
  if (isAnchoredSpawn(c.id)) return false;
  // a monster the player has truly met stays a real individual forever
  if (c.known) return false;
  if (isExceptionalCreature(c)) return false;
  const home = homeAnchor(gs, c);
  const layer = c.layer ?? 0;
  const reg = ensureRegion(gs, layer, Math.floor(home.x / CHUNK), Math.floor(home.y / CHUNK));
  const p = ensurePop(reg, c.speciesId, gs.seed ^ hashString(reg.key + c.speciesId));
  const expr = c.genes ? expressGenome(c.genes) : null;
  const n = p.count;
  if (expr) p.genes = blendGenes(p.genes, expr, n);
  p.satiety = (p.satiety * n + clamp(c.satiety, 0, 100)) / (n + 1);
  p.level = (p.level * n + clamp(c.level, 1, 50)) / (n + 1);
  p.count = n + 1;
  if (isJuvenile(c.bornTick, c.speciesId, gs.tick)) p.juveniles++;
  p.lineageId ??= c.lineageId ?? null;
  // unloading is not a lifecycle event: the leaving body's active nests pass
  // into the population's care and stay active
  for (const nest of Object.values(gs.nests)) {
    if (nest.ownerId === c.id && nest.state === "active") nest.ownerId = popOwnerId(reg);
  }
  reg.abstracted = true;
  return true;
}

/* -------------------- Distant conceptions & persistent nests ------------------ */

/** Nests tended by the abstract population itself rather than one individual body. */
export const popOwnerId = (reg: DistantRegion): string => `pop:${reg.key}`;
export const isPopOwnedNest = (ownerId: string): boolean => ownerId.startsWith("pop:");

/** Open ground in the region for a new nest (deterministic). */
function popNestSpot(gs: GameState, world: World, reg: DistantRegion): { x: number; y: number } | null {
  const rng = new Rng(gs.seed ^ hashString(reg.key) ^ 0x3e57);
  for (let k = 0; k < 24; k++) {
    const x = reg.cx * CHUNK + Math.floor(rng.next() * CHUNK);
    const y = reg.cy * CHUNK + Math.floor(rng.next() * CHUNK);
    if (reg.layer >= 0) {
      if (!world.inBounds(x, y)) continue;
      const t = world.tile(x, y);
      if (!BIOMES[t.biome].passable || t.feature || world.siteAt(x, y)?.wall) continue;
    } else if (reg.layer === UW ? !heightOf(world).uwOpen(x, y) : !heightOf(world).caveOpen(reg.layer, x, y)) continue;
    return { x, y };
  }
  return null;
}

/**
 * The region's persistent nest for this species: an under-capacity population
 * nest is reused, else a new one is built. Nests are world state — they exist
 * whether or not anyone is looking, and a revisited region finds them waiting.
 */
function popNestFor(gs: GameState, world: World, reg: DistantRegion, speciesId: string): Nest | null {
  const load = (n: Nest): number =>
    n.developmentIds.filter((id) => {
      const d = gs.developments[id];
      return !!d && (d.state === "developing" || d.state === "ready");
    }).length;
  for (const n of Object.values(gs.nests)) {
    if (n.state !== "active" || n.speciesId !== speciesId || !isPopOwnedNest(n.ownerId)) continue;
    if ((n.layer ?? 0) !== reg.layer) continue;
    if (Math.floor(n.x / CHUNK) !== reg.cx || Math.floor(n.y / CHUNK) !== reg.cy) continue;
    if (load(n) < NEST_CAPACITY) return n;
  }
  const at = popNestSpot(gs, world, reg);
  if (!at) return null;
  const nest = createNest(gs, popOwnerId(reg), speciesId, at.x, at.y);
  // createNest stamps the player's layer; distant regions live on their own layer
  if (reg.layer !== 0) nest.layer = reg.layer;
  // join a covering territory when one exists — never found one remotely
  const t = territoryAt(gs, nest.x, nest.y, reg.layer);
  if (t) {
    nest.territoryId = t.id;
    if (!t.nestIds.includes(nest.id)) t.nestIds.push(nest.id);
  }
  return nest;
}

/** The inherited blueprint of a distant conception, drawn from the population's mean genome. */
function distantChild(gs: GameState, reg: DistantRegion, p: AbstractPop, pairing: ReproPairing): ChildBlueprint {
  const rng = new Rng(p.seed ^ hashString(reg.key) ^ (gs.broodSeq + 1) * 0x9e37);
  const genome = genomeFromGenes(p.genes, p.speciesId, rng);
  const sex: Sex = SPECIES[p.speciesId].sexed === false ? "asexual" : rng.chance(0.5) ? "female" : "male";
  return {
    speciesId: p.speciesId,
    sex,
    level: Math.max(1, Math.round(p.level) - 2),
    genes: driftGenome(genome, rng),
    mutations: [],
    personality: rng.pick(Object.keys(PERSONALITIES) as PersonalityId[]),
    skills: skillsForLevel(p.speciesId, 1),
    plus: 1,
    bond: 20,
    generation: p.lineageId ? 2 : 1,
    lineageId: p.lineageId ?? founderLineage(popOwnerId(reg)),
    mutHistory: [],
  };
}

/**
 * Records one distant conception as a reproductive development — the same
 * record a local pair would create. Egg-layers conceive only when the region's
 * nest provision has room, and the egg is laid in a persistent, population-
 * owned nest. The population count grows when development completes, never here.
 */
function distantConception(gs: GameState, world: World, reg: DistantRegion, p: AbstractPop, pairing: ReproPairing, type: DevelopmentType, stepTick: number): boolean {
  let nest: Nest | null = null;
  if (type === "egg") {
    nest = popNestFor(gs, world, reg, p.speciesId);
    if (!nest) return false; // no room to lay — the pair does not conceive
  }
  gs.broodSeq += 1;
  const dev: ReproductiveDevelopment = {
    id: `d${gs.broodSeq.toString(36)}`,
    parentIds: [popOwnerId(reg), popOwnerId(reg)],
    speciesId: p.speciesId,
    pairing,
    type,
    state: "developing",
    startTick: stepTick,
    completeTick: stepTick + DEVELOPMENT_TICKS[type],
    nestId: nest?.id,
    origin: "wild",
    distant: true,
    dist: { layer: reg.layer, cx: reg.cx, cy: reg.cy },
    child: distantChild(gs, reg, p, pairing),
  };
  gs.developments[dev.id] = dev;
  if (nest) nest.developmentIds.push(dev.id);
  return true;
}

/**
 * A distant development completes: the population grows by one juvenile and
 * the child's genes join the aggregate — exactly what hatching a local egg
 * does for the live world, expressed at population level. No body is created
 * in a region nobody is visiting.
 */
export function foldDistantBirth(gs: GameState, dev: ReproductiveDevelopment): void {
  const dist = dev.dist;
  if (!dist) {
    dev.state = "failed";
    return;
  }
  const reg = ensureRegion(gs, dist.layer, dist.cx, dist.cy);
  const p = ensurePop(reg, dev.speciesId, gs.seed ^ hashString(reg.key + dev.speciesId));
  reg.abstracted = true;
  if (dev.child) {
    p.genes = blendGenes(p.genes, expressGenome(dev.child.genes), p.count);
    p.level = (p.level * p.count + dev.child.level) / (p.count + 1);
    p.lineageId ??= dev.child.lineageId;
  }
  if (p.count < POP_CAP) {
    p.count += 1;
    p.juveniles += 1;
    ecoOnBirth(gs, dev.speciesId, reg.cx * CHUNK + 8, reg.cy * CHUNK + 8, true);
  }
  dev.state = "completed";
}

/* ---------------------------- Abstract ecology ------------------------------- */

const pseudoCensus = (t: Territory, p: AbstractPop, predators: number, competitors: number, nests: number): TerritoryCensus => ({
  territory: t,
  bodies: [],
  adults: Math.max(0, p.count - p.juveniles),
  juveniles: p.juveniles,
  bySpecies: new Map([[p.speciesId, { adults: Math.max(0, p.count - p.juveniles), juveniles: p.juveniles }]]),
  predators,
  competitors,
  demand: (p.count - p.juveniles + p.juveniles * 0.65) * 0.75,
  nests,
});

/** Reuses the single predation rule (wildlife.ts) at species level via minimal stand-ins. */
const hunts = (pred: AbstractPop, prey: AbstractPop): boolean =>
  predatesOn({ speciesId: pred.speciesId, level: Math.round(pred.level), satiety: 100 } as unknown as WildCreature, {
    speciesId: prey.speciesId,
    alpha: false,
  } as unknown as WildCreature);

/**
 * Steps one abstract region forward through elapsed world time. Every decision
 * flows through the shared ecological formulas — carrying capacity, food per
 * capita, juvenile/adult mortality, migration pressure, the predation rule —
 * with hash-seeded deterministic rounding for aggregate fractions.
 */
export function stepRegion(gs: GameState, world: World, reg: DistantRegion, steps: number): void {
  const layer = reg.layer;
  const d = ensureDistant(gs);
  for (let s = 0; s < steps; s++) {
    const stepTick = reg.lastTick + (s + 1) * DISTANT_INTERVAL;
    const pseudoT: Territory = {
      id: `dreg:${reg.key}`,
      speciesId: reg.pops[0]?.speciesId ?? "slimekin",
      x: reg.cx * CHUNK + 8,
      y: reg.cy * CHUNK + 8,
      radius: 11,
      quality: 75,
      nestIds: [],
      createdAt: 0,
      layer,
    };
    let nests = 0;
    for (const n of Object.values(gs.nests)) {
      if ((n.layer ?? 0) !== layer) continue;
      if (Math.floor(n.x / CHUNK) !== reg.cx || Math.floor(n.y / CHUNK) !== reg.cy) continue;
      if (n.state === "active") nests++;
    }
    for (const p of [...reg.pops]) {
      const sp = SPECIES[p.speciesId];
      if (!sp) {
        reg.pops = reg.pops.filter((q) => q !== p);
        continue;
      }
      const adults = Math.max(0, p.count - p.juveniles);
      let predators = 0;
      let competitors = 0;
      let prey = 0;
      for (const o of reg.pops) {
        if (o === p) continue;
        const os = SPECIES[o.speciesId];
        if (!os) continue;
        if (hunts(p, o)) prey += o.count;
        if (hunts(o, p)) predators += Math.min(6, o.count);
        else competitors += Math.min(6, o.count);
      }
      let eco: TerritoryEcology;
      if (layer >= 0) {
        eco = assessTerritory(gs, world, pseudoT, pseudoCensus(pseudoT, p, predators, competitors, nests));
      } else {
        // caves: no surface forage — a fixed sparse baseline through the same decision shapes
        const cap = 4;
        const density = (p.count + p.juveniles * 0.5) / cap;
        const fpc = 1.2;
        eco = {
          capacity: cap,
          density,
          foodPerCapita: fpc,
          predatorPressure: Math.min(1.5, predators * 0.18),
          nestAvailability: 1,
          suitability: 0.9,
          migrationPressure: clamp(0.5 * Math.max(0, density - 1) + 0.4 * Math.max(0, 1 - fpc), 0, 1),
        } as TerritoryEcology;
      }
      // predator condition rides on prey availability, not forage alone
      const foodPerCapita = prey > 0 ? Math.max(eco.foodPerCapita, Math.min(1.5, prey / Math.max(1, p.count))) : eco.foodPerCapita;
      // ---- deaths: juvenile survival, adult scarcity/crowding, predation ----
      const nestSecure = nests > 0 || developmentTypeFor(p.speciesId, "sexual") !== "egg";
      const juvRate = juvenileMortalityChance(eco, nestSecure);
      let juvDeaths = Math.floor(p.juveniles * juvRate);
      if (hash01(gs.seed ^ p.seed, stepTick, 0xd81) < p.juveniles * juvRate - juvDeaths) juvDeaths++;
      const adRate = adultMortalityChance(eco);
      let adDeaths = Math.floor(adults * adRate);
      if (hash01(gs.seed ^ p.seed, stepTick, 0xd82) < adults * adRate - adDeaths) adDeaths++;
      const remain = Math.max(0, p.count - juvDeaths - adDeaths);
      const predRate = eco.predatorPressure * DISTANT_PREDATION;
      let kills = Math.floor(remain * predRate);
      if (hash01(gs.seed ^ p.seed, stepTick, 0xd83) < remain * predRate - kills) kills++;
      let deaths = Math.min(p.count, juvDeaths + adDeaths + kills);
      if (deaths > 0) {
        const jPart = Math.min(p.juveniles, deaths);
        p.juveniles -= jPart;
        p.count -= deaths;
        for (let i = 0; i < deaths; i++) ecoOnDeath(gs, p.speciesId, pseudoT.x, pseudoT.y, i < jPart);
      }
      // ---- conceptions: one shared birth path — a reproductive development record ----
      // (an egg laid in a persistent nest, or live gestation) that grows the
      // population only when it completes. Reproductive mode, sex ratio and the
      // chunk's nesting provision all decide whether a distant pair conceives.
      const pairing: ReproPairing = sp.sexed === false ? "asexual" : "sexual";
      const devType = developmentTypeFor(p.speciesId, pairing);
      const nowAdults = Math.max(0, p.count - p.juveniles);
      const femaleShare = 0.45 + 0.1 * hash01(gs.seed ^ p.seed, stepTick, 0xd86);
      // asexual populations bud from any adult; sexed ones need a pair — a
      // fertile female (about half the adults) and at least one adult beside her
      const fertile = pairing === "asexual" ? nowAdults : nowAdults >= 2 ? Math.floor(nowAdults * femaleShare) : 0;
      let chance =
        DISTANT_BIRTH_RATE *
        Math.min(1, Math.max(0, foodPerCapita)) *
        Math.max(0, 1 - 0.5 * Math.max(0, eco.density - 0.8)) *
        eco.nestAvailability *
        eco.suitability;
      if (sp.diet === "carnivore" && prey > 0) chance = Math.max(chance, DISTANT_BIRTH_RATE * Math.min(1.2, 0.4 + prey / Math.max(1, p.count)));
      chance = clamp(chance, 0, 0.2);
      const expected = fertile * chance;
      let conceptions = Math.floor(expected);
      if (hash01(gs.seed ^ p.seed, stepTick, 0xd80) < expected - conceptions) conceptions++;
      for (let i = 0; i < conceptions; i++) distantConception(gs, world, reg, p, pairing, devType, stepTick);
      // ---- condition drift toward what the land provides ----
      p.satiety = clamp(p.satiety + (Math.min(1.5, foodPerCapita) - 0.9) * 12, 0, 100);
      // ---- migration: dispersal into an adjacent chunk under the same pressure rule ----
      if (eco.migrationPressure >= MIGRATION_PRESSURE && p.count > 3 && Object.keys(d).length < REGION_CAP) {
        const movers = Math.min(p.count - 1, Math.max(1, Math.ceil(p.count * MIGRATION_FRACTION)));
        const dir = DIRS[Math.floor(hash01(gs.seed ^ p.seed, stepTick, 0xd84) * DIRS.length)];
        const ncx = reg.cx + dir[0];
        const ncy = reg.cy + dir[1];
        if (inWorldChunk(ncx, ncy)) {
          const target = ensureRegion(gs, reg.layer, ncx, ncy);
          const tp = ensurePop(target, p.speciesId, gs.seed ^ hashString(target.key + p.speciesId));
          const wasEmpty = tp.count === 0;
          const jm = p.count > 0 ? Math.min(p.juveniles, Math.round(movers * (p.juveniles / p.count))) : 0;
          tp.count += movers;
          tp.juveniles += jm;
          if (wasEmpty) {
            tp.genes = { ...p.genes };
            tp.satiety = p.satiety;
            tp.level = p.level;
            tp.lineageId = p.lineageId;
          }
          target.abstracted = true;
          p.count -= movers;
          p.juveniles = Math.max(0, p.juveniles - jm);
        }
      }
      // ---- safety clamps (never negative, never runaway) ----
      p.count = clamp(Math.round(p.count), 0, POP_CAP);
      p.juveniles = clamp(Math.round(p.juveniles), 0, p.count);
    }
    reg.pops = reg.pops.filter((p) => p.count > 0);
  }
  reg.lastTick += steps * DISTANT_INTERVAL;
  // regions that died out release the chunk back to the world's natural recolonization
  if (!reg.pops.length) delete ensureDistant(gs)[reg.key];
}

/* ----------------------------- Materialization ------------------------------- */

/**
 * Open ground beside one of the region's persistent nests — where its young would be.
 */
function spotNearNest(gs: GameState, world: World, layer: number, nests: Nest[], fp: number): { x: number; y: number } | null {
  for (const nest of nests) {
    for (let r = 0; r <= 2; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = nest.x + dx;
          const y = nest.y + dy;
          if (gs.player.x === x && gs.player.y === y) continue;
          if (creatureAt(gs, x, y) || partyMonAt(gs, x, y)) continue;
          if (!fitsFootprint(gs, world, x, y, fp, layer)) continue;
          return { x, y };
        }
      }
    }
  }
  return null;
}

function findSpot(gs: GameState, world: World, layer: number, reg: DistantRegion, speciesId: string, attempt: number, seed: number): { x: number; y: number } | null {
  const rng = new Rng(seed ^ hashString(speciesId) ^ (attempt * 0x9e37));
  const fp = footprintOf(SPECIES[speciesId]);
  for (let k = 0; k < 24; k++) {
    const x = reg.cx * CHUNK + Math.floor(rng.next() * CHUNK);
    const y = reg.cy * CHUNK + Math.floor(rng.next() * CHUNK);
    if (!world.inBounds(x, y)) continue;
    if (gs.player.x === x && gs.player.y === y) continue;
    if (layer >= 0) {
      const t = world.tile(x, y);
      if (!BIOMES[t.biome].passable || t.feature || world.siteAt(x, y)?.wall) continue;
    } else if (layer === UW ? !heightOf(world).uwOpen(x, y) : !heightOf(world).caveOpen(layer, x, y)) continue;
    if (creatureAt(gs, x, y) || partyMonAt(gs, x, y)) continue;
    if (!fitsFootprint(gs, world, x, y, fp, layer)) continue;
    return { x, y };
  }
  return null;
}

/**
 * Converts a chunk's abstract populations into individual bodies (bounded by
 * MAT_CAP_*), reconciling against the population's current count. Returns true
 * when the chunk is under population management (generic spawn suppressed).
 * Young are placed beside the region's persistent nests — a revisited region
 * materializes around the nurseries its populations built.
 */
export function materializeDistantChunk(gs: GameState, world: World, cx: number, cy: number): boolean {
  const layer = layerOf(gs);
  const reg = gs.distant?.[distantKey(layer, cx, cy)];
  if (!reg) return false;
  if (!reg.abstracted || !reg.pops.length) {
    // extinct or never-visited: the chunk returns to natural recolonization
    if (!reg.pops.length) delete gs.distant[reg.key];
    return false;
  }
  // spawn capacity counts live local bodies — chronicled monsters persist beyond it
  if (activeBodyCount(gs) >= CREATURE_CAP) return true;
  const nestsHere = Object.values(gs.nests).filter(
    (n) => n.state === "active" && (n.layer ?? 0) === layer && Math.floor(n.x / CHUNK) === cx && Math.floor(n.y / CHUNK) === cy,
  );
  let total = 0;
  for (const p of [...reg.pops]) {
    if (!SPECIES[p.speciesId]) {
      reg.pops = reg.pops.filter((q) => q !== p);
      continue;
    }
    let n = Math.min(p.count, MAT_CAP_SPECIES, MAT_CAP_REGION - total);
    if (n <= 0) continue;
    const jn = Math.min(p.juveniles, Math.round(n * (p.count > 0 ? p.juveniles / p.count : 0)));
    let made = 0;
    for (let i = 0; i < n; i++) {
      const juvenile = i < jn;
      const spot =
        (juvenile ? spotNearNest(gs, world, layer, nestsHere, footprintOf(SPECIES[p.speciesId])) : null) ??
        findSpot(gs, world, layer, reg, p.speciesId, i, p.seed ^ hashString(reg.key));
      if (!spot) break;
      // returning residents place by terrain/collision only — the ecological
      // immigrant gate stays on generic spawning; density feedback still shapes
      // the abstract population between visits
      const id = `w:${cx}:${cy}:${p.speciesId}:${i}`;
      if (gs.creatures[id]) continue;
      const rng = new Rng(p.seed ^ hashString(reg.key + p.speciesId) ^ (0x51d + i));
      // population mean genes → individual genome with the usual drift (continuity, not reset)
      const genome = genomeFromGenes(p.genes, p.speciesId, rng);
      const meanSize = clamp(Math.round(p.genes.size ?? 40), ALLELE_MIN, ALLELE_MAX);
      genome.size = { a: meanSize, b: meanSize };
      const h = hash3(gs.seed ^ 0xd157, cx, cy, i + hashString(p.speciesId));
      const body = makeCreature(id, p.speciesId, spot.x, spot.y, juvenile ? Math.max(1, Math.round(p.level) - 2) : clamp(Math.round(p.level), 1, 50), h, false);
      body.genes = driftGenome(genome, rng);
      body.satiety = Math.round(clamp(p.satiety, 0, 100));
      if (p.lineageId) {
        body.lineageId = p.lineageId;
        body.gen = 2;
      }
      if (juvenile) body.bornTick = gs.tick - (NEWBORN_TICKS + JUVENILE_TICKS / 2);
      gs.creatures[id] = body;
      ensureTerritory(gs, body);
      made++;
      total++;
      if (juvenile) p.juveniles = Math.max(0, p.juveniles - 1);
    }
    p.count -= made;
  }
  reg.pops = reg.pops.filter((p) => p.count > 0);
  if (!reg.pops.length) delete gs.distant[reg.key];
  return true;
}

/* --------------------------- Elapsed-time processing -------------------------- */

/**
 * Advances due distant regions with bounded work: the oldest `DISTANT_BUDGET`
 * regions per tick, each stepping whole days with a hard catch-up cap. The
 * remainder of a very long absence folds once — never dropped silently, never
 * applied twice.
 */
export function advanceDistantEcosystem(gs: GameState, world: World): void {
  const d = gs.distant;
  if (!d) return;
  const due: DistantRegion[] = [];
  for (const key in d) {
    const r = d[key];
    if (r && gs.tick - r.lastTick >= DISTANT_INTERVAL) due.push(r);
  }
  if (!due.length) return;
  due.sort((a, b) => a.lastTick - b.lastTick);
  for (const reg of due.slice(0, DISTANT_BUDGET)) {
    const steps = Math.min(Math.floor((gs.tick - reg.lastTick) / DISTANT_INTERVAL), MAX_CATCHUP_STEPS);
    if (steps <= 0) continue;
    // stepRegion advances reg.lastTick itself — do not advance it again here
    stepRegion(gs, world, reg, steps);
    // a region whose clock fell far behind resumes from now instead of
    // replaying ancient intervals forever
    if (gs.tick - reg.lastTick >= DISTANT_INTERVAL) reg.lastTick = gs.tick;
  }
}

/* -------------------------------- Migration ---------------------------------- */

/** Backfills and sanitizes abstract-population state for older saves — idempotent, runs on every load. */
export function migrateDistant(gs: GameState): void {
  if (!gs.distant || typeof gs.distant !== "object") gs.distant = {};
  const d = gs.distant;
  for (const key of Object.keys(d)) {
    const r = d[key];
    if (!r || typeof r.key !== "string" || !Number.isFinite(r.lastTick) || !Array.isArray(r.pops)) {
      delete d[key];
      continue;
    }
    r.layer ??= 0;
    r.cx ??= 0;
    r.cy ??= 0;
    r.abstracted ??= true;
    if (r.lastTick > gs.tick) r.lastTick = gs.tick;
    r.pops = r.pops
      .filter((p): p is AbstractPop => !!p && typeof p.speciesId === "string" && Number.isFinite(p.count) && p.count > 0)
      .map((p) => {
        const genes = {} as Genes;
        for (const k of GENE_KEYS) genes[k] = clamp(Math.round(p.genes?.[k] ?? 40), ALLELE_MIN, ALLELE_MAX);
        const count = clamp(Math.round(p.count), 1, POP_CAP);
        return {
          speciesId: p.speciesId,
          count,
          juveniles: clamp(Math.round(p.juveniles ?? 0), 0, count),
          genes,
          satiety: clamp(p.satiety ?? 60, 0, 100),
          level: clamp(p.level ?? 5, 1, 50),
          lineageId: typeof p.lineageId === "string" ? p.lineageId : null,
          seed: Number.isFinite(p.seed) ? p.seed : hashString(key + p.speciesId),
        };
      });
    if (!r.pops.length) delete d[key];
  }
}
