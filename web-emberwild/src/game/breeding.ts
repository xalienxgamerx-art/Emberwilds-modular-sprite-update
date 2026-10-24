/**
 * The unified breeding pipeline — the one authoritative path from two parents
 * to a developing offspring.
 *
 * Validation (mating rules) → genetic inheritance → mutation → species
 * determination → trait/personality inheritance → lineage → a persistent
 * ReproductiveDevelopment record (an egg in a nest, or live gestation). The
 * offspring entity is created only when development completes. Wild and player
 * breeding share every step; only the permission context differs.
 */
import { PARTY_MAX, PEN_MAX, PERSONALITIES, RECIPES, SPECIES, developmentTypeFor } from "./data";
import { childLineage, driftGenome, inheritGenome, mutationRecords } from "./genetics";
import { addLog, compass } from "./log";
import { canMate } from "./mating";
import type { MatingFailureReason } from "./mating";
import { BAD_MUTS, GOOD_MUTS, createMonster, displayName, skillsForLevel } from "./monster";
import { beginReproduction, bodyId, makeReproProfile, rollReproMode } from "./reproduction";
import { inheritSignature } from "./signature";
import { foldDistantBirth } from "./distant";
import { attachNest } from "./territory";
import { SURFACE, layerOf, walkable } from "./height";
import { ecoOnBirth } from "./ecology";
import { recordLineageBirth } from "./lineage";
import { Rng, hashString } from "./rng";
import type {
  ChildBlueprint,
  DevelopmentType,
  GameState,
  Genome,
  MatingContext,
  Monster,
  MutationId,
  Nest,
  PersonalityId,
  ReproductiveDevelopment,
  ReproPairing,
  Sex,
  WildCreature,
} from "./types";
import { getWorld } from "./world";

/* ------------------------------- Configuration ------------------------------- */

/** Ticks an egg needs to hatch (two in-world days). */
export const EGG_TICKS = 576;
/** Ticks of gestation before a live birth (one in-world day). */
export const GESTATION_TICKS = 288;
/** Development duration per reproductive strategy. */
export const DEVELOPMENT_TICKS: Record<DevelopmentType, number> = { egg: EGG_TICKS, gestation: GESTATION_TICKS };
/** How many developing offspring one nest can hold at once. */
export const NEST_CAPACITY = 3;

/* --------------------------------- Parents ----------------------------------- */

/** Any living body that can become a parent. */
type Parent = Monster | WildCreature;

const mutsOf = (m: Parent): MutationId[] => ("mutations" in m ? m.mutations : []);
const skillsOf = (m: Parent): string[] => ("skills" in m ? m.skills : []);
const plusOf = (m: Parent): number => ("plus" in m ? m.plus : 0);
const bondOf = (m: Parent): number => ("bond" in m ? m.bond : 20);
const genOfBody = (m: Parent): number => {
  // Monster.generation and WildCreature.gen are both optional-compatible fields for the same concept
  const g = m as { generation?: number; gen?: number };
  return g.generation ?? g.gen ?? 1;
};
const nameOf = (m: Parent): string => ("nickname" in m ? displayName(m) : SPECIES[m.speciesId].name);

const PERSONALITY_IDS = Object.keys(PERSONALITIES) as PersonalityId[];

/* --------------------------- Species determination ---------------------------- */

/**
 * Offspring species: recipe outcomes first, else the shared-family parent with
 * the higher level, else the stronger parent. Moved here from the legacy
 * synthesis so wild and player breeding determine species identically.
 */
export function offspringSpecies(a: Parent, b: Parent): string {
  for (const [x, y, r] of RECIPES) {
    if ((a.speciesId === x && b.speciesId === y) || (a.speciesId === y && b.speciesId === x)) return r;
  }
  return SPECIES[a.speciesId].family === SPECIES[b.speciesId].family || a.level >= b.level ? a.speciesId : b.speciesId;
}

/* ----------------------------- Genetic assembly ------------------------------- */

/**
 * Assembles the child blueprint: Mendelian inheritance from both parents'
 * genotypes (one allele per parent per gene), symmetric bidirectional drift
 * (mutation can raise or lower, clamped to the legal range), mutation and
 * skill inheritance, personality inheritance, species determination and
 * lineage recording. Deterministic given the rng.
 */
export function planChild(a: Parent, b: Parent, rng: Rng): ChildBlueprint {
  const speciesId = offspringSpecies(a, b);
  const genes0 = inheritGenome(a.genes, b.genes, rng);
  const genes = driftGenome(genes0, rng);
  const muts: MutationId[] = [];
  for (const m of [...mutsOf(a), ...mutsOf(b)]) if (rng.chance(0.45) && !muts.includes(m)) muts.push(m);
  const mutationChance = 0.2 + (mutsOf(a).length + mutsOf(b).length) * 0.1;
  if (rng.chance(mutationChance)) {
    const m = rng.chance(0.2) ? rng.pick(BAD_MUTS) : rng.pick(GOOD_MUTS);
    if (!muts.includes(m)) muts.push(m);
  }
  const personality = rng.chance(0.5) ? a.personality : rng.chance(0.7) ? b.personality : rng.pick(PERSONALITY_IDS);
  const own = new Set(skillsForLevel(speciesId, 1));
  const inherited = Array.from(new Set([...skillsOf(a), ...skillsOf(b)].filter((s) => !own.has(s)))).slice(0, 2);
  const generation = Math.max(genOfBody(a), genOfBody(b)) + 1;
  // signature inheritance: a parent's evolving technique may pass down as a
  // normal move (never the child's active signature)
  const inheritedSig = inheritSignature([a.sig, b.sig], 1, rng);
  return {
    speciesId,
    sex: rollReproMode(rng, speciesId),
    level: 1,
    genes,
    mutations: muts.slice(0, 3),
    personality,
    skills: [...skillsForLevel(speciesId, 1), ...inherited],
    plus: Math.min(99, Math.floor((plusOf(a) + plusOf(b)) / 2) + 1 + Math.floor((a.level + b.level) / 20)),
    bond: Math.round((bondOf(a) + bondOf(b)) / 2),
    generation,
    lineageId: childLineage([{ uid: bodyId(a), lineageId: a.lineageId }, { uid: bodyId(b), lineageId: b.lineageId }]),
    mutHistory: mutationRecords(genes0, genes, generation),
    parents: [bodyId(a), bodyId(b)],
    parentNames: [nameOf(a), nameOf(b)],
    ...(inheritedSig ? { sigKnown: [inheritedSig] } : {}),
  };
}

/** Shrine preview: the deterministic pre-drift inheritance the breeding pipeline will perform. */
export interface BreedingPreview {
  speciesId: string;
  plus: number;
  genes: Genome;
  inherited: string[];
  mutationChance: number;
  sex: Sex;
}

export function previewBreeding(a: Parent, b: Parent): BreedingPreview {
  const speciesId = offspringSpecies(a, b);
  const plus = Math.min(99, Math.floor((plusOf(a) + plusOf(b)) / 2) + 1 + Math.floor((a.level + b.level) / 20));
  const rng = new Rng(hashString(bodyId(a)) ^ hashString(bodyId(b)) ^ 0x2e55);
  const genes = inheritGenome(a.genes, b.genes, rng);
  const sex = rollReproMode(rng, speciesId);
  const own = new Set(skillsForLevel(speciesId, 1));
  const inherited = Array.from(new Set([...skillsOf(a), ...skillsOf(b)].filter((s) => !own.has(s)))).slice(0, 2);
  return { speciesId, plus, genes, inherited, mutationChance: 0.2 + (mutsOf(a).length + mutsOf(b).length) * 0.1, sex };
}

/* ---------------------------------- Nests ------------------------------------- */

/** Creates a persistent nest for a female. */
export function createNest(state: GameState, ownerId: string, speciesId: string, x: number, y: number): Nest {
  state.broodSeq += 1;
  const nest: Nest = {
    id: `n${state.broodSeq.toString(36)}`,
    speciesId,
    ownerId,
    x,
    y,
    state: "active",
    createdAt: state.tick,
    lastUsedTick: state.tick,
    developmentIds: [],
  };
  // nests are built on whatever layer the brood is happening on (caves included)
  const layer = layerOf(state);
  if (layer !== SURFACE) nest.layer = layer;
  state.nests[nest.id] = nest;
  return nest;
}

/** The body behind a body id, if it still lives anywhere in the state. */
function findBody(state: GameState, id: string): Parent | null {
  return [...state.party, ...state.pen, ...Object.values(state.creatures)].find((b) => bodyId(b) === id) ?? null;
}

/** A body's live map position: wild creatures carry their own; party monsters stand via the field. */
function bodyPos(state: GameState, m: Parent): { x: number; y: number } {
  if ("homeX" in m) return { x: m.x, y: m.y };
  const f = state.field[m.uid];
  return f ? { x: f.x, y: f.y } : { x: state.player.x, y: state.player.y };
}

/** Whether a nest is usable by its owner: active, hers, her species, with room. */
const nestUsable = (nest: Nest, ownerId: string, speciesId: string): boolean =>
  nest.state === "active" && nest.ownerId === ownerId && nest.speciesId === speciesId && nest.developmentIds.length < NEST_CAPACITY;

/**
 * Reuses the female's remembered nest when valid, else builds a new one.
 * Females never accumulate duplicate nests just because they breed often.
 */
export function nestFor(state: GameState, female: Parent, speciesId: string, at: { x: number; y: number }): Nest {
  const ownerId = bodyId(female);
  const remembered = female.repro?.nestId ? state.nests[female.repro.nestId] : null;
  if (remembered && nestUsable(remembered, ownerId, speciesId)) {
    remembered.lastUsedTick = state.tick;
    return remembered;
  }
  if (female.repro) female.repro.nestId = undefined;
  const nest = createNest(state, ownerId, speciesId, at.x, at.y);
  if (female.repro) female.repro.nestId = nest.id;
  return nest;
}

/**
 * Destroys a nest. Developments inside are interrupted — the simplest loss
 * rule; species-specific outcomes (rescue, fledge elsewhere) extend here. All
 * references are cleaned so nothing dangles.
 */
export function destroyNest(state: GameState, nestId: string): void {
  const nest = state.nests[nestId];
  if (!nest || nest.state === "destroyed") return;
  nest.state = "destroyed";
  for (const devId of nest.developmentIds) {
    const dev = state.developments[devId];
    if (dev && dev.state === "developing") {
      dev.state = "interrupted";
      dev.nestId = undefined;
    }
  }
  nest.developmentIds = [];
  const owner = findBody(state, nest.ownerId);
  if (owner?.repro?.nestId === nestId) owner.repro.nestId = undefined;
}

/**
 * The nest's owner was defeated: her nests become abandoned — a state
 * transition later ecology (raiding, rescue, adoption) can act on. The nest is
 * NOT destroyed and eggs inside keep developing.
 */
export function abandonNestsOf(state: GameState, ownerId: string): void {
  for (const nest of Object.values(state.nests)) {
    if (nest.ownerId === ownerId && nest.state === "active") nest.state = "abandoned";
  }
}

/* -------------------------------- Breeding ------------------------------------ */

export type BreedingOutcome =
  | { ok: true; development: ReproductiveDevelopment; nest: Nest | null }
  | { ok: false; reason: MatingFailureReason; detail?: string };

/**
 * The breeding pipeline. Validates through the mating rules, assembles the
 * child blueprint from both parents' genotypes, then creates the persistent
 * reproductive-development record (and reuses or builds a nest for egg-layers).
 * No offspring entity is created here — it arrives when development completes.
 */
export function beginBreeding(state: GameState, a: Parent, b: Parent, context: MatingContext): BreedingOutcome {
  const mating = canMate(a, b, context, state.tick);
  if (!mating.ok) return { ok: false, reason: mating.reason ?? "biological_incompatibility", detail: mating.detail };
  const rng = new Rng(state.seed ^ state.tick ^ state.uidSeq * 7919);
  const child = planChild(a, b, rng);
  // the pair-seeded draw decides the child's sex, keeping the shrine preview truthful
  child.sex = previewBreeding(a, b).sex;
  const pairing: ReproPairing = a.repro?.mode === "asexual" ? "asexual" : "sexual";
  const type = developmentTypeFor(child.speciesId, pairing);
  child.level = context === "wild" ? Math.max(1, Math.min(a.level, b.level) - 2) : 1;
  let nest: Nest | null = null;
  if (type === "egg") {
    const layer = a.repro?.mode === "female" ? a : b;
    nest = nestFor(state, layer, child.speciesId, bodyPos(state, layer));
    attachNest(state, nest, bodyId(layer));
  }
  state.broodSeq += 1;
  const dev: ReproductiveDevelopment = {
    id: `d${state.broodSeq.toString(36)}`,
    parentIds: child.parents,
    speciesId: child.speciesId,
    pairing,
    type,
    state: "developing",
    startTick: state.tick,
    completeTick: state.tick + DEVELOPMENT_TICKS[type],
    nestId: nest?.id,
    origin: context,
    child,
  };
  state.developments[dev.id] = dev;
  if (nest) nest.developmentIds.push(dev.id);
  beginReproduction(a, b, state.tick, DEVELOPMENT_TICKS[type]);
  return { ok: true, development: dev, nest };
}

/* --------------------------- Development & birth ------------------------------ */

/** Free tile for a hatching, scanning out from the given position. */
export function freeTileNear(state: GameState, x: number, y: number, layer: number = layerOf(state)): { x: number; y: number } | null {
  const world = getWorld(state.seed);
  for (let r = 0; r <= 2; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = x + dx;
        const ty = y + dy;
        if (layer < SURFACE) {
          if (!walkable(world, layer, tx, ty)) continue;
        } else if (!world.inBounds(tx, ty) || !world.passable(tx, ty) || world.siteAt(tx, ty)?.wall) continue;
        const occupied =
          (state.player.x === tx && state.player.y === ty) ||
          Object.values(state.creatures).some((c) => c.x === tx && c.y === ty) ||
          Object.values(state.field).some((p) => p.x === tx && p.y === ty);
        if (occupied) continue;
        return { x: tx, y: ty };
      }
    }
  }
  return null;
}

/** Where a development delivers when its nest is gone: a living parent's side. */
function parentPosition(state: GameState, parentIds: string[]): { x: number; y: number } | null {
  for (const id of parentIds) {
    const body = findBody(state, id);
    if (body) return bodyPos(state, body);
  }
  return null;
}

/**
 * The one player-side birth path: a completed blueprint becomes a newborn
 * monster in the party (or the pen when the party is full). Returns false
 * while the brood has no room — the caller retries every tick, and a carried
 * egg simply keeps waiting in its shell. Kept stolen eggs hatch through this
 * exact path, so they become exactly the same kind of companion as bred babies.
 */
export function deliverPlayerOffspring(state: GameState, dev: ReproductiveDevelopment): boolean {
  const child = dev.child;
  if (!child) {
    dev.state = "failed";
    return true;
  }
  const mon = createMonster(state, child.speciesId, child.level, {
    genes: child.genes,
    personality: child.personality,
    mutations: child.mutations,
    origin: "Bred",
    seed: (hashString(dev.id) ^ state.seed) >>> 0,
    parents: [...child.parents],
    parentNames: [...child.parentNames],
    plus: child.plus,
    sex: child.sex,
    skills: child.skills,
    generation: child.generation,
    lineageId: child.lineageId,
    mutHistory: child.mutHistory,
    stage: "newborn",
    ...(child.sigKnown ? { sigKnown: child.sigKnown } : {}),
  });
  mon.bond = child.bond;
  if (state.party.length < PARTY_MAX) state.party.push(mon);
  else if (state.pen.length < PEN_MAX) state.pen.push(mon);
  else {
    dev.state = "ready"; // brood waiting for room; delivery retries every tick
    return false;
  }
  state.seen[child.speciesId] = true;
  state.tamed[child.speciesId] = true;
  dev.state = "completed";
  dev.resultId = mon.uid;
  ecoOnBirth(state, child.speciesId, state.player.x, state.player.y, true);
  recordLineageBirth(state, mon, [...(child.parents ?? [])]);
  addLog(
    state,
    dev.type === "egg"
      ? `An egg has hatched! A young ${SPECIES[child.speciesId].name} emerges, blinking.`
      : `A new ${SPECIES[child.speciesId].name} has been born!`,
    "good",
  );
  return true;
}

/** Creates the offspring entity once a development completes. */
function deliverOffspring(state: GameState, dev: ReproductiveDevelopment): void {
  // distant conceptions complete into their abstract population — one shared
  // birth path; the aggregate grows exactly when a local egg would hatch
  if (dev.distant) {
    foldDistantBirth(state, dev);
    return;
  }
  const child = dev.child;
  if (!child) {
    dev.state = "failed";
    return;
  }
  if (dev.origin === "player") {
    deliverPlayerOffspring(state, dev);
    return;
  }
  // wild: hatch at the nest (or at a living parent's side if the nest was lost)
  const nest = dev.nestId ? state.nests[dev.nestId] : null;
  const at = nest && nest.state !== "destroyed" ? { x: nest.x, y: nest.y } : parentPosition(state, dev.parentIds);
  if (!at) {
    dev.state = "failed";
    return;
  }
  const hatchLayer = nest && nest.state !== "destroyed" ? nest.layer ?? SURFACE : layerOf(state);
  const spot = freeTileNear(state, at.x, at.y, hatchLayer);
  if (!spot) return; // no room right now — development holds, retried next tick
  const rng = new Rng(hashString(dev.id) ^ 0x4242);
  const id = `b:${state.tick}:${(hashString(dev.id) >>> 0).toString(36)}`;
  // a hatchling is born into the ecological fabric: the nest's territory, else a parent's
  const homeTerritoryId =
    nest?.territoryId ?? dev.parentIds.map((pid) => state.creatures[pid]).find((b) => b?.territoryId)?.territoryId;
  const baby: WildCreature = {
    id,
    speciesId: child.speciesId,
    level: child.level,
    x: spot.x,
    y: spot.y,
    homeX: at.x,
    homeY: at.y,
    hpFrac: 1,
    satiety: Math.round(40 + rng.next() * 55),
    disposition: rng.chance(0.6) ? "curious" : "skittish",
    activity: "Wandering",
    personality: child.personality,
    geneSeed: hashString(dev.id) % 2_000_000_000,
    genes: child.genes,
    gen: child.generation,
    lineageId: child.lineageId,
    territoryId: homeTerritoryId,
    bornTick: state.tick,
    parents: [...child.parents],
    mutHistory: child.mutHistory,
    ...(hatchLayer !== SURFACE ? { layer: hatchLayer } : {}),
    repro: makeReproProfile(child.sex, child.level, state.tick),
    ...(child.sigKnown ? { sigKnown: child.sigKnown } : {}),
    calmUntil: 0,
    alpha: false,
    affection: 0,
    stalking: false,
  };
  state.creatures[id] = baby;
  dev.state = "completed";
  dev.resultId = id;
  ecoOnBirth(state, child.speciesId, spot.x, spot.y, true);
  recordLineageBirth(state, baby, child.parents ?? []);
  const px = state.player.x;
  const py = state.player.y;
  if (Math.max(Math.abs(at.x - px), Math.abs(at.y - py)) <= 12) {
    addLog(
      state,
      dev.type === "egg"
        ? `A tiny ${SPECIES[child.speciesId].name} hatches from its nest ${compass(at.x - px, at.y - py)}.`
        : `A tiny ${SPECIES[child.speciesId].name} is born ${compass(at.x - px, at.y - py)}.`,
      "good",
    );
  }
}

/**
 * Reconciles reproductive development with simulation time: eggs hatch and
 * gestations birth at their completion tick; broods waiting for room retry.
 */
export function advanceDevelopment(state: GameState): void {
  for (const dev of Object.values(state.developments)) {
    if (dev.state === "ready" || (dev.state === "developing" && state.tick >= dev.completeTick)) {
      deliverOffspring(state, dev);
    }
  }
}

/* -------------------------------- Migration ----------------------------------- */

/** Backfills nests/developments for older saves and clears dangling references. Idempotent, runs on every load. */
export function migrateBreeding(gs: GameState): void {
  gs.nests = gs.nests ?? {};
  gs.developments = gs.developments ?? {};
  gs.broodSeq = gs.broodSeq ?? 0;
  const nestOk = (nestId: string | undefined, ownerId: string): boolean =>
    !!nestId && gs.nests[nestId]?.state === "active" && gs.nests[nestId].ownerId === ownerId;
  const popOwned = (ownerId: string): boolean => ownerId.startsWith("pop:");
  for (const nest of Object.values(gs.nests)) {
    // abandonment is a lifecycle event: a nest loses its owner only when the
    // owner's body is truly gone. Nests tended by an abstract population, and
    // the persistent bodies of far-away regions, keep theirs.
    if (nest.state === "active" && !popOwned(nest.ownerId) && !findBody(gs, nest.ownerId)) nest.state = "abandoned";
    nest.developmentIds = nest.developmentIds.filter((id) => {
      const d = gs.developments[id];
      return !!d && (d.state === "developing" || d.state === "ready");
    });
  }
  for (const dev of Object.values(gs.developments)) {
    if (dev.nestId && dev.state === "developing" && !gs.nests[dev.nestId]) dev.nestId = undefined;
    if (dev.distant && (!dev.dist || !Number.isFinite(dev.dist.cx) || !Number.isFinite(dev.dist.cy))) dev.state = "failed";
  }
  for (const m of [...gs.party, ...gs.pen]) {
    if (m.repro?.nestId && !nestOk(m.repro.nestId, m.uid)) m.repro.nestId = undefined;
  }
  for (const c of Object.values(gs.creatures)) {
    if (c.repro?.nestId && !nestOk(c.repro.nestId, c.id)) c.repro.nestId = undefined;
  }
}
