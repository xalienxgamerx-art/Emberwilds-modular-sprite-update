import { describe, expect, it } from "vitest";

import { getFactions } from "@/game/factions";
import { getSettlementFootprint, isSettlement, settlementTier } from "@/game/settlement";
import { validateTown, type TownLayout } from "@/game/town";
import { getWorld, type Feature } from "@/game/world";

const world = getWorld(424242);

/** Towns live in cells that were empty before Phase 4 — scan a bounded region for one. */
const findTowns = (): Feature[] => {
  const out: Feature[] = [];
  for (let cy = 60; cy < 110; cy++) {
    for (let cx = 60; cx < 110; cx++) {
      const f = (world as unknown as { cellFeature(cx: number, cy: number): Feature | null }).cellFeature(cx, cy);
      if (f && f.kind === "town") out.push(f);
    }
  }
  return out;
};

const towns = findTowns();
const first = towns[0];
let layout: TownLayout | null = null;
if (first) {
  const lay = world.settlementLayout(first);
  layout = { plan: lay.urban!, buildings: lay.buildings, problems: [] };
}

describe("town generation", () => {
  it("raises a regional center on the reserved 46x46 footprint", () => {
    const half = getSettlementFootprint("town").w >> 1;
    expect(half).toBe(23);
    for (const b of layout!.buildings) {
      expect(b.x - first!.x).toBeGreaterThanOrEqual(-half);
      expect(b.y - first!.y).toBeGreaterThanOrEqual(-half);
      expect(b.x - first!.x + b.w - 1).toBeLessThanOrEqual(half);
      expect(b.y - first!.y + b.h - 1).toBeLessThanOrEqual(half);
    }
  });

  it("is a valid settlement tier with full services", () => {
    expect(settlementTier(first!)).toBe("town");
    expect(isSettlement(first!)).toBe(true);
    const types = layout!.buildings.map((b) => b.type);
    expect(types.filter((t) => t === "inn").length).toBe(1);
    expect(types.filter((t) => t === "trader").length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t) => t === "pen").length).toBe(1);
    expect(types.filter((t) => t === "association").length).toBe(1);
    expect(types.filter((t) => t === "small_home" || t === "medium_home").length).toBeGreaterThanOrEqual(2);
    expect(validateTown(layout!, first!.x, first!.y)).toEqual([]);
  });

  it("reserves real streets and multiple gates, all reachable from the green", () => {
    const plan = layout!.plan;
    expect(plan.streets.size).toBeGreaterThan(150);
    expect(plan.gates.length).toBeGreaterThanOrEqual(2);
    for (const g of plan.gates) {
      expect(plan.isStreet(g.lx, g.ly)).toBe(true);
      expect(Math.max(Math.abs(g.lx), Math.abs(g.ly))).toBe(20);
    }
    // zoning covers the footprint: the green is public, quadrants are zoned
    expect(plan.zoneAt(0, 0)).toBe("public");
    const zones = new Set<string>();
    for (let ly = -22; ly <= 22; ly += 2) {
      for (let lx = -22; lx <= 22; lx += 2) {
        const z = plan.zoneAt(lx, ly);
        if (z) zones.add(z);
      }
    }
    expect(zones.has("market")).toBe(true);
    expect(zones.has("homes")).toBe(true);
    expect(zones.has("beasts")).toBe(true);
    expect(zones.has("association")).toBe(true);
  });

  it("rebuilds the identical town from the same seed", () => {
    const w2 = getWorld(424242);
    const again = w2.settlementLayout(first!);
    expect(JSON.stringify(again.buildings)).toBe(JSON.stringify(world.settlementLayout(first!).buildings));
    expect(again.urban!.gates).toEqual(world.settlementLayout(first!).urban!.gates);
  });

  it("stands folk at their posts and lets them walk the public ground", () => {
    const folk = world.settlementPopulation(first!, 500);
    expect(folk.length).toBeGreaterThanOrEqual(5);
    for (const n of folk) {
      const sp = world.siteAt(n.x, n.y);
      expect(sp?.wall ?? false).toBe(false);
      expect(world.npcAt(n.x, n.y, 500)?.name).toBe(n.name);
    }
  });

  it("leaves hamlets exactly where they were", () => {
    // the start settlement is still a hamlet, still 23x23, still folked
    const start = world.startPoint();
    const here = world.featuresNear(start.x, start.y, 6).find((f) => f.x === start.x && f.y === start.y);
    expect(here).toBeDefined();
    expect(settlementTier(here!)).toBe("hamlet");
    const lay = world.settlementLayout(here!);
    expect(lay.buildings.length).toBe(5);
    expect(lay.urban).toBeUndefined();
    expect(world.settlementNpcs(here!).length).toBe(3);
  });
});

describe("association chapters", () => {
  it("chapters in towns point at a real chapter hall building", () => {
    const fac = getFactions(424242, world);
    const chapters = fac.assocs.filter((a) => settlementTier(a.chapter) === "town");
    for (const a of chapters) {
      expect(a.chapterBuilding).toBeDefined();
      const hall = world.settlementLayout(a.chapter).building("association");
      expect(hall?.id).toBe(a.chapterBuilding);
    }
  });
});
