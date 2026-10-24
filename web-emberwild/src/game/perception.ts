import { SPECIES } from "./data";
import { bodyFootprint } from "./growth";
import { CAVE_SIGHT, PROMINENCE_SIGHT, SURFACE, heightLOS, heightOf, layerOf, sameLayer } from "./height";
import type { GameState, WildCreature } from "./types";
import { type World, getWorld, timeOf } from "./world";

/**
 * Perception is the single query layer that answers "what can the player
 * (and their party) currently observe?". It is deliberately separate from
 * WorldKnowledge: perception is transient, knowledge persists.
 *
 * Future monster abilities (keen noses, flight, burrowing) should be expressed
 * as new PerceptionSource entries produced here — the fog-of-war and map
 * renderers only ever consume sources, never trait names.
 */
export interface PerceptionSource {
  /** Who is observing, e.g. "player" or "party:m3". */
  tag: string;
  x: number;
  y: number;
  /** Radius (tiles) at which terrain becomes revealed to knowledge. */
  radius: number;
  /** Radius (tiles) at which creatures are noticed. */
  creatureSight: number;
  /** Ignores line-of-sight blockers (flight, uncanny senses). */
  pierceTerrain: boolean;
}

/** How far the player can make out the world right now. */
export function sightRadius(state: GameState): number {
  const world = getWorld(state.seed);
  // underground there is no sun and no weather: only a short, close view
  if (layerOf(state) < SURFACE) return CAVE_SIGHT;
  const t = timeOf(state.tick);
  const w = world.weather(state.player.x, state.player.y, state.tick).id;
  let r = t.night ? 4 : t.phase === "Dusk" || t.phase === "Dawn" ? 7 : 10;
  // standing proud of the land around you lets you see farther
  r += heightOf(world).prominence(state.player.x, state.player.y) * PROMINENCE_SIGHT;
  if (w === "fog" || w === "sandstorm") r = Math.min(r, 3);
  else if (w === "storm" || w === "snow") r -= 2;
  else if (w === "rain") r -= 1;
  const tile = world.tile(state.player.x, state.player.y);
  if (tile.biome === "mountain" || tile.biome === "hills") r += 2;
  if (tile.biome === "forest" || tile.biome === "gloomwood" || tile.biome === "taiga") r -= 1;
  return Math.max(2, r);
}

/** Terrain that interrupts line of sight. */
export function blocksSight(biome: string): boolean {
  return biome === "peak" || biome === "mountain";
}

/**
 * Line of sight; endpoints are always visible to the observer. Terrain height
 * is checked first (cliffs hide what lies above and behind them; cave rock
 * blocks everything), then walls and sight-blocking biomes along the line.
 * `layer` defaults to the surface.
 */
export function hasLOS(world: World, x0: number, y0: number, x1: number, y1: number, pierceTerrain = false, layer = SURFACE): boolean {
  if (layer < SURFACE) return pierceTerrain || heightLOS(world, layer, x0, y0, x1, y1);
  if (pierceTerrain) return true;
  if (!heightLOS(world, layer, x0, y0, x1, y1)) return false;
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    if (!(x === x0 && y === y0) && !(x === x1 && y === y1)) {
      if (world.siteAt(x, y)?.wall) return false;
    }
    if (x === x1 && y === y1) return true;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * Every observer contributing to what the party notices right now. The player
 * is always present; healthy party monsters observe from their own bodies on
 * the live map, so scouts and night-eyed monsters genuinely extend sight from
 * wherever they stand.
 */
export function perceptionSources(state: GameState): PerceptionSource[] {
  const r = sightRadius(state);
  const out: PerceptionSource[] = [{ tag: "player", x: state.player.x, y: state.player.y, radius: r, creatureSight: r, pierceTerrain: false }];
  const time = timeOf(state.tick);
  const dark = time.night || time.phase === "Dusk";
  for (const m of state.party) {
    if (m.hp <= 0) continue;
    const pos = state.field[m.uid] ?? { x: state.player.x, y: state.player.y };
    const traits = SPECIES[m.speciesId].traits;
    if (dark && traits.includes("night_eyes")) {
      out.push({ tag: `party:${m.uid}`, x: pos.x, y: pos.y, radius: 0, creatureSight: Math.max(6, r), pierceTerrain: false });
    }
    if (traits.includes("flutter")) {
      const rr = Math.max(3, Math.min(r, 6));
      out.push({ tag: `party:${m.uid}`, x: pos.x, y: pos.y, radius: rr, creatureSight: rr, pierceTerrain: true });
    }
  }
  return out;
}

/** Union of every tile currently observable by the given sources. */
export function computeVisibleFrom(state: GameState, sources: PerceptionSource[]): Set<number> {
  const world = getWorld(state.seed);
  const layer = layerOf(state);
  const vis = new Set<number>();
  for (const src of sources) {
    if (src.radius <= 0) continue;
    const r = src.radius;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r + r) continue;
        const x = src.x + dx;
        const y = src.y + dy;
        if (!world.inBounds(x, y)) continue;
        if (vis.has(y * 4096 + x)) continue;
        if (dx === 0 && dy === 0) {
          vis.add(y * 4096 + x);
          continue;
        }
        if (hasLOS(world, src.x, src.y, x, y, src.pierceTerrain, layer)) vis.add(y * 4096 + x);
      }
    }
  }
  return vis;
}

/** Can the player personally observe this tile right now? */
export function seesTile(state: GameState, x: number, y: number): boolean {
  const src = perceptionSources(state).find((s) => s.tag === "player");
  if (!src) return false;
  const dx = x - src.x;
  const dy = y - src.y;
  if (dx * dx + dy * dy > src.radius * src.radius + src.radius) return false;
  if (dx === 0 && dy === 0) return true;
  return hasLOS(getWorld(state.seed), src.x, src.y, x, y, src.pierceTerrain, layerOf(state));
}

/** Can the party notice this creature right now (any perception source, any body tile)? */
export function seesCreature(state: GameState, c: WildCreature): boolean {
  if (!sameLayer(state, c)) return false;
  const world = getWorld(state.seed);
  const layer = layerOf(state);
  const fp = bodyFootprint(c, state.tick);
  for (const src of perceptionSources(state)) {
    if (src.creatureSight <= 0) continue;
    for (let dy = 0; dy < fp; dy++) {
      for (let dx = 0; dx < fp; dx++) {
        const cx = c.x + dx;
        const cy = c.y + dy;
        const ddx = cx - src.x;
        const ddy = cy - src.y;
        if (ddx * ddx + ddy * ddy > src.creatureSight * src.creatureSight + src.creatureSight) continue;
        if (ddx === 0 && ddy === 0) return true;
        if (hasLOS(world, src.x, src.y, cx, cy, src.pierceTerrain, layer)) return true;
      }
    }
  }
  return false;
}
