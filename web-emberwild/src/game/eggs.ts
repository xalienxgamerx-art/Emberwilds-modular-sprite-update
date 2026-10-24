/**
 * Carried eggs — stolen eggs as living cargo.
 *
 * Stealing a nest egg captures its ChildBlueprint (species, genes, mutations,
 * personality, skills, parentage, lineage), so the unborn creature's whole
 * inheritance rides with the shell. The egg incubates over a species-dependent
 * span (big bodies take longer, mirroring how they grow up slower), then the
 * game prompts: keep — the hatchling is tamed through the exact bred-baby birth
 * path — or release it to live on as a wild, persistent individual. Eggs are
 * food only by choice: they live outside the bag, so every bag-scanning feeder
 * skips them.
 */
import { EGG_TICKS, deliverPlayerOffspring, freeTileNear } from "./breeding";
import { DAY_TICKS, ITEMS, SPECIES, footprintOf } from "./data";
import { ecoOnBirth } from "./ecology";
import { SPAN_PER_CLASS } from "./growth";
import { addLog } from "./log";
import { recordLineageBirth } from "./lineage";
import { makeReproProfile } from "./reproduction";
import { Rng, hashString } from "./rng";
import type { CarriedEgg, ChildBlueprint, GameState, ReproductiveDevelopment, WildCreature } from "./types";

/** How many stolen eggs the pack can carry at once. */
export const PACK_EGG_CAP = 4;

/**
 * Incubation for a carried egg: a small species hatches in about two in-world
 * days; bigger bodies take proportionally longer (a titanic wyrm needs roughly
 * four), using the same per-footprint scaling growth already uses.
 */
export function incubationTicks(speciesId: string): number {
  return Math.round(EGG_TICKS * (1 + (footprintOf(SPECIES[speciesId]) - 1) * SPAN_PER_CLASS));
}

/** The pack's carried eggs (backfilled for older saves). */
export function carriedEggs(gs: GameState): CarriedEgg[] {
  return (gs.eggs ??= []);
}

/** True once an egg has finished incubating. */
export const eggReady = (gs: GameState, egg: CarriedEgg): boolean => gs.tick >= egg.hatchTick;

/** Incubation progress 0..1 for the bag's slow-filling bar. */
export function eggProgress(gs: GameState, egg: CarriedEgg): number {
  const span = Math.max(1, egg.hatchTick - egg.stolenTick);
  return Math.max(0, Math.min(1, (gs.tick - egg.stolenTick) / span));
}

/** Idempotent save migration: older saves simply have no carried eggs yet. */
export function migrateEggs(gs: GameState): void {
  gs.eggs = gs.eggs ?? [];
}

/** Puts a stolen nest egg into the pack — bloodline and all. Returns null when the pack is full. */
export function takeEggIntoPack(state: GameState, speciesId: string, child: ChildBlueprint, nursery: boolean): CarriedEgg | null {
  const eggs = carriedEggs(state);
  if (eggs.length >= PACK_EGG_CAP) return null;
  state.broodSeq += 1;
  const egg: CarriedEgg = {
    id: `e${state.broodSeq.toString(36)}`,
    speciesId,
    child,
    stolenTick: state.tick,
    hatchTick: state.tick + incubationTicks(speciesId),
    nursery,
  };
  eggs.push(egg);
  return egg;
}

/** Incubation follows the clock: each ready egg announces itself once. */
export function advanceEggs(state: GameState): void {
  for (const egg of carriedEggs(state)) {
    if (!egg.announced && state.tick >= egg.hatchTick) {
      egg.announced = true;
      addLog(state, `The ${SPECIES[egg.speciesId].name} egg in your pack is shivering — it is ready to hatch.`, "event");
      break; // one announcement per tick keeps the log calm
    }
  }
}

/** What you choose to do with a ready egg. */
export type HatchChoice = "keep" | "release";

/** Removes a carried egg from the pack (for eating or hand-feeding). */
export function removeCarriedEgg(state: GameState, eggId: string): CarriedEgg | null {
  const eggs = carriedEggs(state);
  const i = eggs.findIndex((e) => e.id === eggId);
  return i >= 0 ? eggs.splice(i, 1)[0] : null;
}

/** Puts off a hatch prompt — the shell keeps until you return to it (bag or Hatch button). */
export function postponeHatch(state: GameState, eggId: string): void {
  const egg = carriedEggs(state).find((e) => e.id === eggId);
  if (egg) egg.prompted = true;
}

/**
 * Acts on a carried egg. Keep runs the exact bred-baby birth path (party, else
 * pen; the egg waits in its shell if the brood is full) and the hatchling is
 * tamed from the shell with an imprinted bond. Release spawns it beside you as
 * a wild, persistent individual — curious, imprinted on you, easier to befriend
 * — registered in the local ecology like any nest hatch. Returns a toast line,
 * or "" when the birth already spoke for itself.
 */
export function hatchCarriedEgg(state: GameState, eggId: string, choice: HatchChoice): string {
  const eggs = carriedEggs(state);
  const egg = eggs.find((e) => e.id === eggId);
  if (!egg) return "That egg is no longer in your pack.";
  if (state.tick < egg.hatchTick) {
    const days = Math.max(1, Math.ceil((egg.hatchTick - state.tick) / DAY_TICKS));
    return `The egg needs more time — about ${days} more ${days === 1 ? "day" : "days"}.`;
  }
  const child = egg.child;
  if (choice === "keep") {
    // the shared birth path: a transient development record carries the blueprint in
    const dev: ReproductiveDevelopment = {
      id: egg.id,
      parentIds: [...(child.parents ?? [egg.id, egg.id])],
      speciesId: child.speciesId,
      pairing: "sexual",
      type: "egg",
      state: "developing",
      startTick: egg.stolenTick,
      completeTick: egg.hatchTick,
      origin: "player",
      child,
    };
    if (!deliverPlayerOffspring(state, dev)) return "There is no room at your side or in the pen — the hatchling waits in its shell.";
    const mon = [...state.party, ...state.pen].find((m) => m.uid === dev.resultId);
    if (mon) mon.bond = Math.max(mon.bond, 60); // imprinted at first sight: tamed from the shell
    addLog(state, "It imprints on you the moment it cracks free — tamed from the shell.", "good");
    eggs.splice(eggs.indexOf(egg), 1);
    return "";
  }
  // release: an imprinted hatchling beside you, then out into the wilds
  const spot = freeTileNear(state, state.player.x, state.player.y) ?? { x: state.player.x, y: state.player.y };
  const id = `b:${state.tick}:${(hashString(egg.id) >>> 0).toString(36)}`;
  const baby: WildCreature = {
    id,
    speciesId: child.speciesId,
    level: child.level,
    x: spot.x,
    y: spot.y,
    homeX: spot.x,
    homeY: spot.y,
    hpFrac: 1,
    satiety: 62,
    disposition: "curious",
    activity: "Wandering",
    personality: child.personality,
    geneSeed: hashString(egg.id) % 2_000_000_000,
    genes: child.genes,
    gen: child.generation,
    lineageId: child.lineageId,
    bornTick: state.tick,
    parents: [...(child.parents ?? [])],
    mutHistory: child.mutHistory,
    repro: makeReproProfile(child.sex, child.level, state.tick),
    calmUntil: 0,
    alpha: false,
    known: true, // released into the wild, but it stays a real individual for the world's life
    affection: 45, // imprinted: it arrives most of the way to trusting you
    stalking: false,
  };
  state.creatures[id] = baby;
  state.seen[child.speciesId] = true;
  ecoOnBirth(state, child.speciesId, spot.x, spot.y, true);
  recordLineageBirth(state, baby, child.parents ?? []);
  eggs.splice(eggs.indexOf(egg), 1);
  addLog(state, `You crack the shell. The tiny ${SPECIES[child.speciesId].name} imprints on you at first sight, chirps once, and wanders into the wilds — wild and free, but it will remember you.`, "event");
  return "";
}

/** Sacrifices a carried egg for its food value — food now, bloodline never. */
export function eatCarriedEgg(state: GameState, eggId: string): string {
  const egg = removeCarriedEgg(state, eggId);
  if (!egg) return "That egg is no longer in your pack.";
  state.bag.egg = (state.bag.egg ?? 0) + 1;
  addLog(state, `You sacrifice the ${SPECIES[egg.speciesId].name} egg. Food now, bloodline never.`, "info");
  return `${ITEMS.egg.name} added to your bag.`;
}
