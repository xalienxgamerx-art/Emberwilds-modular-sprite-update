import { BIOMES, DAY_TICKS, ITEMS, footprintOf, ORIGINS, PARTY_MAX, PEN_MAX, PERSONALITIES, SHOP_STOCK, SPECIES, STATUSES, WORLD_SIZE } from "./data";
import { abandonNestsOf, advanceDevelopment, beginBreeding, freeTileNear, type BreedingOutcome } from "./breeding";
import { advanceEggs, takeEggIntoPack } from "./eggs";
import { expressGene, founderLineage, rollGenome, wildGenotypeFromSeed } from "./genetics";
import { bodyFootprint } from "./growth";
import {
  CREATURE_CAP, ECOLOGY_INTERVAL, allowsBreeding, assessTerritory, buildCensus, ecoOnCreatureDeath, ecologyTick, spawnAllowedByEcology, type TerritoryEcology,
} from "./ecology";
import {
  CALL_CHANCE, CALL_COOLDOWN, FOLLOW_DIST, MATE_SATIETY, PARENT_LEASH,
  emitMatingCall, guardianOf, migrationIntent, perceiveWildlife, predatesOn, profileOf,
  seizeTerritory, seekMateTarget, settleMigration,
} from "./wildlife";
import { isDependent, stageOf } from "./growth";
import { resolveLook, type TamerLook } from "./appearance";
import { isSettlement } from "./settlement";
import { advanceTamers, initTamers, tamerProximity } from "./tamers";
import { advanceRumors, recordEvent, setKey, nearestSettlement } from "./rumors";
import { emptyRep } from "./reputation";
import { tamerCombatTurn } from "./combat";
import { abstractDroppedCreature, advanceDistantEcosystem, isPopOwnedNest, materializeDistantChunk } from "./distant";
import { carrionNear, CARRION_SIGHT, dressCarrionAt, eatCarrion, nearestCarrion, rotTick, SCAVENGE_FOOD, spawnCarrion } from "./carrion";
import { engage, groundTick, initField, isHostile, partyCombatTurn, partyMonAt, regroupParty, trackHint, wildCombatTurn } from "./combat";
import {
  CAVE_DENSITY, CAVE_FAUNA, CAVE_LEVEL_BONUS, CAVE_UPPER, CLIMB_AVOID, FALL_TIME, HEAVY_CLIMB_AVOID, LAYER_DENSITY, MOUTH_BURROWERS, MOUTH_BURROWER_CHANCE,
  PLAYER_MOVER, SKY, SURFACE, UW, UW_FAUNA, bodyLevelOk, climbCost, fallDamage, fallLevels, heightLOS, heightOf, layerOf, moverOf, pickWeighted, sameLayer,
  stepRule, tileCost, walkable,
} from "./height";
import { objectAt, OBJ_NAME } from "./objects";
import { getFactions } from "./factions";
import { discoverFeature, emptyKnowledge, ensureKnowledge, markRoute, updateKnowledge } from "./knowledge";
import { addLog, compass } from "./log";
import { canMate } from "./mating";
import { createMonster, displayName, grantXp, rollMutations, rollPersonality, skillsForLevel, statOf, xpToNext } from "./monster";
import { autoEvolveWild, buildWildSignature } from "./signature";
import { advanceReproduction, makeReproProfile, maturityFor, rollReproMode } from "./reproduction";
import { ensureTerritory, homeAnchor, releaseTerritoryOwner, territoryOf } from "./territory";
import { seesTile } from "./perception";
import { Rng, clamp, hash01, hash2, hash3, hashString } from "./rng";
import type { Disposition, GameState, ItemId, Monster, Nest, OriginId, WeatherId, WildCreature } from "./types";
import { SEASONS, type Feature, type World, getWorld, seasonIndex, seedFromText, timeOf } from "./world";

export { addLog, compass } from "./log";
export { sightRadius } from "./perception";

export const CHUNK = 16;
const LOAD_R = 3;
const SIM_R = 30;
export const SAVE_VERSION = 24;
export { PEN_MAX } from "./data";
export const INN_COST = 12;

const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** Every tile a creature's body covers (huge creatures sweep 2×2) — growth-aware. */
const coverOf = (c: WildCreature, tick: number): [number, number][] => {
  const fp = bodyFootprint(c, tick);
  const out: [number, number][] = [];
  for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) out.push([c.x + dx, c.y + dy]);
  return out;
};
/** Occupancy keys are layer-scoped: a hawk aloft and a boar below share ground coordinates without colliding. */
const occKey = (c: { layer?: number }, tx: number, ty: number): number => ((c.layer ?? SURFACE) + 3) * WORLD_SIZE * WORLD_SIZE + ty * WORLD_SIZE + tx;
const occAdd = (occ: Map<number, string>, c: WildCreature, tick: number): void => {
  for (const [tx, ty] of coverOf(c, tick)) occ.set(occKey(c, tx, ty), c.id);
};
const occDel = (occ: Map<number, string>, c: WildCreature, tick: number): void => {
  for (const [tx, ty] of coverOf(c, tick)) {
    const k = occKey(c, tx, ty);
    if (occ.get(k) === c.id) occ.delete(k);
  }
};

/* --------------------------------- New game --------------------------------- */

export function previewStarter(seedText: string, speciesId: string): Monster {
  const seed = seedFromText(seedText);
  const temp = { uidSeq: 0, tick: 0 } as GameState;
  return createMonster(temp, speciesId, 5, { seed: hash2(seed, hashString(speciesId), 7), origin: "Starter", mutations: [] });
}

export function newGame(seedText: string, name: string, origin: OriginId, scarf: string, starter: Monster, look?: TamerLook): GameState {
  const seed = seedFromText(seedText);
  const world = getWorld(seed);
  const start = world.startPoint();
  const o = ORIGINS[origin];
  const state: GameState = {
    version: SAVE_VERSION,
    seedText: seedText.trim().toUpperCase(),
    seed,
    tick: 7 * 12,
    player: { name: name.trim() || "Rook", origin, scarf, x: start.x, y: start.y, gold: o.gold, homeX: start.x, homeY: start.y, homeName: start.name, fx: start.x, fy: start.y, look: look ? resolveLook(look).look : undefined },
    party: [],
    pen: [],
    bag: { ...o.bag },
    creatures: {},
    loadedChunks: [],
    removed: {},
    depleted: {},
    log: [],
    logSeq: 0,
    seen: {},
    tamed: {},
    regions: {},
    lastWeather: "clear",
    lastRegion: "",
    lastNation: "",
    stats: { steps: 0, battles: 0, tamed: 0, synthesized: 0, foraged: 0 },
    field: {},
    orders: {},
    aggr: {},
    skillQ: {},
    target: null,
    tracked: null,
    trackedHint: 0,
    ground: {},
    fighters: {},
    uidSeq: 1,
    nests: {},
    developments: {},
    broodSeq: 0,
    territories: {},
    territorySeq: 0,
    carrion: {},
    carrionSeq: 0,
    events: [],
    eventSeq: 0,
    rumorBoard: {},
    rumorQ: [],
    rep: emptyRep(),
    repApplied: {},
    metTamers: {},
    grudges: {},
    knowledge: emptyKnowledge(),
  };
  const mon: Monster = { ...starter, uid: "m1", origin: `Raised in ${start.name}`, bond: 60 };
  state.party.push(mon);
  initField(state);
  state.seen[mon.speciesId] = true;
  state.tamed[mon.speciesId] = true;
  state.lastRegion = world.regionName(start.x, start.y);
  state.lastWeather = world.weather(start.x, start.y, state.tick).id;
  // the home nation is known from the first day
  const homeNat = getFactions(seed).nationAt(start.x, start.y);
  if (homeNat) {
    state.lastNation = homeNat.id;
    state.knowledge.nationsSeen[homeNat.id] = 1;
    addLog(state, `${start.name} answers to ${homeNat.title}.`, "system");
  }
  addLog(state, `Day 1, ${SEASONS[0]}. You set out from ${start.name} with ${displayName(mon)} at your side.`, "system");
  addLog(state, `World seed ${state.seedText}. Every hill, river and creature here will always be where it is now.`, "system");
  // the roster of rival tamers is drawn from the seed exactly once
  initTamers(state);
  if (Object.keys(state.tamers ?? {}).length) addLog(state, `Rival tamers work these lands — tamers with teams, reputations and roads of their own.`, "event");
  loadChunks(state);
  ensureKnowledge(state);
  const home = world.tile(start.x, start.y).feature;
  if (home) discoverFeature(state, home, false);
  updateKnowledge(state);
  return state;
}

/* ---------------------------------- Chunks ---------------------------------- */

const removedRecently = (state: GameState, id: string, days = 3): boolean => {
  const r = state.removed[id];
  return r !== undefined && state.tick - r < DAY_TICKS * days;
};

export function creatureAt(state: GameState, x: number, y: number): WildCreature | null {
  for (const id in state.creatures) {
    const c = state.creatures[id];
    if (!sameLayer(state, c)) continue;
    if (c.x === x && c.y === y) return c;
    // multi-tile bodies block every tile of their body (growth-aware)
    const fp = bodyFootprint(c, state.tick);
    if (fp > 1 && x >= c.x && x < c.x + fp && y >= c.y && y < c.y + fp) return c;
  }
  return null;
}

const DANGER_BONUS: Partial<Record<string, number>> = { gloomwood: 3, mountain: 2, desert: 1, snow: 2, marsh: 1, tundra: 1 };

export function dangerLevel(world: World, x: number, y: number, biome: string, h: number): number {
  const s = world.startPoint();
  const d = Math.hypot(x - s.x, y - s.y);
  return clamp(1 + Math.floor(d / 70) + (d > 60 ? DANGER_BONUS[biome] ?? 0 : 0) + (h % 3), 1, 50);
}

export function makeCreature(id: string, speciesId: string, x: number, y: number, level: number, h: number, alpha: boolean): WildCreature {
  const sp = SPECIES[speciesId];
  const rng = new Rng(h);
  const personality = rollPersonality(rng);
  const a = sp.aggression + PERSONALITIES[personality].aggression + (alpha ? 0.3 : 0);
  const r = rng.next();
  const disposition: Disposition = r < a ? "aggressive" : r < a + 0.22 ? "skittish" : r < a + 0.6 ? "curious" : "calm";
  const body: WildCreature = {
    id, speciesId, level, x, y, homeX: x, homeY: y, hpFrac: 1,
    satiety: Math.round(40 + rng.next() * 55), disposition, activity: "Wandering", personality,
    geneSeed: rng.int(1, 2_000_000_000),
    // explicit genotype is authoritative; geneSeed remains for legacy migration
    genes: rollGenome(rng, speciesId),
    gen: 1,
    lineageId: founderLineage(id),
    repro: makeReproProfile(rollReproMode(rng, speciesId), level, 0),
    calmUntil: 0, alpha, affection: 0, stalking: false,
    xp: 0,
  };
  // a veteran may have forged a signature technique over its lifetime —
  // deterministic from its spawn hash, so the same seed grows the same technique
  const sig = buildWildSignature(speciesId, level, skillsForLevel(speciesId, level), h);
  if (sig) body.sig = sig;
  return body;
}

/** Wild level cap — veterans are scary, not demigods. */
export const WILD_LEVEL_CAP = 30;
/** Experience from trading blows over a territorial scrap. */
export const SCRAP_XP = 2;
/** Experience for prey that kicks free of a hunt. */
export const ESCAPE_XP = 3;

/** The experience a victor banks from putting a body down. */
export function wildXpFor(victim: { speciesId: string; level: number }): number {
  return Math.round(SPECIES[victim.speciesId].xp * (0.8 + victim.level * 0.3));
}

/**
 * Banks fight experience on a wild body and levels it up when it has enough:
 * levels feed the same stat math the party reads, so veterans are genuinely
 * stronger (and worth more XP themselves). Returns true when the body rose.
 */
export function awardWildXp(state: GameState, c: WildCreature, amount: number): boolean {
  if (amount <= 0 || !state.creatures[c.id]) return false;
  c.xp = (c.xp ?? 0) + amount;
  let rose = false;
  while (c.xp >= xpToNext(c.level) && c.level < WILD_LEVEL_CAP) {
    c.xp -= xpToNext(c.level);
    c.level += 1;
    rose = true;
    c.hpFrac = Math.min(1, c.hpFrac + 0.25);
  }
  // a veteran wild body evolves its signature technique on its own
  if (c.sig && c.level >= c.sig.nextLevel) {
    autoEvolveWild(c.sig, c.geneSeed);
    if (cheb(c.x, c.y, state.player.x, state.player.y) <= 12) addLog(state, `The ${SPECIES[c.speciesId].name}'s ${c.sig.name} grows fiercer!`, "event");
  }
  if (rose && cheb(c.x, c.y, state.player.x, state.player.y) <= 12) {
    addLog(state, `The ${SPECIES[c.speciesId].name} fights hard and rises to level ${c.level}.`, "event");
  }
  return rose;
}

/** Backfills fight experience for older saves — idempotent, runs on every load. */
export function migrateWildXp(state: GameState): void {
  for (const c of Object.values(state.creatures)) if (c.xp === undefined) c.xp = 0;
}

/**
 * Backfills encounter persistence for older saves: bodies standing near the
 * player count as met. Idempotent, runs on every load.
 */
export function migratePersistence(state: GameState): void {
  for (const c of Object.values(state.creatures)) {
    if (!c.known && cheb(c.x, c.y, state.player.x, state.player.y) <= 12) c.known = true;
  }
}

/** True when a footprint-sized area (2×2 for huge creatures) is open ground with no creatures, not straddling a cliff. */
export function fitsFootprint(state: GameState, world: World, x: number, y: number, fp: number, layer = SURFACE): boolean {
  if (!bodyLevelOk(world, layer, x, y, fp)) return false;
  const hf = heightOf(world);
  for (let dy = 0; dy < fp; dy++) {
    for (let dx = 0; dx < fp; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (!world.inBounds(tx, ty)) return false;
      if (layer === SKY) {
        // open air
      } else if (layer === UW) {
        if (!hf.uwOpen(tx, ty)) return false;
      } else if (layer < SURFACE) {
        if (!hf.caveOpen(layer, tx, ty)) return false;
      } else {
        const t = world.tile(tx, ty);
        if (!BIOMES[t.biome].passable || t.feature || world.siteAt(tx, ty)?.wall) return false;
        if (objectAt(world, tx, ty)) return false;
      }
      if (creatureAt(state, tx, ty) || (tx === state.player.x && ty === state.player.y)) return false;
      // party monsters are bodies on the map: nothing spawns inside them
      if (partyMonAt(state, tx, ty)) return false;
    }
  }
  return true;
}

/** How far a minion strays from its alpha before turning back, and how far it will chase an intruder. */
const PACK_LEASH = 5;
const PACK_GUARD_R = 6;

/** Spawns a lair's alpha and its loyal pack: a handful of the same species defending their master. */
export function spawnLairPack(state: GameState, world: World, f: Feature): void {
  const id = `l:${f.x}:${f.y}`;
  if (!f.speciesId || state.creatures[id] || removedRecently(state, id, 5)) return;
  if (activeBodyCount(state) >= CREATURE_CAP) return;
  const h = hash2(state.seed ^ 0x1a17, f.x, f.y);
  const lv = dangerLevel(world, f.x, f.y, world.tile(f.x, f.y).biome, 2) + 3;
  const fp = footprintOf(SPECIES[f.speciesId]);
  // the lair's own feature tile is den floor, and big bodies anchor toward the den's heart so they fit
  const off = Math.floor((fp - 1) / 2);
  const ax = f.x - off;
  const ay = f.y - off;
  const fitsDen = (x: number, y: number): boolean => {
    for (let dy = 0; dy < fp; dy++) {
      for (let dx = 0; dx < fp; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (!world.inBounds(tx, ty)) return false;
        const t = world.tile(tx, ty);
        if (!BIOMES[t.biome].passable || (t.feature && !(tx === f.x && ty === f.y)) || world.siteAt(tx, ty)?.wall) return false;
        if (creatureAt(state, tx, ty) || (tx === state.player.x && ty === state.player.y)) return false;
        if (partyMonAt(state, tx, ty)) return false;
      }
    }
    return true;
  };
  if (!fitsDen(ax, ay)) return;
  state.creatures[id] = makeCreature(id, f.speciesId, ax, ay, lv, h, true);
  ensureTerritory(state, state.creatures[id]);
  // the pack: 3–5 den-mates ringed around their master, a level or two below
  const n = 3 + ((h >>> 7) % 3);
  const ring: [number, number][] = [];
  for (let r = 1; r <= 3; r++) {
    let cx = f.x - r;
    let cy = f.y - r;
    for (const [sx, sy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      for (let k = 0; k < 2 * r; k++) {
        ring.push([cx, cy]);
        cx += sx;
        cy += sy;
      }
    }
  }
  const rot = (h >>> 11) % ring.length;
  const ordered = [...ring.slice(rot), ...ring.slice(0, rot)];
  let viable = 0;
  for (const [mx, my] of ordered) {
    if (viable >= n) break;
    if (!fitsDen(mx, my)) continue;
    const mid = `${id}:${viable++}`;
    if (state.creatures[mid] || removedRecently(state, mid, 5)) continue;
    const m = makeCreature(mid, f.speciesId, mx, my, Math.max(1, lv - 1 - ((h >>> (13 + viable)) % 2)), hash2(state.seed ^ 0x6a6b, f.x * 7 + viable, f.y * 3 + viable), false);
    m.pack = id;
    m.disposition = "aggressive";
    state.creatures[mid] = m;
    ensureTerritory(state, m);
  }
}

/** Non-surface wildlife per layer: burrowers below, divers beneath the deep. The sky has no resident ecology — flying creatures are ground animals that travel aloft. */
function spawnLayerChunk(state: GameState, world: World, cx: number, cy: number, layer: number): void {
  if (activeBodyCount(state) >= CREATURE_CAP) return;
  const hf = heightOf(world);
  const fauna = CAVE_FAUNA[layer] ?? (layer === UW ? UW_FAUNA : null);
  if (!fauna) return;
  if (materializeDistantChunk(state, world, cx, cy)) return;
  const density = layer < SURFACE && layer !== UW ? CAVE_DENSITY : LAYER_DENSITY[layer] ?? CAVE_DENSITY;
  for (let i = 0; i < 8; i++) {
    const h = hash3(state.seed ^ 0xcafe ^ (layer & 0xff), cx, cy, i);
    const x = cx * CHUNK + (h % CHUNK);
    const y = cy * CHUNK + ((h >>> 8) % CHUNK);
    const open = layer === UW ? hf.uwOpen(x, y) : hf.caveOpen(layer, x, y);
    if (!open) continue;
    if (((h >>> 16) & 1023) / 1024 > density) continue;
    // layer-distinct id namespace: caves and the seafloor share the `v` scheme (their layers never mix)
    const id = `v${-layer}:${cx}:${cy}:${i}`;
    if (removedRecently(state, id) || state.creatures[id]) continue;
    const sp = pickWeighted(fauna, hash3(state.seed ^ 0xcaf0, cx, cy, i));
    if (!fitsFootprint(state, world, x, y, footprintOf(SPECIES[sp]), layer)) continue;
    const lv = dangerLevel(world, x, y, "mountain", h >>> 22) + (CAVE_LEVEL_BONUS[layer] ?? 0);
    const c = makeCreature(id, sp, x, y, lv, h, false);
    c.layer = layer;
    state.creatures[id] = c;
    ensureTerritory(state, c);
  }
}

/** Burrowers come up through cave mouths: some mouths have one loitering at the entrance. */
function spawnMouthBurrowers(state: GameState, world: World, cx: number, cy: number): void {
  const hf = heightOf(world);
  for (const m of hf.mouthsIn(cx * CHUNK, cy * CHUNK, cx * CHUNK + CHUNK - 1, cy * CHUNK + CHUNK - 1)) {
    if (hash01(state.seed ^ 0xb0b, m.x, m.y) >= MOUTH_BURROWER_CHANCE) continue;
    const id = `m:${m.x}:${m.y}`;
    if (removedRecently(state, id) || state.creatures[id]) continue;
    const sp = pickWeighted(MOUTH_BURROWERS, hash2(state.seed ^ 0xb0c, m.x, m.y));
    const fp = footprintOf(SPECIES[sp]);
    for (const [ox, oy] of [[0, 1], [-1, 1], [1, 1], [0, 2]] as const) {
      const x = m.x + ox;
      const y = m.y + oy;
      if (!fitsFootprint(state, world, x, y, fp, SURFACE)) continue;
      const h = hash2(state.seed ^ 0xb0d, m.x, m.y);
      const c = makeCreature(id, sp, x, y, dangerLevel(world, x, y, "mountain", h >>> 22) + 1, h, false);
      state.creatures[id] = c;
      ensureTerritory(state, c);
      break;
    }
  }
}

function spawnChunk(state: GameState, world: World, cx: number, cy: number, kl: number = layerOf(state)): void {
  // technical safeguard on live local bodies (performance and simulation
  // stability) — NOT an ecological mechanic; chronicled monsters persist beyond it
  if (activeBodyCount(state) >= CREATURE_CAP) return;
  if (kl !== SURFACE) {
    spawnLayerChunk(state, world, cx, cy, kl);
    return;
  }
  const layer = kl;
  spawnMouthBurrowers(state, world, cx, cy);
  // Phase 11: a chunk with abstract populations materializes them instead of fresh spawns
  if (!materializeDistantChunk(state, world, cx, cy)) {
    const census = buildCensus(state, world, layer);
    for (let i = 0; i < 11; i++) {
    const h = hash3(state.seed ^ 0x5eed, cx, cy, i);
    const x = cx * CHUNK + (h % CHUNK);
    const y = cy * CHUNK + ((h >>> 8) % CHUNK);
    if (!world.inBounds(x, y)) continue;
    const t = world.tile(x, y);
    const b = BIOMES[t.biome];
    if (!b.passable || t.feature || world.siteAt(x, y)?.wall) continue;
    if (objectAt(world, x, y)) continue;
    if (((h >>> 16) & 1023) / 1024 > b.density * 0.62) continue;
    const id = `c:${cx}:${cy}:${i}`;
    if (removedRecently(state, id) || state.creatures[id]) continue;
    const sp = world.pickSpecies(t.biome, hash3(state.seed ^ 0x5bec, cx, cy, i));
    if (!sp) continue;
    if (creatureAt(state, x, y) || (x === state.player.x && y === state.player.y)) continue;
    const fp = footprintOf(SPECIES[sp]);
    if (fp > 1 && !fitsFootprint(state, world, x, y, fp)) continue;
    if (partyMonAt(state, x, y)) continue;
    // ecological gate: territories at (or over) their carrying capacity receive no new immigrants
    if (!spawnAllowedByEcology(state, world, layer, x, y, sp, census)) continue;
    // some immigrants arrive battle-hardened (+2 levels)
    const lv = dangerLevel(world, x, y, t.biome, h >>> 22) + ((h >>> 27) % 6 === 0 ? 2 : 0);
    state.creatures[id] = makeCreature(id, sp, x, y, lv, h, false);
    ensureTerritory(state, state.creatures[id]);
  }
  }
  for (const f of world.featuresNear(cx * CHUNK + 8, cy * CHUNK + 8, 8)) {
    if (f.kind !== "lair" || !f.speciesId) continue;
    if (Math.floor(f.x / CHUNK) !== cx || Math.floor(f.y / CHUNK) !== cy) continue;
    spawnLairPack(state, world, f);
  }
}

/** Chunk keys: surface keys keep the legacy `cx,cy` form; cave chunks are prefixed with their layer. */
export const chunkKey = (layer: number, cx: number, cy: number): string => (layer === SURFACE ? `${cx},${cy}` : `${layer}:${cx},${cy}`);
const parseChunk = (k: string): [number, number, number] => {
  const i = k.indexOf(":");
  const [cx, cy] = k.slice(i + 1).split(",").map(Number);
  return [i < 0 ? SURFACE : Number(k.slice(0, i)), cx, cy];
};

/**
 * Wild bodies whose home range lies in a currently-loaded chunk — the ones the
 * local simulation actually carries. Chronicled monsters persist as real bodies
 * even when far away, so spawn capacity counts live local bodies, not history.
 */
export function activeBodyCount(state: GameState): number {
  const loaded = new Set(state.loadedChunks);
  let n = 0;
  for (const c of Object.values(state.creatures)) {
    const home = homeAnchor(state, c);
    if (loaded.has(chunkKey(c.layer ?? SURFACE, Math.floor(home.x / CHUNK), Math.floor(home.y / CHUNK)))) n++;
  }
  return n;
}

export function loadChunks(state: GameState): void {
  const world = getWorld(state.seed);
  const layer = layerOf(state);
  const pcx = Math.floor(state.player.x / CHUNK);
  const pcy = Math.floor(state.player.y / CHUNK);
  const want = new Set<string>();
  for (let dy = -LOAD_R; dy <= LOAD_R; dy++) {
    for (let dx = -LOAD_R; dx <= LOAD_R; dx++) {
      want.add(chunkKey(layer, pcx + dx, pcy + dy));
      // the column rule: from the surface, the seafloor below belongs to the
      // same living world and loads (and simulates) alongside it
      if (layer === SURFACE) want.add(chunkKey(UW, pcx + dx, pcy + dy));
    }
  }
  const loaded = new Set(state.loadedChunks);
  for (const k of want) {
    if (loaded.has(k)) continue;
    const [kcl, cx, cy] = parseChunk(k);
    if (cx < 0 || cy < 0) continue;
    spawnChunk(state, world, cx, cy, kcl);
  }
  const keep: string[] = [];
  const drop = new Set<string>();
  for (const k of loaded) {
    if (want.has(k)) continue;
    const [kl, cx, cy] = parseChunk(k);
    if ((kl === layer || (layer === SURFACE && kl === UW)) && cheb(cx, cy, pcx, pcy) <= LOAD_R + 1) keep.push(k);
    else drop.add(k);
  }
  if (drop.size) {
    for (const id in state.creatures) {
      const c = state.creatures[id];
      const home = homeAnchor(state, c);
      if (drop.has(chunkKey(c.layer ?? SURFACE, Math.floor(home.x / CHUNK), Math.floor(home.y / CHUNK)))) {
        // Ordinary wildlife folds into the chunk's abstract population; monsters
        // the player has met (and anchored/exceptional spawns) persist as real
        // individuals. Unloading never abandons a nest — folding transfers the
        // owner's nests into the population's care.
        if (!abstractDroppedCreature(state, c)) continue;
        delete state.creatures[id];
      }
    }
  }
  state.loadedChunks = [...want, ...keep];
}

/** Column-layer bodies (aloft fliers, submerged swimmers) — the renderer's shadow and shape source. */
export function columnBodies(state: GameState, layer: number): WildCreature[] {
  return Object.values(state.creatures).filter((c) => (c.layer ?? SURFACE) === layer);
}

/**
 * Moves the player (and the party at their side) to another vertical layer.
 * Creatures live only on the player's layer: everything here unloads (exactly
 * like leaving their chunks) and the new layer's wildlife loads in. Territories
 * persist, and unloaded populations respawn deterministically on return.
 */
export function changeLayer(state: GameState, layer: number): void {
  for (const id of Object.keys(state.creatures)) {
    const c = state.creatures[id];
    // ordinary wildlife folds into its chunk's abstract population; monsters the
    // player has met stay real bodies, dormant until this layer is revisited.
    // Crossing layers is not a lifecycle event — nests keep their owners.
    if (abstractDroppedCreature(state, c)) delete state.creatures[id];
  }
  state.target = null;
  state.skillQ = {};
  for (const k of Object.keys(state.fighters)) if (!state.party.some((m) => m.uid === k)) delete state.fighters[k];
  state.loadedChunks = [];
  if (layer === SURFACE) delete state.player.layer;
  else state.player.layer = layer;
  initField(state);
  loadChunks(state);
}

/* -------------------------------- Simulation -------------------------------- */

export function isAwake(c: WildCreature, hour: number, weather: WeatherId): boolean {
  const sp = SPECIES[c.speciesId];
  if (c.satiety < 18) return true;
  let awake: boolean;
  if (sp.activity === "diurnal") awake = hour >= 6 && hour < 20;
  else if (sp.activity === "nocturnal") awake = hour >= 19 || hour < 6;
  else awake = (hour >= 4 && hour < 10) || (hour >= 16 && hour < 24);
  if (awake && weather === "storm" && !c.alpha && c.personality !== "brave") return false;
  return awake;
}

/** Predator/prey rule — one source, shared with wildlife perception (Phase 9). */
const isPredatorOf = predatesOn;

function simWildlife(state: GameState, world: World, safe: boolean): void {
  const time = timeOf(state.tick);
  const px = state.player.x;
  const py = state.player.y;
  const weather = world.weather(px, py, state.tick).id;
  const occ = new Map<number, string>();
  const near: WildCreature[] = [];
  const layer = layerOf(state);
  const hf = heightOf(world);
  for (const id in state.creatures) {
    const c = state.creatures[id];
    // the column layers ride along with a surface player: aloft fliers and
    // submerged swimmers live in the same simulation as the ground
    if (!sameLayer(state, c) && !(layer === SURFACE && ((c.layer ?? SURFACE) === SKY || (c.layer ?? SURFACE) === UW))) continue;
    occAdd(occ, c, state.tick);
    if (cheb(c.x, c.y, px, py) <= SIM_R) near.push(c);
  }
  // party monsters are bodies on the map: creatures path around them
  const pocc = (layer + 3) * WORLD_SIZE * WORLD_SIZE;
  for (const m of state.party) {
    const pos = state.field[m.uid];
    if (!pos) continue;
    const fp = bodyFootprint(m, state.tick);
    for (let dy = 0; dy < fp; dy++) for (let dx = 0; dx < fp; dx++) occ.set(pocc + (pos.y + dy) * WORLD_SIZE + pos.x + dx, `p:${m.uid}`);
  }
  const inSettlement = isSettlement(world.tile(px, py).feature);

  /**
   * Wild step rule: terrain on this layer, then height. Wild bodies never
   * throw themselves off ledges (climbers and fliers excepted), climb only by
   * slopes unless they are climbers, and big bodies never straddle a cliff.
   */
  /** Ground rules per body: each body answers for its own layer, so aloft and submerged bodies share ground coordinates freely. The optional override answers "could it stand here on the surface?" for landings. */
  const canEnter = (c: WildCreature, x: number, y: number, onLayer?: number): boolean => {
    const lay = onLayer ?? c.layer ?? SURFACE;
    const sp = SPECIES[c.speciesId];
    const fp = bodyFootprint(c, state.tick);
    const mv = moverOf(c.speciesId);
    const st = stepRule(world, lay, c.x, c.y, x, y, mv);
    if (!st.ok || fallLevels(mv, st.drop) > 0) return false;
    if (!bodyLevelOk(world, lay, x, y, fp)) return false;
    for (let dy = 0; dy < fp; dy++) {
      for (let dx = 0; dx < fp; dx++) {
        const tx = x + dx;
        const ty = y + dy;
        if (!world.inBounds(tx, ty)) return false;
        if (lay === SURFACE && tx === px && ty === py) return false;
        const o = occ.get((lay + 3) * WORLD_SIZE * WORLD_SIZE + ty * WORLD_SIZE + tx);
        if (o && o !== c.id) return false;
        if (lay === SKY) continue; // the open sky ignores terrain entirely
        if (lay === UW) {
          if (!hf.uwOpen(tx, ty)) return false;
          continue;
        }
        if (lay < SURFACE) {
          if (!hf.caveOpen(lay, tx, ty)) return false;
          continue;
        }
        const t = world.tile(tx, ty);
        if (objectAt(world, tx, ty)) return false;
        if (t.biome === "deep" && !sp.swims) return false;
        if (t.biome === "peak" && !mv.climbs && !mv.flies) return false;
        if ((t.biome === "sea" || t.biome === "lake") && !sp.swims) return false;
        if (t.biome === "river" && sp.fears === "water" && !sp.traits.includes("flutter")) return false;
        if (isSettlement(t.feature)) return false;
        if (world.siteAt(tx, ty)?.wall) return false;
      }
    }
    return true;
  };
  const moveTo = (c: WildCreature, x: number, y: number): void => {
    occDel(occ, c, state.tick);
    c.x = x;
    c.y = y;
    occAdd(occ, c, state.tick);
  };
  /** Greedy route step, height-aware: climbs are avoided when another step serves (heavy bodies avoid them strongly). */
  const stepToward = (c: WildCreature, tx: number, ty: number, away: boolean): boolean => {
    const cur = Math.hypot(tx - c.x, ty - c.y);
    const mv = moverOf(c.speciesId);
    const avoid = mv.heavy ? HEAVY_CLIMB_AVOID : CLIMB_AVOID;
    let best: [number, number] | null = null;
    let bestD = cur;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = c.x + dx;
        const ny = c.y + dy;
        if (!canEnter(c, nx, ny)) continue;
        const rise = mv.flies || mv.climbs ? 0 : stepRule(world, c.layer ?? SURFACE, c.x, c.y, nx, ny, mv).rise;
        const raw = Math.hypot(tx - nx, ty - ny);
        const d = away ? raw - rise * avoid : raw + rise * avoid;
        if (away ? d > bestD : d < bestD) {
          bestD = d;
          best = [nx, ny];
        }
      }
    }
    if (best) moveTo(c, best[0], best[1]);
    return !!best;
  };

  // ecological assessments are shared across all decisions this tick (built once, lazily)
  let ecoMap: Map<string, TerritoryEcology> | null = null;
  const ecoOf = (c: WildCreature): TerritoryEcology | undefined => {
    const t = territoryOf(state, c);
    if (!t) return undefined;
    if (!ecoMap) {
      ecoMap = new Map();
      for (const cc of buildCensus(state, world, layer).values()) ecoMap.set(cc.territory.id, assessTerritory(state, world, cc.territory, cc));
    }
    return ecoMap.get(t.id);
  };

  for (const c of near) {
    if (!state.creatures[c.id]) continue;
    const sp = SPECIES[c.speciesId];
    const rng = new Rng(hash3(state.seed, state.tick, hashString(c.id), 0x51));
    // the vertical world, part 1 — leaving the ground: a fed flier takes wing
    // anywhere on open ground (a little more readily over a thermal) and a
    // swimmer dives from deep water. Bodies stay real: their column layer is
    // loaded and simulated alongside the surface.
    const mvT = moverOf(c.speciesId);
    if (layer === SURFACE && !c.stalking && (mvT.flies || mvT.swims) && isAwake(c, time.hour, weather)) {
      const up = mvT.flies && rng.chance(0.012 + (c.satiety > 60 ? 0.014 : 0) + (hf.thermalAt(c.x, c.y) ? 0.02 : 0));
      const down = !up && mvT.swims && hf.uwOpen(c.x, c.y) && rng.chance(0.02);
      if (up || down) {
        occDel(occ, c, state.tick);
        c.layer = up ? SKY : UW;
        occAdd(occ, c, state.tick);
        if (cheb(c.x, c.y, px, py) <= 10) addLog(state, up ? `A ${sp.name} takes wing.` : `A ${sp.name} slips beneath the surface.`, "info");
        continue;
      }
    }
    // the vertical world, part 2 — living in the column: aloft fliers and
    // submerged swimmers travel over any terrain, come down hungry (a diving
    // predator includes you), and drift home over time.
    const cl = c.layer ?? SURFACE;
    if (cl === SKY || cl === UW) {
      c.satiety = Math.max(0, c.satiety - 0.22);
      if (c.hpFrac < 1) c.hpFrac = Math.min(1, c.hpFrac + 0.004);
      if (c.satiety <= 0) {
        c.hpFrac -= 0.01;
        if (c.hpFrac <= 0) {
          state.removed[c.id] = state.tick;
          abandonNestsOf(state, c.id);
          releaseTerritoryOwner(state, c.id);
          ecoOnCreatureDeath(state, c);
          spawnCarrion(state, c);
          delete state.creatures[c.id];
          occDel(occ, c, state.tick);
          if (cheb(c.x, c.y, px, py) <= 10) addLog(state, cl === SKY ? `A starving ${sp.name} falls out of the sky ${compass(c.x - px, c.y - py)} and does not rise.` : `A starving ${sp.name} floats up lifeless ${compass(c.x - px, c.y - py)}.`, "bad");
          continue;
        }
      }
      const ccov = coverOf(c, state.tick);
      const dPlayer = Math.min(...ccov.map(([tx, ty]) => cheb(tx, ty, px, py)));
      if (dPlayer <= 12) c.known = true;
      if (!isAwake(c, time.hour, weather)) {
        c.activity = cl === SKY ? "Roosting on the wing" : "Resting below";
        continue;
      }
      const per = perceiveWildlife(state, c, near, territoryOf(state, c), state.tick);
      if (per.threat) {
        c.activity = `Fleeing from a ${SPECIES[per.threat.speciesId].name}`;
        if (rng.chance(0.85)) stepToward(c, per.threat.x, per.threat.y, true);
        continue;
      }
      const home = homeAnchor(state, c);
      const speed = cl === SKY ? Math.min(0.9, 0.36 + sp.base.agi / 30) : Math.min(0.8, 0.3 + sp.base.agi / 36);
      const moves = rng.next() < speed;
      /** Come down where the body could actually stand: never a tree, never open water for a landlubber. */
      const alight = (what: string): boolean => {
        if (!canEnter(c, c.x, c.y, SURFACE)) return false;
        occDel(occ, c, state.tick);
        delete c.layer; // ground bodies carry no layer
        occAdd(occ, c, state.tick);
        c.activity = what;
        if (dPlayer <= 10) addLog(state, cl === SKY ? `A ${sp.name} alights ${compass(c.x - px, c.y - py)}.` : `A ${sp.name} surfaces ${compass(c.x - px, c.y - py)}.`, "info");
        return true;
      };
      if (c.satiety < 45) {
        // hunger draws column bodies down: fly over the nearest food, land beside it
        const food = per.prey ?? nearestCarrion(state, c, CARRION_SIGHT);
        const huntsYou = !food && sp.diet !== "herbivore" && dPlayer <= 8 && (c.disposition === "aggressive" || c.alpha || c.personality === "fierce" || c.personality === "brave");
        const tgt = food ?? (huntsYou ? { x: px, y: py } : home);
        c.activity = food ? `Hunting a ${SPECIES[food.speciesId].name}` : huntsYou ? "Diving at you" : "Seeking food below";
        if (cheb(c.x, c.y, tgt.x, tgt.y) <= 2 && moves && alight(huntsYou ? "Hunting you" : c.activity)) continue;
        if (moves) stepToward(c, tgt.x, tgt.y, false);
        continue;
      }
      // fed bodies travel: patrol out to the edge of the range, touch down now and then
      c.activity = cl === SKY ? "Traveling aloft" : "Cruising below";
      if (cheb(c.x, c.y, home.x, home.y) > 12) {
        if (moves) stepToward(c, home.x, home.y, false);
      } else if (moves && rng.chance(0.4)) stepToward(c, c.x + rng.int(-4, 4), c.y + rng.int(-4, 4), false);
      if (rng.chance(0.004) && alight("Touching down")) continue;
      continue;
    }
    // home-range reads come from the Territory system; legacy homeX/homeY is the transitional fallback
    const home = homeAnchor(state, c);
    c.satiety = Math.max(0, c.satiety - 0.22);
    if (c.hpFrac < 1) c.hpFrac = Math.min(1, c.hpFrac + 0.004);
    if (c.satiety <= 0) {
      c.hpFrac -= 0.01;
      if (c.hpFrac <= 0) {
        state.removed[c.id] = state.tick;
        abandonNestsOf(state, c.id);
        releaseTerritoryOwner(state, c.id);
        ecoOnCreatureDeath(state, c);
        spawnCarrion(state, c);
        delete state.creatures[c.id];
        occDel(occ, c, state.tick);
        if (cheb(c.x, c.y, px, py) <= 10) addLog(state, `A starving ${sp.name} collapses ${compass(c.x - px, c.y - py)} and does not rise.`, "bad");
        continue;
      }
    }
    const tile = world.tile(c.x, c.y);
    const cost = BIOMES[tile.biome].cost;
    const speed = Math.min(0.85, 0.28 + sp.base.agi / 34) / (sp.traits.includes("flutter") ? 1 : Math.max(1, cost * 0.75));
    const moves = rng.next() < speed;
    const ccov = coverOf(c, state.tick);
    const dPlayer = Math.min(...ccov.map(([tx, ty]) => cheb(tx, ty, px, py)));
    // a body the player has laid eyes on becomes a chronicled individual — it
    // persists as a real monster for the rest of the world's life
    if (dPlayer <= 12) c.known = true;
    // distance to the nearest party body (party monsters are real combatants)
    let dParty = 99;
    for (const m of state.party) {
      const pos = state.field[m.uid];
      if (!pos || m.hp <= 0) continue;
      const fp = bodyFootprint(m, state.tick);
      for (let oy = 0; oy < fp; oy++) for (let ox = 0; ox < fp; ox++) for (const [tx, ty] of ccov) dParty = Math.min(dParty, cheb(tx, ty, pos.x + ox, pos.y + oy));
    }

    if (!isAwake(c, time.hour, weather)) {
      c.activity = weather === "storm" && sp.activity !== "nocturnal" ? "Sheltering from the storm" : "Sleeping";
      c.stalking = false;
      if (dPlayer <= 1 && c.disposition === "aggressive" && rng.chance(0.08)) c.activity = "Stirring";
      continue;
    }

    // one perception pass feeds every decision below (Phase 9)
    const profile = profileOf(c.speciesId);
    const per = perceiveWildlife(state, c, near, territoryOf(state, c), state.tick);
    const threat = per.threat;
    if (threat) {
      // a famished body gambles on feeding rather than fleeing
      if (c.satiety < 15 && rng.chance(0.5)) c.activity = "Too hungry to flee";
      else {
        c.activity = `Fleeing from a ${SPECIES[threat.speciesId].name}`;
        if (rng.chance(0.85)) stepToward(c, threat.x, threat.y, true);
        continue;
      }
    }
    // badly hurt bodies break off and run — survival before everything else
    if (c.hpFrac < profile.fleeHp && (dPlayer <= 6 || dParty <= 6)) {
      c.activity = "Fleeing, hurt";
      if (rng.chance(0.85)) stepToward(c, px, py, true);
      continue;
    }

    // pack life: loyal minions defend their alpha and keep to its side
    if (c.pack) {
      const alpha = state.creatures[c.pack];
      if (!alpha) {
        // the alpha has fallen: loyalty ends, the minion scatters
        c.pack = undefined;
        c.disposition = "skittish";
        c.calmUntil = Math.max(c.calmUntil, state.tick + 240);
        c.stalking = false;
        c.activity = "Scattering";
        continue;
      }
      const dAlpha = cheb(c.x, c.y, alpha.x, alpha.y);
      let ix = px;
      let iy = py;
      let ad = cheb(alpha.x, alpha.y, px, py);
      for (const m of state.party) {
        const pos = state.field[m.uid];
        if (!pos || m.hp <= 0) continue;
        const d = cheb(alpha.x, alpha.y, pos.x, pos.y);
        if (d < ad) {
          ad = d;
          ix = pos.x;
          iy = pos.y;
        }
      }
      const alphaFight = alpha.stalking || !!state.fighters[alpha.id];
      if ((alphaFight || ad <= 2) && c.satiety > 10) {
        c.stalking = true;
        c.activity = "Guarding its alpha";
        if (dAlpha > PACK_GUARD_R) {
          if (moves) stepToward(c, alpha.x, alpha.y, false);
        } else if (cheb(c.x, c.y, ix, iy) <= 1) {
          if (!safe) wildCombatTurn(state, world, c, occ);
        } else if (moves || rng.chance(0.4)) stepToward(c, ix, iy, false);
        continue;
      }
      if (dAlpha > PACK_LEASH) {
        c.activity = "Loyal to its alpha";
        if (moves) stepToward(c, alpha.x, alpha.y, false);
        continue;
      }
    }

    // nest defense: the mother (and her range-mates) meet threats to developing
    // young — and parents of dependent offspring defend the offspring themselves
    const broodFoe = per.brood && per.broodThreat ? per.broodThreat : per.young && per.youngThreat ? per.youngThreat : null;
    if (broodFoe && profile.defendsNest) {
      c.activity = broodFoe === per.broodThreat ? "Defending its nest" : "Defending its young";
      if (cheb(c.x, c.y, broodFoe.x, broodFoe.y) <= 1) {
        if (!safe) wildCombatTurn(state, world, c, occ);
      } else if (moves || rng.chance(0.6)) stepToward(c, broodFoe.x, broodFoe.y, false);
      continue;
    }
    // hungry carnivores raid nests: the eggs of other species are prey too
    if (sp.diet === "carnivore" && c.satiety < 65) {
      const raid = raidableNestEgg(state, c, layer);
      if (raid && rng.chance(0.5)) {
        takeEggFromNest(state, raid.nest, raid.devId);
        c.satiety = Math.min(100, c.satiety + 35);
        c.activity = "Raiding a nest";
        if (cheb(c.x, c.y, px, py) <= 10) {
          c.known = true;
          addLog(state, `A ${sp.name} devours an egg from the ${SPECIES[raid.nest.speciesId].name} nest ${compass(c.x - px, c.y - py)}.`, "event");
        }
        continue;
      }
    }
    // territorial defense: residents muscle intruders out of the range
    if (per.intruder && (c.alpha || profile.social !== "solitary")) {
      const rival = per.intruder;
      if (rival.level > c.level + 3) {
        c.activity = "Avoiding a rival";
        if (moves) stepToward(c, rival.x, rival.y, true);
        continue;
      }
      if (rng.chance(0.35)) {
        c.activity = "Defending its territory";
        if (cheb(c.x, c.y, rival.x, rival.y) <= 1) {
          rival.hpFrac = Math.max(0.1, rival.hpFrac - (0.05 + rng.next() * 0.1));
          awardWildXp(state, c, SCRAP_XP);
          // scrapping is mutual: the intruder lands blows of its own
          if (rng.chance(0.3)) {
            c.hpFrac = Math.max(0.15, c.hpFrac - (0.04 + rng.next() * 0.08));
            awardWildXp(state, rival, SCRAP_XP);
          }
          if (rng.chance(0.5)) {
            rival.disposition = "skittish";
            rival.calmUntil = state.tick + 120;
          }
        } else if (moves) stepToward(c, rival.x, rival.y, false);
        continue;
      }
    }

    // family life: a dependent juvenile shadows a living parent (hunger wins —
    // the feeding branch below still runs when satiety drops)
    if (c.satiety >= 45 && isDependent(c.bornTick, c.speciesId, state.tick)) {
      const guard = guardianOf(state, c, state.tick);
      if (guard && cheb(c.x, c.y, guard.x, guard.y) > FOLLOW_DIST) {
        c.activity = "Following its parent";
        if (moves) stepToward(c, guard.x, guard.y, false);
        continue;
      }
    }

    let sight = time.night ? (sp.traits.includes("night_eyes") ? 6 : 3) : 5;
    if (weather === "fog" || weather === "sandstorm") sight -= 2;
    if (state.player.origin === "ranger") sight -= 1;
    const calm = c.calmUntil > state.tick;
    const disp: Disposition = calm ? "calm" : c.disposition;

    if (dPlayer <= sight && !inSettlement) {
      if (disp === "aggressive" && (c.satiety < 70 || c.alpha || c.personality === "fierce" || c.personality === "brave")) {
        // true hunger breaks off the hunt: feeding beats a losing stalking war
        if (c.satiety < 20 && dPlayer > 2) {
          c.stalking = false;
          c.activity = "Breaking off to feed";
        } else {
          if (!c.stalking) {
            c.stalking = true;
            addLog(state, `A ${c.alpha ? "great " : ""}${sp.name} has noticed you ${compass(c.x - px, c.y - py)}. ${c.satiety < 40 ? "It looks hungry." : "Its hackles rise."}`, "bad");
            // the alpha commands its pack much like the player commands their monsters
            if (c.alpha) {
              let called = 0;
              for (const o of near) {
                if (o.pack === c.id && state.creatures[o.id]) {
                  o.stalking = true;
                  called++;
                }
              }
              if (called) addLog(state, `The great ${sp.name} bellows a command — its pack closes in around you!`, "bad");
            }
          }
          c.activity = "Stalking you";
          if (dPlayer <= 1 || dParty <= 1) {
            if (!safe) wildCombatTurn(state, world, c, occ);
            continue;
          }
          if (c.alpha && cheb(c.x, c.y, home.x, home.y) > 5) {
            stepToward(c, home.x, home.y, false);
            c.activity = "Guarding its lair";
          } else if (moves || rng.chance(0.4)) stepToward(c, px, py, false);
          continue;
        }
      }
      c.stalking = false;
      if (disp === "skittish") {
        // desperate bodies stop being shy and feed while you keep a step back
        if (c.satiety < 25 && dPlayer > 2) c.activity = "Too hungry to stay shy";
        else {
          c.activity = "Keeping its distance";
          if (dPlayer <= 3 && moves) stepToward(c, px, py, true);
          continue;
        }
      }
      if (disp === "curious" && dPlayer > 2 && c.satiety >= 45) {
        c.activity = "Watching you";
        if (moves && rng.chance(0.5)) stepToward(c, px, py, false);
        continue;
      }
      if (disp === "curious") c.activity = "Watching you";
    } else c.stalking = false;

    if (c.satiety < 45) {
      const diet = sp.diet;
      /** One route attempt toward food: closing distance resets the block counter; lateral or blocked steps accumulate toward a give-up. Long-range plant seeking then rests for a day; pursuit of live prey never does — it sidesteps and re-approaches instead. */
      const seekStep = (target: { x: number; y: number }, ban: boolean): void => {
        const before = Math.hypot(target.x - c.x, target.y - c.y);
        if (stepToward(c, target.x, target.y, false) && Math.hypot(target.x - c.x, target.y - c.y) < before - 1e-9) c.stuck = 0;
        else if ((c.stuck ?? 0) + 1 >= 8) {
          c.stuck = 0;
          if (ban) {
            c.seek = null;
            c.seekBan = state.tick + 288;
          } else {
            // sidestep: break the geometry instead of butting the same rock
            const sdx = rng.int(-1, 1);
            const sdy = rng.int(-1, 1);
            if ((sdx || sdy) && canEnter(c, c.x + sdx, c.y + sdy)) moveTo(c, c.x + sdx, c.y + sdy);
          }
        } else c.stuck = (c.stuck ?? 0) + 1;
      };
      // scavengers first: remains within smell range beat a risky hunt —
      // but remains a starving body cannot actually reach are given up on
      // (half a day), and the hunt for live prey resumes
      if ((diet === "carnivore" || diet === "omnivore") && (c.carrionBan ?? 0) <= state.tick) {
        const carr = nearestCarrion(state, c, CARRION_SIGHT);
        if (carr) {
          c.activity = "Feeding on a kill";
          if (cheb(c.x, c.y, carr.x, carr.y) <= 1) {
            eatCarrion(state, carr.id);
            c.satiety = Math.min(100, c.satiety + SCAVENGE_FOOD);
            c.hpFrac = Math.min(1, c.hpFrac + 0.04);
            c.stuck = 0;
            if (cheb(carr.x, carr.y, px, py) <= 12 && rng.chance(0.5)) addLog(state, `A ${sp.name} tears at what is left of a ${SPECIES[carr.speciesId].name}.`, "event");
          } else if (moves || rng.chance(0.5)) {
            const before = Math.hypot(carr.x - c.x, carr.y - c.y);
            if (stepToward(c, carr.x, carr.y, false) && Math.hypot(carr.x - c.x, carr.y - c.y) < before - 1e-9) c.stuck = 0;
            else if ((c.stuck ?? 0) + 1 >= 8) {
              c.stuck = 0;
              c.carrionBan = state.tick + 288;
            } else c.stuck = (c.stuck ?? 0) + 1;
          }
          continue;
        }
      }
      if (diet === "carnivore" || (diet === "omnivore" && c.satiety < 25)) {
        let prey = per.prey;
        if (!prey && (c.seekBan ?? 0) <= state.tick) {
          // scent-seek: the nearest huntable body within smell range is walked down
          let scentD = 13;
          for (const o of near) {
            if (o === c || !state.creatures[o.id]) continue;
            const d = cheb(o.x, o.y, c.x, c.y);
            if (d < scentD && predatesOn(c, o, c.satiety < 15)) {
              prey = o;
              scentD = d;
            }
          }
        }
        if (prey) {
          const pname = SPECIES[prey.speciesId].name;
          c.activity = `Hunting a ${pname}`;
          if (cheb(c.x, c.y, prey.x, prey.y) <= 1) {
            prey.hpFrac -= 0.3 + rng.next() * 0.35;
            if (prey.hpFrac <= 0) {
              state.removed[prey.id] = state.tick;
              releaseTerritoryOwner(state, prey.id);
              ecoOnCreatureDeath(state, prey);
              spawnCarrion(state, prey);
              delete state.creatures[prey.id];
              occDel(occ, prey, state.tick);
              c.satiety = Math.min(100, c.satiety + 60);
              c.stuck = 0;
              awardWildXp(state, c, wildXpFor(prey));
              if (cheb(c.x, c.y, px, py) <= 12) addLog(state, `${compass(c.x - px, c.y - py).replace(/^to the/, "Off to the")}, a ${sp.name} catches a ${pname}. The struggle is brief.`, "event");
            } else if (cheb(c.x, c.y, px, py) <= 8 && rng.chance(0.4)) {
              // cornered prey fights back: some hunts cost the hunter
              const kicks = prey.disposition === "aggressive" || prey.personality === "brave" || prey.level >= c.level - 1;
              if (kicks && rng.chance(0.5)) {
                c.hpFrac = Math.max(0.08, c.hpFrac - (0.05 + rng.next() * 0.12));
                awardWildXp(state, prey, ESCAPE_XP);
                addLog(state, `A ${sp.name} lunges at a ${pname}, which kicks and tears free.`, "event");
              } else addLog(state, `A ${sp.name} lunges at a ${pname}, which tears free and bolts.`, "event");
            }
          } else if (moves || rng.chance(0.5)) seekStep(prey, false);
          continue;
        }
      }
      // plant forage exists only on the overland map: cave bodies must not eat
      // surface plants that have no underground presence — the authoritative
      // World.forage/depleted pool is shared with the player, who also cannot
      // forage underground (carrion and live prey are the cave food web)
      const onSurface = (c.layer ?? SURFACE) === SURFACE;
      const item = onSurface ? world.forage(c.x, c.y, state.tick, state.depleted) : null;
      if (item && ITEMS[item].diets.includes(diet)) {
        c.satiety = Math.min(100, c.satiety + 35);
        state.depleted[`${c.x},${c.y}`] = state.tick;
        c.seek = null;
        c.stuck = 0;
        c.activity = `Eating ${ITEMS[item].name.toLowerCase()}`;
        continue;
      }
      // a hungry body walks to food it can smell (surface and caves; scans staggered per body)
      {
        const seekItem = (s: { x: number; y: number }): ItemId | null => {
          // food is judged from where the body stands, not from a home anchor it may have left
          if (!onSurface) return null;
          if (cheb(s.x, s.y, c.x, c.y) > 12) return null;
          const it = world.forage(s.x, s.y, state.tick, state.depleted);
          return it && ITEMS[it].diets.includes(diet) ? it : null;
        };
        if (c.seek && !seekItem(c.seek)) c.seek = null;
        if (!c.seek && (c.seekBan ?? 0) <= state.tick && (state.tick + hashString(c.id)) % 6 === 0) {
          outer: for (let r = 1; r <= 10; r++) {
            for (let dy = -r; dy <= r; dy++) {
              for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const s = { x: c.x + dx, y: c.y + dy };
                if (world.inBounds(s.x, s.y) && seekItem(s)) {
                  c.seek = s;
                  break outer;
                }
              }
            }
          }
        }
        if (c.seek) {
          const it = seekItem(c.seek);
          if (it && cheb(c.x, c.y, c.seek.x, c.seek.y) <= 1) {
            c.satiety = Math.min(100, c.satiety + 35);
            state.depleted[`${c.seek.x},${c.seek.y}`] = state.tick;
            c.seek = null;
            c.stuck = 0;
            c.activity = `Eating ${ITEMS[it].name.toLowerCase()}`;
            continue;
          }
          if (it) {
            c.activity = `Seeking ${ITEMS[it].name.toLowerCase()}`;
            if (moves || rng.chance(0.5)) seekStep(c.seek, true);
            continue;
          }
          c.seek = null;
        }
      }
      c.activity = diet === "carnivore" ? "Prowling for prey" : "Foraging";
      if (moves) {
        const dx = rng.int(-1, 1);
        const dy = rng.int(-1, 1);
        if ((dx || dy) && cheb(c.x + dx, c.y + dy, home.x, home.y) <= 14 && canEnter(c, c.x + dx, c.y + dy)) moveTo(c, c.x + dx, c.y + dy);
      }
      continue;
    }

    // dominance contests: a strong drifter may depose a weakened same-species alpha
    if (profile.challenges && !c.alpha && !c.pack && c.satiety > 60 && rng.chance(0.02)) {
      let target: WildCreature | null = null;
      for (const o of near) {
        if (!state.creatures[o.id] || !o.alpha || o.speciesId !== c.speciesId) continue;
        if (cheb(o.x, o.y, c.x, c.y) <= 2 && o.hpFrac < 0.9) {
          target = o;
          break;
        }
      }
      if (target) {
        c.activity = "Challenging the alpha";
        const myScore = c.level + (c.genes ? (expressGene(c.genes.vigor) + expressGene(c.genes.might)) / 40 : 0) + rng.next();
        if (myScore > target.level + 2) {
          seizeTerritory(state, c, target, state.tick);
          c.satiety -= 10;
          if (cheb(c.x, c.y, px, py) <= 12) addLog(state, `A ${sp.name} has deposed the old alpha of the ${world.regionName(target.x, target.y)} lands.`, "event");
        } else {
          c.hpFrac = Math.max(0.2, c.hpFrac - 0.2);
          c.disposition = "skittish";
          c.calmUntil = state.tick + 240;
          c.activity = "Licking its wounds";
        }
        continue;
      }
    }
    // migration: pressured bodies strike out for new grounds (real movement, cooldown-gated)
    const migr = migrationIntent(state, c, ecoOf(c), home, state.tick);
    if (migr.active) {
      c.activity = "Seeking new grounds";
      if (moves) stepToward(c, migr.tx, migr.ty, false);
      if (cheb(c.x, c.y, home.x, home.y) > 13 && settleMigration(state, c, c.territoryId, state.tick)) {
        c.activity = "Roaming";
        if (cheb(c.x, c.y, px, py) <= 12) addLog(state, `${compass(c.x - px, c.y - py).replace(/^to the/, "Off to the")}, a ${sp.name} leaves its worn-out range for new grounds.`, "event");
      }
      continue;
    }
    // --- courtship: seek, approach, call. Eligibility and permission stay in
    // the authoritative mating layer (canMate / beginBreeding / allowsBreeding);
    // the attempt roll is hash-based (body+tick) so wildlife's staggered
    // decisions never perturb the shared Rng stream.
    if (c.satiety > MATE_SATIETY && !c.alpha && !c.pack && stageOf(c.bornTick, c.speciesId, state.tick) === "mature") {
      const mateT = seekMateTarget(state, c, per, state.tick);
      if (mateT) {
        const dM = cheb(c.x, c.y, mateT.x, mateT.y);
        if (dM > 1) {
          // walk to the chosen mate through ordinary movement — no teleporting
          if (c.activity !== "Answering a mating call") c.activity = "Seeking a mate";
          if (moves) stepToward(c, mateT.x, mateT.y, false);
          continue;
        }
        // within touching distance: the rare hash-gated attempt decides, and the
        // ecology gate (food, density, predators, nests) still has its say
        if (hash01(state.seed ^ hashString(c.id), state.tick, 0xb2ee) < 0.003 && allowsBreeding(state, world, c, rng, ecoOf(c))) {
          const breeding = beginBreeding(state, c, mateT, "wild");
          if (breeding.ok) {
            c.mateTarget = undefined;
            mateT.mateTarget = undefined;
            c.satiety -= 30;
            mateT.satiety -= 30;
            c.activity = "Tending its young";
            mateT.activity = "Tending its young";
            if (cheb(c.x, c.y, px, py) <= 12) addLog(state, `A pair of ${sp.name} nuzzle together ${compass(c.x - px, c.y - py)}.`, "good");
            continue;
          }
          c.mateTarget = undefined; // pairing refused — reassess next tick
        }
      } else if (hash01(state.seed ^ hashString(c.id), state.tick, 0xca11) < CALL_CHANCE && (c.callUntil ?? 0) <= state.tick) {
        // no candidate in courting range: announce. The call checks every
        // listener's eligibility itself and only sets movement intent.
        c.callUntil = state.tick + CALL_COOLDOWN;
        emitMatingCall(state, c, near, state.tick);
        c.activity = "Calling for a mate";
        if (cheb(c.x, c.y, px, py) <= 10 && rng.chance(0.25)) addLog(state, `A ${sp.name} calls for a mate ${compass(c.x - px, c.y - py)}.`, "event");
        continue;
      }
    }

    const leash = c.alpha ? 3 : 10;
    if (cheb(c.x, c.y, home.x, home.y) > leash) {
      c.activity = c.alpha ? "Returning to its lair" : "Heading home";
      if (moves) stepToward(c, home.x, home.y, false);
      continue;
    }
    if ((weather === "rain" || weather === "storm") && sp.element === "fire") {
      c.activity = "Sheltering from the rain";
      continue;
    }
    // a parent keeps its dependent young in reach when nothing more pressing
    // holds it — tighter for packs, looser for loose societies; solitary
    // parents do not chase their scattered young
    if (per.young && profile.social !== "solitary") {
      const pl = profile.social === "pack" ? PARENT_LEASH : PARENT_LEASH + 4;
      if (cheb(c.x, c.y, per.young.x, per.young.y) > pl) {
        c.activity = "Keeping its young close";
        if (moves) stepToward(c, per.young.x, per.young.y, false);
        continue;
      }
    }
    if (c.personality === "lazy" && rng.chance(0.6)) {
      c.activity = "Lazing about";
      continue;
    }
    if (c.activity !== "Watching you") c.activity = c.alpha ? "Guarding its lair" : rng.chance(0.3) ? "Grooming" : "Wandering";
    if (moves && rng.chance(0.6)) {
      const dx = rng.int(-1, 1);
      const dy = rng.int(-1, 1);
      if ((dx || dy) && cheb(c.x + dx, c.y + dy, home.x, home.y) <= leash && canEnter(c, c.x + dx, c.y + dy)) moveTo(c, c.x + dx, c.y + dy);
    }
  }
}

/**
 * The canonical ecological death path (Phase 7): nests, territories, vitals and
 * logging stay consistent with every other cause of death.
 */
function ecoRemove(state: GameState, id: string, cause: "juvenile" | "scarcity"): void {
  const c = state.creatures[id];
  if (!c) return;
  state.removed[id] = state.tick;
  abandonNestsOf(state, id);
  releaseTerritoryOwner(state, id);
  ecoOnCreatureDeath(state, c);
  spawnCarrion(state, c);
  delete state.creatures[id];
  if (cheb(c.x, c.y, state.player.x, state.player.y) <= 12) {
    addLog(
      state,
      cause === "juvenile"
        ? `A young ${SPECIES[c.speciesId].name} grows too weak for the wild and does not survive.`
        : `Pressed by hunger and crowding, a ${SPECIES[c.speciesId].name} dies.`,
      "bad",
    );
  }
}

const PHASE_TEXT: Record<string, string> = {
  Dawn: "Dawn breaks. Birdsong rises, tentative at first.",
  Day: "The sun climbs high and warm.",
  Dusk: "The sun dips low. Shadows stretch long across the land.",
  Night: "Night falls. Something calls out in the dark, and something else answers.",
};

const WEATHER_TEXT: Record<WeatherId, string> = {
  clear: "The sky clears.",
  cloudy: "Clouds gather overhead.",
  rain: "Rain begins to fall.",
  storm: "Thunder rolls. A storm breaks overhead.",
  snow: "Snow begins to drift down.",
  fog: "Fog creeps in, thick and grey.",
  sandstorm: "A wall of sand howls across the dunes.",
};

/** Advances the world clock tick by tick, running wildlife and live combat. */
export function advance(state: GameState, ticks: number, safe = false): void {
  const world = getWorld(state.seed);
  for (let i = 0; i < ticks; i++) {
    const prev = timeOf(state.tick);
    const prevSeason = seasonIndex(state.tick);
    state.tick += 1;
    const time = timeOf(state.tick);
    for (const m of state.party) {
      const before = m.satiety;
      m.satiety = Math.max(0, m.satiety - 0.08);
      if (before >= 25 && m.satiety < 25) addLog(state, `${displayName(m)}'s stomach growls. It needs to eat.`, "bad");
      if (m.satiety <= 0 && state.tick % 12 === 0 && m.hp > 1) m.hp -= 1;
    }
    if (prev.phase !== time.phase) addLog(state, PHASE_TEXT[time.phase], "weather");
    if (state.tick % DAY_TICKS === 0) {
      for (const k in state.removed) if (state.tick - state.removed[k] > DAY_TICKS * 6) delete state.removed[k];
      for (const k in state.depleted) if (!k.startsWith("ruin:") && state.tick - state.depleted[k] > DAY_TICKS * 3) delete state.depleted[k];
    }
    if (seasonIndex(state.tick) !== prevSeason) addLog(state, `${SEASONS[seasonIndex(state.tick)]} arrives. The land shifts with it.`, "system");
    if (state.tick % 4 === 0) {
      const w = world.weather(state.player.x, state.player.y, state.tick).id;
      if (w !== state.lastWeather) {
        const txt = w === "clear" && (state.lastWeather === "rain" || state.lastWeather === "storm") ? "The rain eases. The air smells of wet earth." : WEATHER_TEXT[w];
        addLog(state, txt, "weather");
        state.lastWeather = w;
      }
    }
    simWildlife(state, world, safe);
    // remains rot away on their own clock; scavengers keep the ground clean
    rotTick(state);
    // distant regions keep evolving while the player is away (bounded work per tick)
    advanceDistantEcosystem(state, world);
    // reproductive state follows simulation time: cooldowns tick down, development completes
    advanceReproduction(state);
    // eggs incubate and gestations progress; completed development creates the offspring
    advanceDevelopment(state);
    // carried eggs incubate on their own clock; ready ones announce themselves
    advanceEggs(state);
    // rival tamers live by the same clock: travel, hunts, duels, rumors (no-ops with none)
    advanceTamers(state);
    tamerCombatTurn(state, world);
    tamerProximity(state);
    advanceRumors(state);
    // the party fights back, follows orders and trails the player every tick
    partyCombatTurn(state, world, safe);
    groundTick(state, world);
    // the tracked creature leaves a scent the log can follow
    trackHint(state);
    // population ecology runs on its own slow cadence — never per frame
    if (state.tick % ECOLOGY_INTERVAL === 0) ecologyTick(state, world, (id, cause) => ecoRemove(state, id, cause));
  }
  updateKnowledge(state);
}

/** Can the player personally observe this tile right now (perception, not memory)? */
export function canSee(state: GameState, x: number, y: number): boolean {
  return seesTile(state, x, y);
}

/* --------------------------------- Actions ---------------------------------- */

export interface ActionResult {
  ok: boolean;
  /** A creature id the player bumped into (inspect it). */
  bumped?: string | null;
  /** A creature id now engaged in live combat (select + battle music). */
  engaged?: string | null;
}

const RESULT_NONE: ActionResult = { ok: false };
const RESULT_OK: ActionResult = { ok: true };

export function partyCanFight(state: GameState): boolean {
  return state.party.some((m) => m.hp > 0);
}

/** A long drop needs a second, deliberate step in the same direction (transient, never saved). */
let ledgeWarn: string | null = null;

export function movePlayer(state: GameState, dx: number, dy: number): ActionResult {
  const world = getWorld(state.seed);
  const layer = layerOf(state);
  const hf = heightOf(world);
  const ox = state.player.x;
  const oy = state.player.y;
  const nx = ox + dx;
  const ny = oy + dy;
  if (!world.inBounds(nx, ny)) return RESULT_NONE;
  if (layer < SURFACE) {
    if (!hf.caveOpen(layer, nx, ny)) {
      addLog(state, "Solid rock. The tunnel bends another way.", "info");
      return RESULT_NONE;
    }
  }
  const sp = layer < SURFACE ? null : world.siteAt(nx, ny);
  if (sp?.wall) {
    addLog(
      state,
      sp.post
        ? "A gatepost stands in the way — the gate itself is the way in."
        : sp.kind === "lair"
          ? "The den wall is too sheer to climb. There must be another way in."
          : isSettlement(sp)
            ? "The building wall blocks your way. Try a doorway."
            : "An old wall blocks your way. Parts of it have crumbled, though.",
      "info",
    );
    return RESULT_NONE;
  }
  const t = world.tile(nx, ny);
  if (layer >= SURFACE) {
    const ob = objectAt(world, nx, ny);
    if (ob) {
      const name = OBJ_NAME[ob];
      addLog(state, `${name[0].toUpperCase()}${name.slice(1)} bars the way.`, "info");
      return RESULT_NONE;
    }
  }
  if (layer >= SURFACE && !walkable(world, layer, nx, ny)) {
    addLog(state, "The water is too deep to cross.", "info");
    return RESULT_NONE;
  }
  const step = stepRule(world, layer, ox, oy, nx, ny, PLAYER_MOVER);
  if (!step.ok) {
    addLog(state, step.rise > 1 ? "A sheer cliff towers over you. Look for a slope." : "The rock face is too steep to climb here. Look for a slope.", "info");
    return RESULT_NONE;
  }
  const fall = fallLevels(PLAYER_MOVER, step.drop);
  const ledgeKey = `${ox},${oy}>${nx},${ny}`;
  if (fall > 0 && ledgeWarn !== ledgeKey) {
    ledgeWarn = ledgeKey;
    addLog(state, `A ${step.drop}-level drop. Step again to jump down — it will hurt.`, "bad");
    return RESULT_NONE;
  }
  ledgeWarn = null;
  const c = creatureAt(state, nx, ny);
  if (c) {
    c.known = true;
    const hostile = isHostile(state, c);
    if (!hostile) {
      const sp = SPECIES[c.speciesId];
      state.seen[c.speciesId] = true;
      addLog(state, `The ${sp.name} is in your way. It ${c.activity === "Sleeping" ? "is fast asleep" : c.disposition === "skittish" ? "flinches" : "tilts its head at you"}.`, "info");
      return { ...RESULT_NONE, bumped: c.id };
    }
    if (!partyCanFight(state)) {
      addLog(state, "Your monsters are too hurt to fight. Rest first.", "bad");
      return { ...RESULT_NONE, bumped: c.id };
    }
    engage(state, c.id, false);
    return { ok: true, engaged: c.id };
  }
  state.player.fx = state.player.x;
  state.player.fy = state.player.y;
  state.player.x = nx;
  state.player.y = ny;
  state.stats.steps += 1;
  if (fall > 0) {
    // the party scrambles down after you; climbers and fliers land lightly
    const hurt: string[] = [];
    for (const m of state.party) {
      if (m.hp <= 0 || fallLevels(moverOf(m.speciesId), step.drop) <= 0) continue;
      const dmg = fallDamage(statOf(m, "hp"), fall);
      m.hp = Math.max(1, m.hp - dmg);
      hurt.push(`${displayName(m)} -${dmg}`);
    }
    addLog(state, `You drop ${step.drop} levels and land hard.${hurt.length ? ` (${hurt.join(", ")})` : ""}`, "bad");
    advance(state, FALL_TIME * fall);
  }
  // stepping into a cave mouth or deep shaft moves everyone to another layer
  const to = hf.transitionAt(layer, nx, ny);
  if (to !== null) {
    changeLayer(state, to);
    addLog(
      state,
      to === CAVE_UPPER && layer === SURFACE
        ? "You duck into the cave mouth. The air turns cold and damp, and the light falls away behind you."
        : to === SURFACE
          ? "You climb out of the cave into open air. Your eyes sting in the light."
          : to < layer
            ? "You clamber down the shaft into the deep caves. Crystals glimmer in the black."
            : "You haul yourself up the shaft to the upper caves.",
      "event",
    );
    advance(state, FALL_TIME);
    return RESULT_OK;
  }
  markRoute(state);
  if (layer < SURFACE) {
    loadChunks(state);
    advance(state, 1);
    return RESULT_OK;
  }
  const region = world.regionName(nx, ny);
  if (region !== state.lastRegion) {
    state.lastRegion = region;
    addLog(state, `You enter the ${region} lands.`, "system");
  }
  // crossing a border teaches whose land this is
  const nat = getFactions(state.seed).nationAt(nx, ny);
  const nid = nat?.id ?? "";
  if (nid !== state.lastNation) {
    state.lastNation = nid;
    if (nat) {
      const learned = !state.knowledge.nationsSeen[nat.id];
      state.knowledge.nationsSeen[nat.id] = 1;
      addLog(state, learned ? `You have entered ${nat.title}.` : `You cross back into ${nat.title}.`, "system");
    } else addLog(state, "You leave all banners behind — unclaimed wilds.", "system");
  }
  if (t.feature) {
    const f = t.feature;
    const msg: Record<string, string> = {
      hamlet: `You arrive at ${f.name}. Smoke curls from the chimneys and a dog barks once.`,
      ruin: `You stand among the ${f.name}. The stones are cold, even in the sun.`,
      shrine: `The ${f.name} hums softly. Two roots twist around a mossy altar.`,
      lair: `You've found a ${f.name}. Bones and tufts of fur litter the ground.`,
    };
    addLog(state, msg[f.kind], "event");
  } else if (t.biome === "river" && state.stats.steps % 3 === 0) addLog(state, "You wade through the cold water.", "info");
  else if (t.biome === "peak" && world.tile(ox, oy).biome !== "peak") addLog(state, "You haul yourself up onto the ice of the peak. Every step here is hard won.", "info");
  if (step.rise > 0 && state.stats.steps % 4 === 0) addLog(state, "You trudge up the slope.", "info");
  loadChunks(state);
  advance(state, tileCost(world, layer, nx, ny) + climbCost(PLAYER_MOVER, step.rise));
  regroupParty(state);
  return RESULT_OK;
}

export function waitTurn(state: GameState, ticks = 1): ActionResult {
  advance(state, ticks);
  return RESULT_OK;
}

export function forageHere(state: GameState): ActionResult {
  const world = getWorld(state.seed);
  const { x, y } = state.player;
  const item = world.forage(x, y, state.tick, state.depleted);
  if (!item) {
    addLog(state, "You search the ground but find nothing worth taking.", "info");
  } else {
    const n = state.player.origin === "herbalist" && item === "herb" ? 2 : 1 + (hash2(state.seed, state.tick, x) % 4 === 0 ? 1 : 0);
    state.bag[item] = (state.bag[item] ?? 0) + n;
    state.depleted[`${x},${y}`] = state.tick;
    state.stats.foraged += n;
    addLog(state, `You gather ${n > 1 ? `${n}× ` : ""}${ITEMS[item].name}.`, "good");
  }
  return waitTurn(state, 2);
}

/** Butchers the remains beside you into bag meat. */
export function dressCarrion(state: GameState): ActionResult {
  const carr = carrionNear(state, state.player.x, state.player.y, 1);
  if (!carr) {
    addLog(state, "There are no remains here to dress.", "info");
  } else {
    const got = dressCarrionAt(state, carr.id);
    state.bag.meat = (state.bag.meat ?? 0) + got;
    state.stats.foraged += got;
    addLog(state, `You dress the fallen ${SPECIES[carr.speciesId].name}: +${got}× ${ITEMS.meat.name}.`, "good");
  }
  return waitTurn(state, 3);
}

/* ------------------------------ Context actions ------------------------------- */

export type ContextActionId = "egg" | "dress" | "forage";

export interface ContextAction {
  id: ContextActionId;
  label: string;
}

/** What the ground around the player offers right now, pick-list order: a stealable egg, then remains to dress, then forageable ground. */
export function contextActions(state: GameState): ContextAction[] {
  const out: ContextAction[] = [];
  if (eggNear(state)) out.push({ id: "egg", label: "Steal Egg" });
  if (carrionNear(state, state.player.x, state.player.y, 1)) out.push({ id: "dress", label: "Dress" });
  if (layerOf(state) === SURFACE && BIOMES[getWorld(state.seed).tile(state.player.x, state.player.y).biome].forage.length > 0) out.push({ id: "forage", label: "Forage" });
  return out;
}

/** Performs the context action the player picked (the keyboard uses the first entry). */
export function runContextAction(state: GameState, id: ContextActionId): ActionResult {
  if (id === "egg") return stealEgg(state);
  if (id === "dress") return dressCarrion(state);
  return forageHere(state);
}

/* ------------------------------- Nest eggs ------------------------------------ */

/** One developing egg a nest still holds. */
function developingEggIn(state: GameState, nest: Nest): string | null {
  for (const id of nest.developmentIds) {
    const d = state.developments[id];
    if (d && (d.state === "developing" || d.state === "ready")) return id;
  }
  return null;
}

/** Removes a developing egg from a nest, cleaning every reference. */
function takeEggFromNest(state: GameState, nest: Nest, devId: string): void {
  delete state.developments[devId];
  nest.developmentIds = nest.developmentIds.filter((id) => id !== devId);
}

/** The nearest developing egg of another species this body could eat, within 3 tiles. */
function raidableNestEgg(state: GameState, c: WildCreature, layer: number): { nest: Nest; devId: string } | null {
  let best: { nest: Nest; devId: string } | null = null;
  let bd = 4;
  for (const nest of Object.values(state.nests)) {
    // pop-tended nurseries belong to the abstract population — the distant ecology
    // already prices their egg loss; local raids take real, individually-owned clutches only
    if (nest.state === "destroyed" || isPopOwnedNest(nest.ownerId) || nest.speciesId === c.speciesId || (nest.layer ?? 0) !== layer) continue;
    const d = cheb(nest.x, nest.y, c.x, c.y);
    if (d >= bd) continue;
    const devId = developingEggIn(state, nest);
    if (!devId) continue;
    bd = d;
    best = { nest, devId };
  }
  return best;
}

/** A nest within reach of the player that still holds a stealable egg. */
export function eggNear(state: GameState): { nest: Nest; devId: string; speciesId: string } | null {
  const layer = layerOf(state);
  let best: { nest: Nest; devId: string; speciesId: string } | null = null;
  let bd = 2;
  for (const nest of Object.values(state.nests)) {
    if (nest.state === "destroyed" || (nest.layer ?? 0) !== layer) continue;
    const d = cheb(nest.x, nest.y, state.player.x, state.player.y);
    if (d >= bd) continue;
    const devId = developingEggIn(state, nest);
    if (!devId) continue;
    bd = d;
    best = { nest, devId, speciesId: nest.speciesId };
  }
  return best;
}

/** Steals a developing egg from a nest beside you. The mother does not forgive. */
export function stealEgg(state: GameState): ActionResult {
  const near = eggNear(state);
  if (!near) {
    addLog(state, "No nest with eggs lies within your reach.", "info");
    return waitTurn(state, 1);
  }
  const { nest, devId } = near;
  // your own tame brood is not for the taking
  if (state.party.some((m) => m.uid === nest.ownerId) || state.pen.some((m) => m.uid === nest.ownerId)) {
    addLog(state, "This brood is your own — its eggs are already yours to tend.", "info");
    return waitTurn(state, 1);
  }
  const sp = SPECIES[nest.speciesId];
  const dev = state.developments[devId];
  if (dev?.child) {
    // the stolen egg keeps its bloodline: species, genes, personality and lineage ride with the shell
    const egg = takeEggIntoPack(state, dev.speciesId, dev.child, isPopOwnedNest(nest.ownerId));
    if (!egg) {
      addLog(state, "Your pack already holds all the eggs it can carry — four is plenty.", "info");
      return waitTurn(state, 1);
    }
  } else state.bag.egg = (state.bag.egg ?? 0) + 1;
  takeEggFromNest(state, nest, devId);
  const owner = state.creatures[nest.ownerId];
  if (owner) {
    owner.known = true;
    owner.stalking = true;
    owner.calmUntil = 0;
    owner.disposition = "aggressive";
    addLog(state, `You slip a ${sp.name} egg into your pack. The ${sp.name} mother shrieks — she has your scent now!`, "bad");
  } else if (isPopOwnedNest(nest.ownerId)) {
    addLog(state, `You take an egg from the wild ${sp.name} nest. Somewhere out there, the flock will miss it.`, "event");
  } else {
    addLog(state, `The ${sp.name} nest sits abandoned. You take an egg without a fight.`, "good");
  }
  return waitTurn(state, 3);
}

function pickFoodFor(state: GameState, mon: Monster): ItemId | null {
  const sp = SPECIES[mon.speciesId];
  if ((state.bag[sp.likes] ?? 0) > 0 && ITEMS[sp.likes].food > 0) return sp.likes;
  let best: ItemId | null = null;
  let bestFood = 0;
  for (const [id, n] of Object.entries(state.bag) as [ItemId, number][]) {
    if (!n || ITEMS[id].diets.length === 0 || (id === "ore" && sp.diet !== "lithovore")) continue;
    const it = ITEMS[id];
    if (!it.diets.includes(sp.diet)) continue;
    if (it.food > bestFood) {
      best = id;
      bestFood = it.food;
    }
  }
  return best;
}

/** Feeds or doses a party/pen monster with an item. */
export function useItemOn(state: GameState, mon: Monster, item: ItemId): string {
  if ((state.bag[item] ?? 0) <= 0) return "You don't have any.";
  const it = ITEMS[item];
  const sp = SPECIES[mon.speciesId];
  const name = displayName(mon);
  const maxHp = statOf(mon, "hp");
  state.bag[item] = (state.bag[item] ?? 0) - 1;
  if (it.diets.length === 0) {
    // remedies: potions, cures and battle brews skip the diet check entirely
    mon.hp = Math.min(maxHp, mon.hp + it.heal);
    let extra = "";
    const fx = state.fighters[mon.uid];
    if (it.cures.length > 0 && fx && fx.statuses.length > 0) {
      const cured = fx.statuses.filter((s) => it.cures.includes(s.id)).map((s) => STATUSES[s.id].name.toLowerCase());
      if (cured.length > 0) {
        fx.statuses = fx.statuses.filter((s) => !it.cures.includes(s.id));
        extra += ` The ${cured.join(" and ")} clears.`;
      }
    }
    if (it.grants) {
      const st = state.fighters[mon.uid] ?? (state.fighters[mon.uid] = { statuses: [], cooldowns: {} });
      st.statuses = st.statuses.filter((s) => s.id !== it.grants);
      st.statuses.push({ id: it.grants, turns: 8 });
      extra += ` It braces itself for the coming fight. (${STATUSES[it.grants].name})`;
    }
    return `${name} drinks the ${it.name}. (+${it.heal} HP)${extra}`;
  }
  const dietOk = it.diets.includes(sp.diet);
  if (!dietOk && it.heal <= 0) {
    state.bag[item] = (state.bag[item] ?? 0) + 1;
    return `${name} sniffs the ${it.name.toLowerCase()} and turns away. (${sp.diet})`;
  }
  const liked = sp.likes === item;
  const food = Math.round(it.food * (dietOk ? 1 : 0.4));
  mon.satiety = Math.min(100, mon.satiety + food);
  let heal = it.heal;
  let line = `${name} ${liked ? "devours" : dietOk ? "eats" : "reluctantly nibbles"} the ${it.name.toLowerCase()}`;
  if (item === "mushroom" && state.player.origin !== "herbalist" && hash2(state.seed, state.tick, mon.level) % 6 === 0) {
    heal = -5;
    line += ". It disagrees with it badly. (-5 HP)";
  } else {
    line += liked ? " happily! (Bond +6)" : ".";
    if (liked) mon.bond = Math.min(100, mon.bond + 6);
    else if (dietOk) mon.bond = Math.min(100, mon.bond + 1);
  }
  mon.hp = clamp(mon.hp + heal, 0, maxHp);
  if (mon.hp === 0) mon.hp = 1;
  return line;
}

export function campRest(state: GameState, hours: number): ActionResult {
  const world = getWorld(state.seed);
  if (world.tile(state.player.x, state.player.y).biome === "river") {
    addLog(state, "You can't make camp in the middle of a river.", "info");
    return RESULT_NONE;
  }
  const nuts = state.bag.nuts ?? 0;
  if (nuts > 0) {
    state.bag.nuts = 0;
    state.bag.roasted_nuts = (state.bag.roasted_nuts ?? 0) + nuts;
    addLog(state, `You build a small fire and roast ${nuts} handful${nuts > 1 ? "s" : ""} of nuts. The smell carries.`, "good");
  } else addLog(state, "You build a small fire and settle in.", "info");
  const rate = state.player.origin === "wanderer" ? 0.12 : 0.08;
  for (let h = 0; h < hours; h++) {
    advance(state, 12);
    for (const m of state.party) {
      const max = statOf(m, "hp");
      if (m.hp > 0 || h >= 3) m.hp = Math.min(max, Math.max(m.hp, 0) + Math.ceil(max * rate));
    }
    if (partyCanFight(state)) {
      const raider = Object.values(state.creatures).find(
        (o) => o.disposition === "aggressive" && o.calmUntil <= state.tick && cheb(o.x, o.y, state.player.x, state.player.y) <= 2 && isAwake(o, timeOf(state.tick).hour, world.weather(state.player.x, state.player.y, state.tick).id),
      );
      if (raider) {
        addLog(state, "You wake to snapping twigs. Something has found your camp!", "bad");
        engage(state, raider.id, true);
        return { ok: true, engaged: raider.id };
      }
    }
  }
  for (const m of state.party) {
    if (m.satiety < 55) {
      const food = pickFoodFor(state, m);
      if (food) addLog(state, useItemOn(state, m, food), "good");
      else addLog(state, `${displayName(m)} looks at you hungrily. You have nothing it can eat.`, "bad");
    }
  }
  addLog(state, `You break camp, rested. (${hours}h)`, "system");
  return RESULT_OK;
}

export function hoursUntilDawn(tick: number): number {
  const t = timeOf(tick);
  const h = t.hour;
  return h < 6 ? 6 - h : 24 - h + 6;
}

export function innRest(state: GameState): string {
  if (state.player.gold < INN_COST) return "You can't afford a room.";
  state.player.gold -= INN_COST;
  advance(state, hoursUntilDawn(state.tick) * 12, true);
  for (const m of [...state.party, ...state.pen]) {
    m.hp = statOf(m, "hp");
    m.satiety = Math.max(m.satiety, 85);
  }
  addLog(state, "You sleep soundly at the inn. Your monsters are fed, healed and fussed over.", "good");
  return "Rested at the inn.";
}

export function buyItem(state: GameState, item: ItemId): string {
  const price = Math.ceil(ITEMS[item].value * 1.5);
  if (state.player.gold < price) return "Not enough gold.";
  state.player.gold -= price;
  state.bag[item] = (state.bag[item] ?? 0) + 1;
  return `Bought ${ITEMS[item].name} for ${price}g.`;
}

export function sellItem(state: GameState, item: ItemId): string {
  if ((state.bag[item] ?? 0) <= 0) return "Nothing to sell.";
  state.bag[item] = (state.bag[item] ?? 0) - 1;
  state.player.gold += ITEMS[item].value;
  return `Sold ${ITEMS[item].name} for ${ITEMS[item].value}g.`;
}

export { SHOP_STOCK };

export function searchRuin(state: GameState): ActionResult {
  const world = getWorld(state.seed);
  const f = world.tile(state.player.x, state.player.y).feature;
  if (!f || f.kind !== "ruin") return RESULT_NONE;
  const key = `ruin:${f.x},${f.y}`;
  if (state.depleted[key] !== undefined) {
    addLog(state, "You've already picked these ruins clean. Only dust and old echoes remain.", "info");
    return RESULT_NONE;
  }
  state.depleted[key] = state.tick;
  const rng = new Rng(hash2(state.seed ^ 0x2017, f.x, f.y));
  const gold = rng.int(15, 45);
  state.player.gold += gold;
  const loot: ItemId = rng.pick(["tonic", "ore", "honeycomb", "tonic", "ore"] as ItemId[]);
  state.bag[loot] = (state.bag[loot] ?? 0) + 1;
  addLog(state, `Beneath a cracked flagstone you find ${gold} gold and ${ITEMS[loot].name}.`, "good");
  if (rng.chance(0.4)) {
    const sp = rng.pick(["hollowcrow", "gloamoth", "cragjaw"]);
    const id = `g:${f.x}:${f.y}`;
    const lv = dangerLevel(world, f.x, f.y, "gloomwood", 1) + 1;
    // never inside the searcher's own body: hatch out on open ground nearby
    const spot = freeTileNear(state, f.x, f.y) ?? { x: f.x, y: f.y };
    const c = makeCreature(id, sp, spot.x, spot.y, lv, rng.int(1, 1e9), false);
    c.disposition = "aggressive";
    state.creatures[id] = c;
    addLog(state, `Something that was sleeping in the dark wakes up. A ${SPECIES[sp].name} unfolds from the shadows!`, "bad");
    if (partyCanFight(state)) {
      engage(state, id, true);
      return { ok: true, engaged: id };
    }
  }
  advance(state, 6);
  return RESULT_OK;
}

/** Ticks a wild body needs between feeding attempts: a 3 in-world hour cooldown (12 ticks per hour). */
export const FEED_COOLDOWN_TICKS = 36;

/** Offer food to an adjacent wild creature. May calm it, or win it over. */
export function offerFood(state: GameState, creatureId: string, item: ItemId): ActionResult {
  const c = state.creatures[creatureId];
  if (!c || (state.bag[item] ?? 0) <= 0) return RESULT_NONE;
  c.known = true;
  const sp = SPECIES[c.speciesId];
  const it = ITEMS[item];
  if (c.pack && state.creatures[c.pack]) {
    addLog(state, `The ${sp.name} looks to its alpha and refuses your offering.`, "info");
    advance(state, 1);
    return RESULT_OK;
  }
  if (c.feedUntil && c.feedUntil > state.tick) {
    const h = Math.max(1, Math.ceil((c.feedUntil - state.tick) / 12));
    addLog(state, `The ${sp.name} is still busy with its last meal. It won't take more food for about ${h}h.`, "info");
    advance(state, 1);
    return RESULT_OK;
  }
  state.bag[item] = (state.bag[item] ?? 0) - 1;
  state.seen[c.speciesId] = true;
  const liked = sp.likes === item;
  const dietOk = it.diets.includes(sp.diet);
  if (!dietOk) {
    addLog(state, `You toss the ${sp.name} some ${it.name.toLowerCase()}. It sniffs it and ignores it.`, "info");
    if (c.disposition === "aggressive" && c.calmUntil <= state.tick && partyCanFight(state)) {
      addLog(state, `The ${sp.name} takes it as an insult!`, "bad");
      engage(state, c.id, true);
      return { ok: true, engaged: c.id };
    }
    advance(state, 1);
    return RESULT_OK;
  }
  // a feeding attempt can go wrong: finicky bodies turn on the offerer instead
  // (favorites almost never backfire; anything else fails about one feed in ten)
  const failPct = liked ? 1 : 10;
  if (hash2(state.seed ^ 0xf3e9, state.tick, c.geneSeed) % 100 < failPct) {
    addLog(state, `The ${sp.name} jerks back from the ${it.name.toLowerCase()} — and lunges at you instead!`, "bad");
    c.disposition = "aggressive";
    c.stalking = true;
    c.feedUntil = state.tick + FEED_COOLDOWN_TICKS;
    if (partyCanFight(state)) {
      engage(state, c.id, true);
      return { ok: true, engaged: c.id };
    }
    advance(state, 1);
    return RESULT_OK;
  }
  // affection per feed is modest and divides by body size: titanic beasts are long campaigns
  const bulk = Math.max(1, footprintOf(sp));
  const base = (liked ? 26 : 13) + (c.satiety < 40 ? 8 : 0) + (PERSONALITIES[c.personality].tame * 60) - (c.alpha ? 10 : 0);
  const gain = Math.max(3, Math.round(base / bulk));
  c.affection = Math.min(120, c.affection + gain);
  c.satiety = Math.min(100, c.satiety + it.food);
  c.calmUntil = state.tick + 72;
  c.feedUntil = state.tick + FEED_COOLDOWN_TICKS;
  c.stalking = false;
  if (liked) addLog(state, `The ${sp.name} gobbles the ${it.name.toLowerCase()} and looks up at you, hopeful. It loves these!`, "good");
  else addLog(state, `The ${sp.name} eats the ${it.name.toLowerCase()} warily, watching you.`, "info");
  const rare = sp.rarity === "rare" || sp.rarity === "legendary";
  if (c.affection >= 100 && !c.alpha && !rare) {
    const mon = wildToMonster(state, c);
    mon.bond = 45;
    mon.origin = `Befriended with ${it.name.toLowerCase()}`;
    const where = recruit(state, mon);
    state.removed[c.id] = state.tick;
    abandonNestsOf(state, c.id);
    delete state.creatures[c.id];
    state.tamed[c.speciesId] = true;
    state.stats.tamed += 1;
    addLog(state, `The ${sp.name} decides to follow you. ${where}`, "good");
  } else if (c.affection >= 60) addLog(state, `The ${sp.name} edges closer. (Affection ${c.affection}/100)`, "good");
  advance(state, 1);
  return RESULT_OK;
}

export function wildToMonster(state: GameState, c: WildCreature): Monster {
  const world = getWorld(state.seed);
  const home = homeAnchor(state, c);
  const gloom = world.tile(home.x, home.y).biome === "gloomwood";
  const mon = createMonster(state, c.speciesId, c.level, {
    seed: c.geneSeed,
    // the wild creature's explicit genotype and lineage carry over — taming invents no biology
    genes: c.genes ?? wildGenotypeFromSeed(c.geneSeed, c.speciesId),
    personality: c.personality,
    mutations: rollMutations(new Rng(c.geneSeed ^ 0x77), gloom),
    origin: `Tamed in the ${world.regionName(home.x, home.y)} lands`,
    generation: c.gen ?? 1,
    lineageId: c.lineageId ?? founderLineage(c.id),
    sex: c.repro?.mode,
  });
  // the wild creature's reproductive state carries over too (maturity re-derived from level)
  if (c.repro) mon.repro = { ...c.repro, maturity: maturityFor(mon.level) };
  // its lifetime techniques carry over — the signature stays active and evolving
  if (c.sig) {
    mon.sig = { ...c.sig, mods: [...c.sig.mods], history: [...c.sig.history] };
    if (!mon.skills.includes(c.sig.baseId)) mon.skills.push(c.sig.baseId);
  }
  if (c.sigKnown?.length) {
    mon.sigKnown = c.sigKnown.map((s) => ({ ...s, mods: [...s.mods], history: [...s.history] }));
    for (const s of mon.sigKnown) if (!mon.skills.includes(s.uid)) mon.skills.push(s.uid);
  }
  mon.hp = Math.max(1, Math.round(statOf(mon, "hp") * c.hpFrac));
  mon.satiety = c.satiety;
  return mon;
}

/**
 * Player-initiated breeding at the shrine: validation through the mating rules,
 * then a reproductive-development record (egg or gestation). Parents survive;
 * the offspring is delivered when development completes.
 */
export function requestBreeding(state: GameState, aUid: string, bUid: string): BreedingOutcome {
  const all = [...state.party, ...state.pen];
  const a = all.find((m) => m.uid === aUid);
  const b = all.find((m) => m.uid === bUid);
  if (!a || !b) return { ok: false, reason: "invalid_pair" };
  const outcome = beginBreeding(state, a, b, "player");
  if (outcome.ok) {
    state.stats.synthesized += 1;
    const days = Math.max(1, Math.round((outcome.development.completeTick - outcome.development.startTick) / DAY_TICKS));
    const noun = days === 1 ? "day" : "days";
    addLog(
      state,
      outcome.nest
        ? `The shrine's green light settles over ${displayName(a)} and ${displayName(b)}. An egg rests in a nest nearby, ready in about ${days} ${noun}.`
        : `The shrine's green light settles over ${displayName(a)} and ${displayName(b)}. New life stirs, ready in about ${days} ${noun}.`,
      "good",
    );
    advance(state, 12, true);
  }
  return outcome;
}

/** Adds a monster to party or pen. Returns a description of where it went. */
export function recruit(state: GameState, mon: Monster): string {
  if (state.party.length < PARTY_MAX) {
    state.party.push(mon);
    return `${displayName(mon)} joins your party!`;
  }
  if (state.pen.length < PEN_MAX) {
    state.pen.push(mon);
    return `Your party is full, so ${displayName(mon)} heads to the pen at ${state.player.homeName}.`;
  }
  return `There's no room anywhere, so ${displayName(mon)} wanders off with a backward glance.`;
}

export function releaseMonster(state: GameState, uid: string): void {
  const m = [...state.party, ...state.pen].find((x) => x.uid === uid);
  if (!m) return;
  if (state.party.length === 1 && state.party[0] === m) return;
  state.party = state.party.filter((x) => x !== m);
  state.pen = state.pen.filter((x) => x !== m);
  addLog(state, `You release ${displayName(m)}. It lingers a moment, then trots off into the wild.`, "info");
}

export function swapPartyPen(state: GameState, uid: string): string {
  const inParty = state.party.find((m) => m.uid === uid);
  if (inParty) {
    if (state.party.length <= 1) return "You need at least one monster with you.";
    if (state.pen.length >= PEN_MAX) return "The pen is full.";
    state.party = state.party.filter((m) => m !== inParty);
    state.pen.push(inParty);
    return `${displayName(inParty)} goes to the pen.`;
  }
  const inPen = state.pen.find((m) => m.uid === uid);
  if (inPen) {
    if (state.party.length >= PARTY_MAX) return "Your party is full.";
    state.pen = state.pen.filter((m) => m !== inPen);
    state.party.push(inPen);
    return `${displayName(inPen)} joins your party.`;
  }
  return "";
}

export function moveInParty(state: GameState, uid: string, dir: -1 | 1): void {
  const i = state.party.findIndex((m) => m.uid === uid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.party.length) return;
  const t = state.party[i];
  state.party[i] = state.party[j];
  state.party[j] = t;
}

export function grantXpLines(mon: Monster, amount: number): string[] {
  return grantXp(mon, amount);
}
