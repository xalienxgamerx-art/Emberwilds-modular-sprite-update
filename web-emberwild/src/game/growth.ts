/**
 * Growth & physical size (Phase 8) — the lifecycle layer between genetics and
 * the world.
 *
 * Pipeline (one direction, no shortcuts):
 *
 *   genetics (size alleles)  →  mature phenotype (expressed size)
 *   →  growth stage (newborn / juvenile / mature / elder)
 *   →  physical size  →  footprint class, stat scaling, food & space demand
 *
 * Combat, movement, rendering, reproduction and ecology consume these results
 * through the exported helpers; none of them compute size themselves. All
 * thresholds and scaling weights live in the constants block so balance is a
 * tuning exercise, not a rewrite.
 *
 * Compatibility: a body without growth data (`bornTick === undefined`, the
 * state of every wild adult and every pre-Phase-8 save) is treated as mature,
 * and a mature body's footprint is exactly what `sizeToFootprint` always
 * produced — so existing saves, rendering and placement are unchanged.
 */
import { DAY_TICKS, SPECIES, footprintOf } from "./data";
import { expressGene } from "./genetics";
import { MATURITY_LEVEL } from "./reproduction";
import type { GameState, Genome } from "./types";

export type LifeStage = "newborn" | "juvenile" | "mature" | "elder";

/* --------------------------------- Config ----------------------------------- */

/** Newborn window (half an in-world day). */
export const NEWBORN_TICKS = 144;
/** Base juvenile growth span; larger species take proportionally longer. */
export const JUVENILE_TICKS = 4 * DAY_TICKS;
/** Extra juvenile span per footprint class above 1 (big species grow up slowly). */
export const SPAN_PER_CLASS = 0.3;
/** Age (ticks) at which an individual becomes an elder. */
export const ELDER_AGE_TICKS = 45 * DAY_TICKS;
/** A newborn's physical size as a fraction of its mature size. */
export const NEWBORN_SIZE_MUL = 0.24;
/** Elder physical-capability modifier (applied to hp/atk/def in stat scaling). */
export const ELDER_STAT_MUL = 0.94;
/** Expressed size alleles per tile unit of physical size (class boundary every 25). */
export const SIZE_PER_TILE = 25;
/**
 * The centralized footprint thresholds: physical size ≥ n tiles → (n+1)×(n+1).
 * These reproduce `sizeToFootprint`'s boundaries exactly on the mature axis.
 */
export const FOOTPRINT_THRESHOLDS = [1, 2, 3] as const;
/** Immature stat floor (newborns): fraction of mature hp/atk/def. */
export const NEWBORN_STAT_MUL = 0.55;

/* ------------------------------- Lifecycle ---------------------------------- */

/** Juvenile growth span for a species — big bodies take longer to mature. */
export function growthSpan(speciesId: string): number {
  return JUVENILE_TICKS * (1 + (footprintOf(SPECIES[speciesId]) - 1) * SPAN_PER_CLASS);
}

/** Total age at which a species reaches maturity. */
export const matureAgeOf = (speciesId: string): number => NEWBORN_TICKS + growthSpan(speciesId);

export interface GrowthInfo {
  stage: LifeStage;
  /** 0..1 progress through the juvenile growth window (1 when grown). */
  progress: number;
  /** Age in ticks (Infinity for bodies without growth data — spawned adults, legacy saves). */
  age: number;
}

/** A body's growth state. No `bornTick` means mature: the legacy/spawned-adult default. */
export function growthOf(bornTick: number | undefined, speciesId: string, tick: number): GrowthInfo {
  if (bornTick === undefined) return { stage: "mature", progress: 1, age: Infinity };
  const age = Math.max(0, tick - bornTick);
  if (age < NEWBORN_TICKS) return { stage: "newborn", progress: 0, age };
  const span = growthSpan(speciesId);
  if (age < NEWBORN_TICKS + span) return { stage: "juvenile", progress: (age - NEWBORN_TICKS) / span, age };
  if (age < ELDER_AGE_TICKS) return { stage: "mature", progress: 1, age };
  return { stage: "elder", progress: 1, age };
}

export const stageOf = (bornTick: number | undefined, speciesId: string, tick: number): LifeStage =>
  growthOf(bornTick, speciesId, tick).stage;

/**
 * Behavioral independence vs reproductive maturity are deliberately separate:
 * a young body stays with a parent for a fraction of its juvenile growth, then
 * fends for itself — possibly well before it could breed.
 */
export const DEPENDENCY_SPAN = 0.75;

/** Age (ticks) at which a species' young can survive on their own. */
export const independenceAgeOf = (speciesId: string): number => NEWBORN_TICKS + growthSpan(speciesId) * DEPENDENCY_SPAN;

/** True while a body is a dependent juvenile shadowing a parent. Bodies without growth data (spawned adults, legacy saves) are independent. */
export const isDependent = (bornTick: number | undefined, speciesId: string, tick: number): boolean =>
  bornTick !== undefined && tick - bornTick < independenceAgeOf(speciesId);

/** True while the body is still growing (newborn or juvenile). */
export const isJuvenile = (bornTick: number | undefined, speciesId: string, tick: number): boolean => {
  const s = stageOf(bornTick, speciesId, tick);
  return s === "newborn" || s === "juvenile";
};

/* ----------------------------- Physical size -------------------------------- */

/** Size multiplier from growth: newborns start small, juveniles grow linearly. */
export function growthSizeMul(g: GrowthInfo): number {
  if (g.stage === "newborn") return NEWBORN_SIZE_MUL;
  if (g.stage === "juvenile") return NEWBORN_SIZE_MUL + (1 - NEWBORN_SIZE_MUL) * g.progress;
  return 1;
}

/** Mature physical size in tile units, from the size genotype (Phase 1 pipeline). */
export const maturePhysicalSize = (genes: Genome): number => expressGene(genes.size) / SIZE_PER_TILE;

/**
 * The physical size phenotype: inherited potential scaled by development.
 * Continuous (tile units) — the footprint classifier reads this, and so do
 * food/space demand and render scaling.
 */
export function physicalSize(b: { genes?: Genome; bornTick?: number }, speciesId: string, tick: number, g?: GrowthInfo): number {
  if (!b.genes) return footprintOf(SPECIES[speciesId]);
  return maturePhysicalSize(b.genes) * growthSizeMul(g ?? growthOf(b.bornTick, speciesId, tick));
}

/** The one footprint classifier: physical size → 1×1 / 2×2 / 3×3 / 4×4. */
export function footprintClass(size: number): 1 | 2 | 3 | 4 {
  for (let i = FOOTPRINT_THRESHOLDS.length - 1; i >= 0; i--) {
    if (size >= FOOTPRINT_THRESHOLDS[i]) return (i + 2) as 2 | 3 | 4;
  }
  return 1;
}

/**
 * A body's effective tile footprint: its phenotype class, capped by any
 * placement limit (`fpCap` — a growth transition that could not yet find room).
 * Bodies without genotype data fall back to the species footprint.
 */
export function bodyFootprint(b: { speciesId: string; genes?: Genome; bornTick?: number; fpCap?: number }, tick: number): 1 | 2 | 3 | 4 {
  const raw = b.genes ? footprintClass(physicalSize(b, b.speciesId, tick)) : footprintOf(SPECIES[b.speciesId]);
  return Math.min(raw, b.fpCap ?? 4) as 1 | 2 | 3 | 4;
}

/* ------------------------------ Stat scaling --------------------------------- */

export type StatScaleKey = "hp" | "atk" | "def" | "agi" | "wis";

/**
 * Stat multiplier from growth, centralized for balance: the young are frail
 * (hp/atk/def only — the small are still quick and sharp), elders wane.
 */
export function growthStatMul(g: GrowthInfo, key: StatScaleKey): number {
  if (g.stage === "mature") return 1;
  if (g.stage === "elder") return key === "hp" || key === "atk" || key === "def" ? ELDER_STAT_MUL : 1;
  const p = NEWBORN_STAT_MUL + (1 - NEWBORN_STAT_MUL) * (g.stage === "newborn" ? 0 : g.progress);
  return key === "hp" || key === "atk" || key === "def" ? p : 1;
}

/* --------------------------- Ecological demands ------------------------------ */

/**
 * Food demand in ecology units per interval — larger bodies eat more, growing
 * bodies eat (somewhat) less than adults. Ecology sums this over a census.
 */
export function foodDemand(b: { genes?: Genome; bornTick?: number }, speciesId: string, tick: number): number {
  const g = growthOf(b.bornTick, speciesId, tick);
  return (0.5 + 0.5 * physicalSize(b, speciesId, tick, g)) * (g.stage === "mature" || g.stage === "elder" ? 1 : 0.65);
}

/** Ecological space an individual claims (tile units) — the territory-pricing hook. */
export const spaceDemand = (b: { genes?: Genome; bornTick?: number }, speciesId: string, tick: number): number =>
  physicalSize(b, speciesId, tick);

/* -------------------------------- Migration ---------------------------------- */

/**
 * One-time growth backfill for older saves (idempotent, runs on every load):
 * monsters that are adults by level but carry a recent bornTick predate this
 * system — backdate them so they are not mistaken for juveniles. Genuinely
 * young bodies (level < maturity) keep their age and grow normally.
 */
export function migrateGrowth(gs: GameState): void {
  for (const m of [...gs.party, ...gs.pen]) {
    if (m.level >= MATURITY_LEVEL && gs.tick - m.bornTick < matureAgeOf(m.speciesId)) {
      m.bornTick = gs.tick - matureAgeOf(m.speciesId) - 1;
    }
  }
}
