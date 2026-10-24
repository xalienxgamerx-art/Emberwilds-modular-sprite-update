import { generateUrban, urbanHalf, validateUrban, type UrbanConfig, type UrbanLayout, type UrbanPlan } from "./urban";
import type { Building } from "./buildings";
import type { SettlementTier } from "./settlement";

/**
 * City generation — the great settlement tier, raised on the shared urban
 * generator: two avenue pairs, a nine-or-more district grid ring by a
 * boulevard, grand halls, and a major association headquarters. The city
 * reads as a region's center: more gates, bigger buildings, more public
 * ground, and districts you can tell apart by their buildings.
 *
 * Footprint: 69×69 — the tier's reserved size (three times the 23×23
 * hamlet), so the hierarchy hamlet < town < city reads on the ground.
 */

export type CityPlan = UrbanPlan;
export interface CityLayout extends UrbanLayout {}

/** What a city is: two avenue pairs, nine-plus districts, grand services. */
export const CITY_CONFIG: UrbanConfig = {
  tier: "city",
  half: urbanHalf("city"),
  ring: urbanHalf("city") - 3,
  plazaR: 5,
  plot: 7,
  avenues: [-4, -7, -10, -13, 4, 7, 10, 13],
  minGates: 3,
  zones: [
    { zone: "civic", blocks: 1 },
    { zone: "association", blocks: 1 },
    { zone: "market", blocks: 2 },
    { zone: "beasts", blocks: 1 },
  ],
  homes: { min: 4, skip: 0.12 },
  services: [
    { type: "assoc_hq", tag: "hq", count: 1, plot: "double", zone: "association" },
    { type: "inn", tag: "inn", count: 1, plot: "double", zone: "market" },
    { type: "trader", tag: "shop1", count: 1, plot: "single", zone: "market" },
    { type: "trader", tag: "shop2", count: 3, plot: "single", zone: "market" },
    { type: "pen", tag: "pen", count: 1, plot: "single", zone: "beasts" },
  ],
  optional: [
    { type: "city_hq", tag: "civic", count: 1, plot: "double", zone: "civic" },
    { type: "trader", tag: "shop4", count: 4, plot: "single", zone: "market" },
    { type: "pen", tag: "pen2", count: 2, plot: "single", zone: "beasts" },
  ],
};

export function generateCity(opts: { id: string; seed: number; fx: number; fy: number; exteriorOk(x: number, y: number): boolean }): CityLayout {
  return generateUrban(CITY_CONFIG, opts);
}

export function validateCity(city: { plan: UrbanPlan; buildings: Building[] }, fx: number, fy: number): string[] {
  return validateUrban(city, fx, fy, CITY_CONFIG);
}

/** The tier this generator raises. Kept for callers that branch on tier. */
export const cityTier: SettlementTier = "city";
