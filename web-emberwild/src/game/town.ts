import { hash2 } from "./rng";
import { generateUrban, urbanHalf, validateUrban, type UrbanConfig, type UrbanLayout, type UrbanPlan, type UrbanZone, type UrbanGate } from "./urban";
import type { Building } from "./buildings";
import type { SettlementTier } from "./settlement";

/**
 * Town generation — the middle settlement tier, raised on the shared urban
 * generator: one avenue pair, four districts, an inn and a chapter hall on
 * the main streets. See urban.ts for the pipeline; this module only fixes
 * what a town is.
 *
 * Footprint: 46×46 — the tier's reserved size (twice the 23×23 hamlet), so
 * the hierarchy hamlet < town < city reads on the ground.
 */

export type TownZone = UrbanZone;
export type TownPlan = UrbanPlan;
export interface TownLayout extends UrbanLayout {}
export type { UrbanGate as TownGate };

/** What a town is: one avenue pair, four districts, town services. */
export const TOWN_CONFIG: UrbanConfig = {
  tier: "town",
  half: urbanHalf("town"),
  ring: urbanHalf("town") - 3,
  plazaR: 4,
  plot: 7,
  avenues: [-6, -3, 3, 6, 0, -9, 9],
  minGates: 2,
  zones: [
    { zone: "market", blocks: 1 },
    { zone: "beasts", blocks: 1 },
    { zone: "association", blocks: 1 },
  ],
  homes: { min: 2, skip: 0.15 },
  services: [
    { type: "inn", tag: "inn", count: 1, plot: "double", zone: "market" },
    { type: "association", tag: "chapter", count: 1, plot: "double", zone: "association" },
    { type: "trader", tag: "shop1", count: 1, plot: "single", zone: "market" },
    { type: "trader", tag: "shop2", count: 2, plot: "single", zone: "market" },
    { type: "pen", tag: "pen", count: 1, plot: "single", zone: "beasts" },
  ],
};

export function generateTown(opts: { id: string; seed: number; fx: number; fy: number; exteriorOk(x: number, y: number): boolean }): TownLayout {
  void hash2; // seed derivation lives in the urban engine
  return generateUrban(TOWN_CONFIG, opts);
}

export function validateTown(town: { plan: UrbanPlan; buildings: Building[] }, fx: number, fy: number): string[] {
  return validateUrban(town, fx, fy, TOWN_CONFIG);
}

/** The tier this generator raises. Kept for callers that branch on tier. */
export const townTier: SettlementTier = "town";
