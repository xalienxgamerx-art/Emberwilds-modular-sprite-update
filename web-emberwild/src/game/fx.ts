import { ELEMENTS } from "./data";
import type { Element } from "./types";

/**
 * Cosmetic effect events for the map's animated overlay. Purely decorative:
 * nothing here reads or writes game state and the seeded RNG is never touched,
 * so simulation determinism is unaffected. Events are aged by wall-clock time
 * and pruned when old.
 */

/** The map renderer's view of the world, published on every redraw. */
export interface MapCamera {
  /** Which map scale is on screen. */
  scale: "local" | "region" | "world";
  /** Viewport size in CSS pixels. */
  w: number;
  h: number;
  /** Center of the view in world tile coordinates (includes pan). */
  cx: number;
  cy: number;
  /** Rendered cell size in pixels. */
  ts: number;
  /** World tiles per rendered cell (1 at local scale). */
  cell: number;
  /** Map layer: 0 surface, negative underground. */
  layer: number;
}

/** The map renderer writes its camera here each redraw; the effects overlay reads it. */
export const mapCamera: MapCamera = { scale: "local", w: 0, h: 0, cx: 0, cy: 0, ts: 32, cell: 1, layer: 0 };

export type FxKind = "beam" | "burst" | "ring" | "puff" | "flash" | "motes" | "ignite" | "ash" | "bolt";

export interface BurstFx {
  id: number;
  kind: FxKind;
  color: string;
  /** Focus tile (beam start, burst center). */
  x: number;
  y: number;
  /** Beam end tile. */
  x1?: number;
  y1?: number;
  /** Tiles covered by an area ring. */
  tiles?: [number, number][];
  /** Wall-clock milliseconds when the event fired (may be in the future for scheduled projectile impacts). */
  at: number;
}

/** How long each effect kind stays on screen (ms). */
export const BURST_LIFE: Record<FxKind, number> = { beam: 450, burst: 600, ring: 520, puff: 700, flash: 320, motes: 900, ignite: 620, ash: 1400, bolt: 900 };

const MAX_BURSTS = 48;
const bursts: BurstFx[] = [];
let fxSeq = 0;

export const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The color a skill's element glows with. */
export const elementColor = (el: Element): string => ELEMENTS[el].color;

/**
 * Records a cosmetic effect event. Safe to call from simulation code: it never
 * touches game state or the seeded RNG. Pass `at` to schedule the event for a
 * future moment (a projectile's impact); it stays hidden until then.
 */
export function pushBurst(kind: FxKind, x: number, y: number, color: string, extra?: { x1?: number; y1?: number; tiles?: [number, number][] }, at?: number): void {
  fxSeq += 1;
  bursts.push({ id: fxSeq, kind, x, y, color, x1: extra?.x1, y1: extra?.y1, tiles: extra?.tiles, at: at ?? nowMs() });
  if (bursts.length > MAX_BURSTS) bursts.splice(0, bursts.length - MAX_BURSTS);
}

/** Burst effects still young enough to render (prunes older ones in place). */
export function activeBursts(): BurstFx[] {
  const now = nowMs();
  let keep = 0;
  for (let i = 0; i < bursts.length; i++) {
    const b = bursts[i];
    if (now - b.at <= BURST_LIFE[b.kind]) bursts[keep++] = b;
  }
  bursts.length = keep;
  return bursts;
}

/* ------------------------------- Projectiles -------------------------------- */

/** A flying ranged attack: a glowing bolt from a tile to a landing tile. */
export interface ProjectileFx {
  id: number;
  color: string;
  /** Launch point in tile coordinates (fractional, body center). */
  x: number;
  y: number;
  /** Landing point in tile coordinates. */
  x1: number;
  y1: number;
  /** Wall-clock launch time. */
  at: number;
  /** Flight duration in milliseconds. */
  fly: number;
}

const MAX_PROJECTILES = 24;
const projectiles: ProjectileFx[] = [];

/**
 * Launches a projectile from one point to another and returns its flight time
 * in milliseconds — the caller schedules impact visuals at now + flight.
 * Close shots are snappy; long shots hang in the air a little longer.
 */
export function pushProjectile(x: number, y: number, x1: number, y1: number, color: string): number {
  const dist = Math.max(Math.abs(x1 - x), Math.abs(y1 - y));
  const fly = Math.round(Math.min(720, 130 + dist * 62));
  fxSeq += 1;
  projectiles.push({ id: fxSeq, color, x, y, x1, y1, at: nowMs(), fly });
  if (projectiles.length > MAX_PROJECTILES) projectiles.splice(0, projectiles.length - MAX_PROJECTILES);
  return fly;
}

/** Projectiles still in flight (prunes landed ones in place). */
export function activeProjectiles(): ProjectileFx[] {
  const now = nowMs();
  let keep = 0;
  for (let i = 0; i < projectiles.length; i++) {
    const p = projectiles[i];
    if (now - p.at <= p.fly) projectiles[keep++] = p;
  }
  projectiles.length = keep;
  return projectiles;
}

/* ---------------------------- Movement animation ----------------------------- */

interface MoveFx {
  /** Tile the body came from. */
  fx: number;
  fy: number;
  /** Tile it stands on now. */
  tx: number;
  ty: number;
  at: number;
  ms: number;
}

const MAX_MOVES = 80;
const moves = new Map<string, MoveFx>();

/**
 * Records a body's step from one tile to another so the renderer can slide it
 * between the two instead of snapping. Purely visual.
 */
export function pushMove(who: string, fx: number, fy: number, tx: number, ty: number): void {
  const dist = Math.max(Math.abs(tx - fx), Math.abs(ty - fy));
  moves.set(who, { fx, fy, tx, ty, at: nowMs(), ms: Math.min(340, 70 + dist * 55) });
  if (moves.size > MAX_MOVES) {
    // drop the oldest entries (insertion order)
    const it = moves.keys();
    for (let i = 0; i < moves.size - MAX_MOVES; i++) {
      const k = it.next().value;
      if (k !== undefined) moves.delete(k);
    }
  }
}

/** Tile-space offset (dx, dy) a body should still be drawn at, or 0,0 once it has arrived. */
export function moveOffset(who: string): { dx: number; dy: number } {
  const m = moves.get(who);
  if (!m) return { dx: 0, dy: 0 };
  const p = (nowMs() - m.at) / m.ms;
  if (p >= 1) {
    moves.delete(who);
    return { dx: 0, dy: 0 };
  }
  const q = 1 - p;
  return { dx: (m.fx - m.tx) * q, dy: (m.fy - m.ty) * q };
}
