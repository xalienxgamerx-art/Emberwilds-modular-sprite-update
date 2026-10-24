import { hash2 } from "./rng";
import type { FeatureId, Terrain } from "./types";

/**
 * Generalized settlements — the semantic foundation for hamlets, towns and
 * cities. Today only hamlets generate; every tier-specific behavior branches
 * through this module so later phases add a tier without rewriting callers.
 *
 * The tiers:
 *
 *   Settlement
 *   ├── Hamlet (23×23)
 *   ├── Town   (46×46)
 *   └── City   (69×69)
 */

/** How far a settlement has grown. Towns and cities are representable now; only hamlets generate (Phase 1). */
export type SettlementTier = "hamlet" | "town" | "city";

/** Every valid settlement tier, smallest first. */
export const SETTLEMENT_TIERS: readonly SettlementTier[] = ["hamlet", "town", "city"];

/**
 * Which world-feature kind realizes each tier. Feature kinds join this map
 * exactly when they start generating — `hamlet` today, `town`/`city` kinds
 * when the procedural generator arrives in a later phase.
 */
const TIER_OF_KIND: Partial<Record<FeatureId, SettlementTier>> = {
  hamlet: "hamlet",
  town: "town",
  city: "city",
};

/** Overall settlement footprint in tiles — the whole settlement, not one building. */
export interface SettlementFootprint {
  w: number;
  h: number;
}

/** The canonical footprint per tier. Centralized: generation and future reservation code read it from here. */
const FOOTPRINTS: Record<SettlementTier, SettlementFootprint> = {
  // a hamlet is 23×23: a full ring of real multi-room buildings (inn, trader,
  // pen, two homes) around a generous village green, with a street between
  // every plot and room to grow
  hamlet: { w: 23, h: 23 },
  // towns are twice a hamlet, cities three times — the later generators scale
  town: { w: 46, h: 46 },
  city: { w: 69, h: 69 },
};

/** Anything carrying a world-feature kind — Feature and SitePiece both qualify. */
interface KindBearing {
  kind: FeatureId;
}

/** Whether this feature (or site piece) is a settlement at any tier. */
export function isSettlement(f: KindBearing | null | undefined): boolean {
  return !!f && f.kind in TIER_OF_KIND;
}

/** The settlement tier of this feature, or null when it is not a settlement. */
export function settlementTier(f: KindBearing | null | undefined): SettlementTier | null {
  return (f && TIER_OF_KIND[f.kind]) || null;
}

/** Whether this feature is a settlement of exactly the given tier. */
export function hasSettlementTier(f: KindBearing | null | undefined, tier: SettlementTier): boolean {
  return settlementTier(f) === tier;
}

/** The footprint of a settlement tier: hamlet 23×23, town 46×46, city 69×69. */
export function getSettlementFootprint(tier: SettlementTier): SettlementFootprint {
  return FOOTPRINTS[tier];
}

/**
 * Stable settlement identity: a pure function of where the settlement stands.
 * The feature coordinates already are the world system's stable feature id
 * (discovery keys, faction ids) — settlements reuse them so future systems can
 * derive deterministic layouts from world seed + settlement identity.
 */
export function settlementId(f: { x: number; y: number }): string {
  return `s:${f.x}:${f.y}`;
}

/** Deterministic generation seed for a settlement, from world seed + identity. */
export function settlementSeed(seed: number, f: { x: number; y: number }): number {
  return hash2(seed ^ 0x5e77, f.x, f.y);
}

/** The wall material a tier builds with: hamlets are timber, larger tiers are stonework. */
export function settlementWallTerrain(tier: SettlementTier): Terrain {
  return tier === "hamlet" ? "woodwall" : "wall";
}
