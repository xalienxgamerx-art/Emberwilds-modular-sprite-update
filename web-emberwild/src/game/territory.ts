/**
 * The Territory system — the one authoritative representation of a wild
 * population's ecological home range.
 *
 * Territories are persistent world state with identity: they outlive the
 * individual creatures that currently occupy them, so a population can unload
 * and reload without its home range vanishing. Ownership migrates from the
 * legacy alpha/home-range behavior — the dominant individual becomes the
 * territory holder; other members recognize the territory as home.
 *
 * Wildlife AI asks this system for information (anchor, leash, ownership);
 * it never derives home-range state from monster fields directly. The legacy
 * homeX/homeY fields remain as transitional save-compat anchors, read only
 * when a creature has no territory yet — never as a competing source of truth.
 *
 * Phase 6 foundations: establish/defend groundwork (ownership), quality from
 * existing environmental data, and nest↔territory references by id. Contest,
 * expansion and population ecology are later phases.
 */
import { BIOMES, SPECIES } from "./data";
import { SKY } from "./height";
import type { GameState, Nest, Territory, WildCreature } from "./types";
import { getWorld, type World } from "./world";

/** Home-range radius (chebyshev, tiles) of a founded territory. */
export const TERRITORY_RADIUS = 10;
/** How far a creature looks for an existing same-species territory before founding one. */
export const TERRITORY_JOIN_R = 16;
/** Quality sampling: the center plus a ring at the radius (9 points). */
const QUALITY_SAMPLES: [number, number][] = [
  [0, 0],
  [1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071],
];
/** Quality weights derived from existing biome data (no resource simulation yet). */
const QUALITY_FORAGE = 45;
const QUALITY_DENSITY = 15;
const QUALITY_WATER = 12;

/**
 * Environmental quality 0–100, derived from the data that already exists:
 * biome forage tables, forage reliability, creature density and nearby water.
 * Deterministic and side-effect free — a later resource simulation replaces
 * the body of this function without changing its interface.
 */
export function territoryQuality(world: World, x: number, y: number, radius = TERRITORY_RADIUS): number {
  let score = 0;
  let water = 0;
  for (const [fx, fy] of QUALITY_SAMPLES) {
    const tx = Math.round(x + fx * radius);
    const ty = Math.round(y + fy * radius);
    if (!world.inBounds(tx, ty)) continue;
    const b = BIOMES[world.tile(tx, ty).biome];
    if (!b.passable) {
      water++;
      continue;
    }
    const forageWeight = b.forage.reduce((sum, [, w]) => sum + w, 0);
    score += QUALITY_FORAGE / QUALITY_SAMPLES.length * Math.min(1, b.forageChance * 2 + forageWeight / 12) + QUALITY_DENSITY / QUALITY_SAMPLES.length * b.density;
  }
  if (water > 0) score += QUALITY_WATER;
  return Math.max(0, Math.min(100, Math.round(score)));
}

const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

const layerKey = (l: number | undefined): number => l ?? 0;

/** Creates a persistent territory with stable identity. */
export function createTerritory(state: GameState, speciesId: string, x: number, y: number, ownerId?: string, layer?: number): Territory {
  state.territorySeq += 1;
  const t: Territory = {
    id: `t${state.territorySeq.toString(36)}`,
    speciesId,
    x,
    y,
    radius: TERRITORY_RADIUS,
    quality: territoryQuality(getWorld(state.seed), x, y, TERRITORY_RADIUS),
    nestIds: [],
    createdAt: state.tick,
  };
  if (ownerId) t.ownerId = ownerId;
  if (layer) t.layer = layer;
  state.territories[t.id] = t;
  return t;
}

/**
 * The territory containing a tile on a layer, if any (territories are few; a linear scan is cheap).
 * A flying species' range is a column: the sky above it belongs to the same territory as the ground below.
 */
export function territoryAt(state: GameState, x: number, y: number, layer?: number): Territory | null {
  for (const t of Object.values(state.territories)) {
    const sameBand = layerKey(t.layer) === layerKey(layer) || (layer === SKY && SPECIES[t.speciesId]?.traits?.includes("flutter"));
    if (sameBand && cheb(x, y, t.x, t.y) <= t.radius) return t;
  }
  return null;
}

/** A creature's territory, if it has a live one. */
export function territoryOf(state: GameState, c: WildCreature): Territory | null {
  return c.territoryId ? state.territories[c.territoryId] ?? null : null;
}

/**
 * Attaches a creature to its ecological home range: its existing territory, a
 * same-species territory covering its position (joining — packs and neighbors
 * share), else a newly founded one. Alphas found and claim. Deterministic.
 */
export function ensureTerritory(state: GameState, c: WildCreature, anchor?: { x: number; y: number }): Territory {
  const existing = territoryOf(state, c);
  if (existing) return existing;
  const at = anchor ?? { x: c.x, y: c.y };
  for (const t of Object.values(state.territories)) {
    if (t.speciesId !== c.speciesId || layerKey(t.layer) !== layerKey(c.layer) || cheb(at.x, at.y, t.x, t.y) > TERRITORY_JOIN_R) continue;
    c.territoryId = t.id;
    if (c.alpha && !t.ownerId) t.ownerId = c.id;
    return t;
  }
  const t = createTerritory(state, c.speciesId, at.x, at.y, c.alpha ? c.id : undefined, c.layer);
  c.territoryId = t.id;
  return t;
}

/**
 * Links a nest into the territory fabric: the territory containing the nest,
 * else the owner's territory, else a fresh ownerless territory at the nest.
 * Nests and territories stay separate systems connected only by ids.
 */
export function attachNest(state: GameState, nest: Nest, ownerId?: string): void {
  let t = territoryAt(state, nest.x, nest.y, nest.layer);
  if (!t && ownerId) {
    const owner = findWildBody(state, ownerId);
    if (owner && layerKey(owner.layer) === layerKey(nest.layer)) t = territoryOf(state, owner);
  }
  if (!t) t = createTerritory(state, nest.speciesId, nest.x, nest.y, undefined, nest.layer);
  if (nest.territoryId && nest.territoryId === t.id) return;
  if (nest.territoryId) {
    const prev = state.territories[nest.territoryId];
    if (prev) prev.nestIds = prev.nestIds.filter((id) => id !== nest.id);
  }
  nest.territoryId = t.id;
  if (!t.nestIds.includes(nest.id)) t.nestIds.push(nest.id);
}

function findWildBody(state: GameState, id: string): WildCreature | null {
  return state.creatures[id] ?? null;
}
/**
 * A body died or left the world: release any territory it owned. The territory
 * itself persists — ownership lapses and the range becomes contestable.
 */
export function releaseTerritoryOwner(state: GameState, id: string): void {
  for (const t of Object.values(state.territories)) {
    if (t.ownerId === id) {
      t.ownerId = undefined;
      t.contested = true;
    }
  }
}

/**
 * The creature's home anchor: its territory center when it has one, else the
 * legacy homeX/homeY fields. This is the explicit transitional compatibility
 * layer — new state always uses territories; old creatures read the legacy
 * anchor until migration attaches them.
 */
export function homeAnchor(state: GameState, c: WildCreature): { x: number; y: number } {
  const t = territoryOf(state, c);
  return t ? { x: t.x, y: t.y } : { x: c.homeX, y: c.homeY };
}

/**
 * Whole-state backfill for older saves and freshly spawned populations —
 * idempotent, safe to run on every load. Alphas are attached first so packs
 * join their master's range; dangling references are pruned, never invented.
 */
export function migrateTerritories(gs: GameState): void {
  gs.territories = gs.territories ?? {};
  gs.territorySeq = gs.territorySeq ?? 0;
  for (const t of Object.values(gs.territories)) {
    t.nestIds = t.nestIds.filter((id) => gs.nests[id]?.territoryId === t.id);
    if (t.ownerId && !findAnyBody(gs, t.ownerId)) {
      t.ownerId = undefined;
      t.contested = true;
    }
  }
  for (const nest of Object.values(gs.nests)) {
    if (nest.territoryId && !gs.territories[nest.territoryId]) nest.territoryId = undefined;
    const holder = gs.territories[nest.territoryId ?? ""];
    if (!holder || cheb(nest.x, nest.y, holder.x, holder.y) > holder.radius) attachNest(gs, nest, nest.ownerId);
    else if (!holder.nestIds.includes(nest.id)) holder.nestIds.push(nest.id);
  }
  const bodies = Object.values(gs.creatures);
  for (const c of bodies.filter((b) => b.alpha)) ensureTerritory(gs, c, { x: c.homeX, y: c.homeY });
  for (const c of bodies) ensureTerritory(gs, c, { x: c.homeX, y: c.homeY });
}

function findAnyBody(gs: GameState, id: string): boolean {
  return !!gs.creatures[id] || gs.party.some((m) => m.uid === id) || gs.pen.some((m) => m.uid === id);
}
