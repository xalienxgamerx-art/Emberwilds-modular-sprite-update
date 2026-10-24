import { describe, expect, it } from "vitest";

import { getFactions } from "@/game/factions";
import { getSettlementFootprint, settlementTier } from "@/game/settlement";
import { validateCity } from "@/game/city";
import { getWorld, type Feature } from "@/game/world";

const world = getWorld(424242);
const CITY_R = getSettlementFootprint("city").w >> 1;

/** Cities are claimed region by region — scan the world's feature cells for them. */
const findCities = (): Feature[] => {
  const out: Feature[] = [];
  for (let cy = 0; cy < 171; cy++) {
    for (let cx = 0; cx < 171; cx++) {
      const f = (world as unknown as { cellFeature(cx: number, cy: number): Feature | null }).cellFeature(cx, cy);
      if (f && f.kind === "city") out.push(f);
    }
  }
  return out;
};

const cities = findCities();
const first = cities[0];
let plan = first ? world.settlementLayout(first).urban! : null;

describe("city generation", () => {
  it("raises great centers on the reserved 69x69 footprint", () => {
    expect(CITY_R).toBe(34);
    expect(cities.length).toBeGreaterThanOrEqual(2);
    for (const f of cities) {
      const lay = world.settlementLayout(f);
      for (const b of lay.buildings) {
        expect(b.x - f.x).toBeGreaterThanOrEqual(-CITY_R);
        expect(b.y - f.y).toBeGreaterThanOrEqual(-CITY_R);
        expect(b.x - f.x + b.w - 1).toBeLessThanOrEqual(CITY_R);
        expect(b.y - f.y + b.h - 1).toBeLessThanOrEqual(CITY_R);
      }
    }
  });

  it("is a valid settlement tier with grand services", () => {
    expect(settlementTier(first!)).toBe("city");
    const types = world.settlementLayout(first!).buildings.map((b) => b.type);
    expect(types.filter((t) => t === "assoc_hq").length).toBe(1);
    expect(types.filter((t) => t === "inn").length).toBe(1);
    expect(types.filter((t) => t === "trader").length).toBeGreaterThanOrEqual(3);
    expect(types.filter((t) => t === "pen").length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t) => t === "small_home" || t === "medium_home").length).toBeGreaterThanOrEqual(4);
    expect(world.settlementLayout(first!).buildings.length).toBeGreaterThanOrEqual(15);
    for (const f of cities) {
      const lay = world.settlementLayout(f);
      expect(validateCity({ plan: lay.urban!, buildings: lay.buildings }, f.x, f.y)).toEqual([]);
    }
  });

  it("is ringed by boulevards, many gates, and districts you can tell apart", () => {
    for (const f of cities) {
      const urban = world.settlementLayout(f).urban!;
      expect(urban.gates.length).toBeGreaterThanOrEqual(3);
      expect(urban.streets.size).toBeGreaterThan(400);
      const zones = new Set<string>();
      for (let ly = -34; ly <= 34; ly += 2) {
        for (let lx = -34; lx <= 34; lx += 2) {
          const z = urban.zoneAt(lx, ly);
          if (z) zones.add(z);
        }
      }
      for (const z of ["market", "homes", "beasts", "association", "civic", "public"]) expect(zones.has(z), `${f.name} lacks a ${z} district`).toBe(true);
    }
  });

  it("suppresses every lesser landmark inside its reserved site", () => {
    for (const f of cities) {
      for (const other of world.featuresNear(f.x, f.y, CITY_R)) {
        expect(other.kind === "city" && other.x === f.x && other.y === f.y, `${other.name} spawns inside ${f.name}`).toBe(true);
      }
    }
  });

  it("rebuilds the identical city from the same seed", () => {
    const w2 = getWorld(424242);
    for (const f of cities) {
      expect(JSON.stringify(w2.settlementLayout(f).buildings)).toBe(JSON.stringify(world.settlementLayout(f).buildings));
      expect(w2.settlementLayout(f).urban!.gates).toEqual(world.settlementLayout(f).urban!.gates);
    }
  });

  it("keeps folk at their posts across the whole city", () => {
    for (const f of cities) {
      const folk = world.settlementPopulation(f, 900);
      expect(folk.length).toBeGreaterThanOrEqual(6);
      for (const n of folk) {
        expect(world.siteAt(n.x, n.y)?.wall ?? false).toBe(false);
        expect(world.npcAt(n.x, n.y, 900)?.name).toBe(n.name);
      }
    }
  });
});

describe("association headquarters", () => {
  it("seats a regional hall in a city, distinct from any town chapter", () => {
    const fac = getFactions(424242, world);
    const seats = fac.assocs.filter((a) => a.headquarters);
    expect(seats.length).toBeGreaterThanOrEqual(1);
    for (const a of seats) {
      const { city, buildingId } = a.headquarters!;
      expect(settlementTier(city)).toBe("city");
      const hall = world.settlementLayout(city).building("assoc_hq");
      expect(hall?.id).toBe(buildingId);
      // a headquarters is never the chapter building
      expect(world.settlementLayout(city).building("association")?.id).not.toBe(buildingId);
      // the relationship is discoverable from the city
      expect(fac.headquartersAt(city)?.id).toBe(a.id);
    }
  });
});
