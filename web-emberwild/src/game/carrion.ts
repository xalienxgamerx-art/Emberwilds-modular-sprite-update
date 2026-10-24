/**
 * Carrion — the meat layer of the food web (Phase 12).
 *
 * When a wild body dies it leaves remains at the spot where it fell. Remains
 * are real map objects: hungry carnivores and omnivores smell them, walk over
 * and feed (each body yields portions sized by its footprint), and after a
 * fixed lifespan whatever is left rots away. Nothing here decides ecology —
 * deaths stay with their existing causes; this module only places, feeds and
 * expires the leftovers.
 *
 * Distant regions (Phase 11) intentionally have no carrion: abstract
 * populations already price scavenging into their mortality, and no bodies
 * exist off-screen to leave remains.
 */
import { DAY_TICKS, SPECIES, footprintOf } from "./data";
import { bodyFootprint } from "./growth";
import { layerOf } from "./height";
import type { Carrion, GameState, WildCreature } from "./types";

/** Days before uneaten remains rot away. */
export const CARRION_DAYS = 2;
/** Technical cap on tracked remains (performance; oldest rot first). */
export const CARRION_CAP = 80;
/** How far a hungry scavener smells remains (chebyshev tiles). */
export const CARRION_SIGHT = 7;
/** Satiety gained per portion eaten. */
export const SCAVENGE_FOOD = 46;

const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

function ensureCarrion(gs: GameState): Record<string, Carrion> {
  if (!gs.carrion) gs.carrion = {};
  if (gs.carrionSeq === undefined) gs.carrionSeq = 0;
  return gs.carrion;
}

/** A wild body fell: its remains appear where it lies. */
export function spawnCarrion(gs: GameState, c: WildCreature): Carrion | null {
  const all = ensureCarrion(gs);
  const fp = Math.max(bodyFootprint(c, gs.tick), footprintOf(SPECIES[c.speciesId]));
  const item: Carrion = {
    id: `ca:${gs.carrionSeq++}`,
    speciesId: c.speciesId,
    x: c.x,
    y: c.y,
    layer: c.layer,
    born: gs.tick,
    portions: fp >= 4 ? 3 : fp >= 2 ? 2 : 1,
  };
  all[item.id] = item;
  // technical cap: the oldest remains rot first
  const keys = Object.keys(all);
  if (keys.length > CARRION_CAP) {
    keys.sort((a, b) => all[a].born - all[b].born);
    for (const k of keys.slice(0, keys.length - CARRION_CAP)) delete all[k];
  }
  return item;
}

/** Deletes remains past their lifespan; cheap, runs every tick. */
export function rotTick(gs: GameState): void {
  const all = gs.carrion;
  if (!all) return;
  const expires = gs.tick - CARRION_DAYS * DAY_TICKS;
  for (const id of Object.keys(all)) if (all[id].born <= expires) delete all[id];
}

/** The nearest remains a scavenger can smell (same layer as the player's, within `r`, food left). */
export function nearestCarrion(gs: GameState, c: WildCreature, r: number): Carrion | null {
  const all = gs.carrion;
  if (!all) return null;
  const here = layerOf(gs);
  let best: Carrion | null = null;
  let bestD = r + 1;
  for (const item of Object.values(all)) {
    if (item.portions <= 0) continue;
    if ((item.layer ?? 0) !== here) continue;
    const d = cheb(item.x, item.y, c.x, c.y);
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

/** One portion is eaten; the remains vanish with the last bite. */
export function eatCarrion(gs: GameState, id: string): void {
  const item = gs.carrion?.[id];
  if (!item) return;
  item.portions -= 1;
  if (item.portions <= 0) delete gs.carrion![id];
}

/** Backfills carrion state for older saves — idempotent, runs on every load. */
export function migrateCarrion(gs: GameState): void {
  ensureCarrion(gs);
}

/** Current rot stage: 0 fresh, 1 aging (drawn darker, flavored in logs). */
export function carrionStage(gs: GameState, item: Carrion): 0 | 1 {
  const age = gs.tick - item.born;
  return age > (CARRION_DAYS * DAY_TICKS) / 2 ? 1 : 0;
}

/** The nearest remains to a map position (player's layer, within `r`, food left). */
export function carrionNear(gs: GameState, x: number, y: number, r = 1): Carrion | null {
  const all = gs.carrion;
  if (!all) return null;
  const here = layerOf(gs);
  let best: Carrion | null = null;
  let bestD = r + 1;
  for (const item of Object.values(all)) {
    if (item.portions <= 0) continue;
    if ((item.layer ?? 0) !== here) continue;
    const d = cheb(item.x, item.y, x, y);
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

/** Butchers remains into bag meat: a fresh kill yields every portion, aging ones less. */
export function dressCarrionAt(gs: GameState, id: string): number {
  const item = ensureCarrion(gs)[id];
  if (!item) return 0;
  const got = Math.max(1, item.portions - carrionStage(gs, item));
  delete gs.carrion![id];
  return got;
}
