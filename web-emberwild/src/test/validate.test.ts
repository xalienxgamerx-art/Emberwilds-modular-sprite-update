import { describe, expect, it } from "vitest";

import { BUILDING_TEMPLATES, generateBuilding, type Building } from "@/game/buildings";
import { migrateLoaded } from "@/game/migrate";
import { newGame, previewStarter, SAVE_VERSION } from "@/game/sim";
import {
  validateInteriorDrill,
  validateRoadGraph,
  validateRoadPaths,
  validateSettlementFootprint,
  validateSettlementInfrastructure,
  validateSettlementNpcs,
} from "@/game/validate";
import { settlementEntrances } from "@/game/roads";
import { getWorld, type Feature, type World } from "@/game/world";
import type { RoadNetwork, RoadSettlement } from "@/game/roads";

/** A real settlement of the given kind on a real generated world. */
const findSettlement = (world: World, kind: Feature["kind"]): Feature => {
  for (let cy = 0; cy < 171; cy++) {
    for (let cx = 0; cx < 171; cx++) {
      const f = world.featureCell(cx, cy);
      if (f && f.kind === kind) return f;
    }
  }
  throw new Error(`no ${kind} in the census`);
};

/** Synthetic road-network pieces for the negative fixtures. */
const node = (id: string, x: number, y: number, tier: RoadSettlement["tier"], nation: string, entrances: RoadSettlement["entrances"]): RoadSettlement => ({
  id,
  x,
  y,
  tier,
  nation,
  half: tier === "city" ? 34 : tier === "town" ? 23 : 11,
  entrances,
});

const net = (settlements: RoadSettlement[], roads: RoadNetwork["roads"], isolated: string[] = []): RoadNetwork => ({
  seed: 1,
  settlements,
  byId: new Map(settlements.map((s) => [s.id, s])),
  roads,
  isolated,
  tiles: new Map(),
  bridges: new Set(),
  paths: new Set(),
  entranceTiles: new Set(settlements.flatMap((s) => s.entrances.map((e) => e.y * 4096 + e.x))),
  finished: true,
});

describe("settlement infrastructure validator (Phase 8)", () => {
  it("flags a road graph whose hub lost its required connection", () => {
    const cap = node("s:100:100", 100, 100, "hamlet", "n:100:100", [{ id: "e:100:89", x: 100, y: 89, settlement: "s:100:100", dir: "n" }]);
    const town = node("s:200:100", 200, 100, "town", "n:100:100", [{ id: "e:200:77", x: 200, y: 77, settlement: "s:200:100", dir: "n" }]);
    // the trunk survey failed and the town is NOT recorded as isolated — the
    // graph advertises a hierarchy it does not have
    const broken = net([cap, town], [{ id: "r:1", a: "s:100:100", b: "s:200:100", cls: "local", kind: "trunk", crossNational: false, status: "failed", reason: "no route", route: null, entranceA: null, entranceB: null, shared: 0 }]);
    const failures = validateRoadGraph(broken, "test");
    expect(failures.some((f) => f.invariant.includes("not honestly recorded as isolated"))).toBe(true);

    // the same network with the isolation recorded honestly is clean
    const honest = net([cap, town], broken.roads, ["s:100:100", "s:200:100"]);
    expect(validateRoadGraph(honest, "test")).toEqual([]);
  });

  it("flags a physical route that crosses a building", () => {
    const world = getWorld(4242);
    const ham = findSettlement(world, "hamlet");
    const layout = world.settlementLayout(ham);
    const entrances = settlementEntrances(world, ham);
    expect(entrances.length).toBeGreaterThan(0);
    // a wall tile of the first building
    const b = layout.buildings[0];
    let wall: { x: number; y: number } | null = null;
    for (let ly = 0; ly < b.h && !wall; ly++) {
      for (let lx = 0; lx < b.w && !wall; lx++) {
        if (b.cells[ly * b.w + lx] === "wall") wall = { x: b.x + lx, y: b.y + ly };
      }
    }
    expect(wall).not.toBeNull();
    const ents = entrances.map((e) => ({ id: `e:${e.x}:${e.y}`, x: e.x, y: e.y, settlement: `s:${ham.x}:${ham.y}`, dir: e.dir }));
    const n = node(`s:${ham.x}:${ham.y}`, ham.x, ham.y, "hamlet", "", ents);
    const bad = net([n], [{ id: "r:bad", a: n.id, b: n.id, cls: "local", kind: "trunk", crossNational: false, status: "built", route: [ents[0], wall!], entranceA: ents[0].id, entranceB: ents[0].id, shared: 0 }]);
    bad.tiles.set(wall!.y * 4096 + wall!.x, "local");
    const failures = validateRoadPaths(world, bad, "test");
    expect(failures.some((f) => f.invariant.includes("building wall"))).toBe(true);
  });

  it("flags a road that terminates away from any deliberate entrance", () => {
    const n = node("s:100:100", 100, 100, "hamlet", "", [{ id: "e:100:89", x: 100, y: 89, settlement: "s:100:100", dir: "n" }]);
    const bad = net([n], [{ id: "r:1", a: "s:100:100", b: "s:100:100", cls: "local", kind: "trunk", crossNational: false, status: "built", route: [{ x: 100, y: 100 }], entranceA: "e:nowhere", entranceB: "e:nowhere", shared: 0 }]);
    const failures = validateRoadGraph(bad, "test");
    expect(failures.some((f) => f.invariant.includes("entrances"))).toBe(true);
  });

  it("flags disconnected rooms and sealed doors inside a generated building", () => {
    const sealed = generateBuilding({ id: "b:test:sealed", seed: 4242, template: BUILDING_TEMPLATES.inn, plot: { w: 9, h: 5 } });
    const internal = sealed.doors.find((d) => !d.external);
    expect(internal).not.toBeNull();
    sealed.cells[internal!.ly * sealed.w + internal!.lx] = "wall";
    const problems = validateInteriorDrill(sealed);
    expect(problems.some((p) => p.invariant.includes("unreachable"))).toBe(true);

    // a healthy building drills clean: in, through every room, and back out
    const healthy = generateBuilding({ id: "b:test:healthy", seed: 777, template: BUILDING_TEMPLATES.inn, plot: { w: 9, h: 5 } });
    expect(validateInteriorDrill(healthy)).toEqual([]);
  });

  it("sweeps a real world clean of structural, footprint and reservation failures", () => {
    const world = getWorld(20260101);
    const result = validateSettlementInfrastructure(world, "unit", { skipRoads: true, skipResidents: true });
    expect(result.settlements).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
  }, 30000);

  it("keeps residents inside the settlement and off the gates", () => {
    const world = getWorld(4242);
    const ham = findSettlement(world, "hamlet");
    const tiles = new Set(settlementEntrances(world, ham).map((e) => e.y * 4096 + e.x));
    const failures = validateSettlementNpcs(world, ham, tiles, "unit", { skipResidents: false });
    expect(failures).toEqual([]);
  });

  it("running validation mutates nothing — the world regenerates identically afterwards", () => {
    const world = getWorld(20260101);
    const before = validateSettlementInfrastructure(world, "unit", { skipRoads: true, skipResidents: true });
    getWorld(999); // bounce the singleton, like any later session would
    const fresh = getWorld(20260101); // a fresh instance of the same seed
    const ham = findSettlement(world, "hamlet");
    const again = validateSettlementInfrastructure(world, "unit", { skipRoads: true, skipResidents: true });
    expect(again.failures).toEqual(before.failures);
    expect(JSON.stringify(fresh.settlementLayout(ham).buildings)).toBe(JSON.stringify(world.settlementLayout(ham).buildings));
  }, 30000);

  it("a fresh game state migrates to the current version without losing the round trip", () => {
    const gs = newGame("MIG-1", "Rook", "ranger", "#e8742a", previewStarter("MIG-1", "mossback"));
    gs.tick = 9999;
    const json = JSON.stringify(gs);
    const parsed = JSON.parse(json) as Parameters<typeof migrateLoaded>[0];
    expect(migrateLoaded(parsed)).toBe(true);
    expect(parsed.version).toBe(SAVE_VERSION);
    expect(JSON.stringify(parsed.party)).toBe(JSON.stringify(gs.party));
    expect(JSON.stringify(parsed.bag)).toBe(JSON.stringify(gs.bag));
    expect(parsed.player.x).toBe(gs.player.x);
    expect(migrateLoaded(parsed)).toBe(true); // idempotent
  });
});
