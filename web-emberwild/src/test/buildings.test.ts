import { describe, expect, it } from "vitest";

import {
  BUILDING_TEMPLATES,
  WALKABLE_CELLS,
  cellKindAt,
  generateBuilding,
  roomAt,
  validateBuilding,
  walkableCount,
  type Building,
  type BuildingType,
} from "@/game/buildings";
import { DAY_TICKS } from "@/game/data";
import { getWorld } from "@/game/world";

/** Plot shapes mirroring the hamlet's real plots, so tests exercise the actual constraints. */
const PLOTS: Record<string, { w: number; h: number }> = {
  inn: { w: 9, h: 5 },
  trader: { w: 9, h: 5 },
  pen: { w: 7, h: 4 },
  small_home: { w: 9, h: 5 },
  medium_home: { w: 9, h: 5 },
  association: { w: 10, h: 7 },
  city_hq: { w: 12, h: 9 },
  assoc_hq: { w: 16, h: 10 },
};

const gen = (type: BuildingType, seed: number): Building =>
  generateBuilding({ id: `b:test:${type}:${seed}`, seed, template: BUILDING_TEMPLATES[type], plot: PLOTS[type] });

const TYPES = Object.keys(BUILDING_TEMPLATES) as BuildingType[];

describe("building generation", () => {
  it("generates a valid, plot-fitting building for every template", () => {
    for (const type of TYPES) {
      for (const seed of [1, 42, 4242]) {
        const b = gen(type, seed);
        const plot = PLOTS[type];
        expect(validateBuilding(b, BUILDING_TEMPLATES[type]), `${type} seed ${seed}`).toEqual([]);
        expect(b.rooms.length, `${type} seed ${seed} rooms`).toBeGreaterThanOrEqual(2);
        expect(b.w, `${type} seed ${seed} width`).toBeLessThanOrEqual(plot.w);
        expect(b.h, `${type} seed ${seed} depth`).toBeLessThanOrEqual(plot.h);
        const walk = walkableCount(b);
        expect(walk).toBeGreaterThanOrEqual(8);
        // empty space is intentional: most floor stays unassigned
        expect(b.reserved.length).toBeLessThan(walk);
        for (const r of b.rooms) {
          const reserved = b.reserved.filter((s) => s.lx >= r.x0 && s.lx <= r.x1 && s.ly >= r.y0 && s.ly <= r.y1);
          expect(reserved.length, `room ${r.id} of ${type} has no reserved space`).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("keeps a solid exterior with an entrance that opens into a room", () => {
    for (const type of TYPES) {
      const b = gen(type, 7);
      expect(b.w).toBeGreaterThanOrEqual(BUILDING_TEMPLATES[type].minW);
      for (let lx = 0; lx < b.w; lx++) {
        expect(["wall", "door"]).toContain(cellKindAt(b, lx, 0));
        expect(["wall", "door"]).toContain(cellKindAt(b, lx, b.h - 1));
      }
      const ent = b.doors.find((d) => d.external);
      expect(ent, `${type} has no entrance`).toBeDefined();
      expect(ent!.dir).not.toBeNull();
      const inward = ent!.dir === "n" ? [ent!.lx, ent!.ly + 1] : ent!.dir === "s" ? [ent!.lx, ent!.ly - 1] : ent!.dir === "w" ? [ent!.lx + 1, ent!.ly] : [ent!.lx - 1, ent!.ly];
      expect(WALKABLE_CELLS).toContain(cellKindAt(b, inward[0], inward[1]));
      expect(roomAt(b, inward[0], inward[1])).not.toBeNull();
    }
  });

  it("produces identical buildings for the same seed and varied layouts across seeds", () => {
    for (const type of ["inn", "trader", "pen", "medium_home"] as BuildingType[]) {
      for (const seed of [17, 90210]) {
        expect(JSON.stringify(gen(type, seed))).toBe(JSON.stringify(gen(type, seed)));
      }
    }
    const shapes = new Set<string>();
    for (let seed = 0; seed < 30; seed++) {
      const b = gen("inn", seed * 7919);
      shapes.add(`${b.w}x${b.h}:${b.rooms.map((r) => `${r.type}@${r.x0},${r.y0}`).join("|")}`);
    }
    expect(shapes.size).toBeGreaterThan(2);
  });

  it("flags broken layouts instead of shipping them", () => {
    const breached = gen("inn", 4242);
    breached.cells[0] = "floor";
    expect(validateBuilding(breached, BUILDING_TEMPLATES.inn).some((p) => p.includes("exterior wall broken"))).toBe(true);

    const sealed = gen("inn", 4242);
    for (const d of sealed.doors) if (!d.external) sealed.cells[d.ly * sealed.w + d.lx] = "wall";
    sealed.doors = sealed.doors.filter((d) => d.external);
    expect(validateBuilding(sealed, BUILDING_TEMPLATES.inn).some((p) => p.includes("unreachable"))).toBe(true);

    const bare = gen("inn", 4242);
    for (const s of bare.reserved) bare.cells[s.ly * bare.w + s.lx] = "floor";
    bare.reserved = [];
    expect(validateBuilding(bare, BUILDING_TEMPLATES.inn).some((p) => p.includes("reserved"))).toBe(true);
  });
});

describe("hamlet integration", () => {
  it("builds real multi-room structures that face the green on dry land", () => {
    for (const seed of [20260101, 4242]) {
      const world = getWorld(seed);
      const start = world.startPoint();
      const ham = world.featuresNear(start.x, start.y, 12).find((f) => f.kind === "hamlet");
      expect(ham, `seed ${seed} has a hamlet`).toBeDefined();
      const layout = world.settlementLayout(ham!);
      expect(layout.buildings.length).toBe(5);
      expect(layout.building("inn")).not.toBeNull();
      expect(layout.building("trader")).not.toBeNull();
      expect(layout.building("pen")).not.toBeNull();
      expect(layout.building("small_home")).not.toBeNull();
      expect(layout.building("medium_home")).not.toBeNull();

      let walls = 0;
      let doors = 0;
      for (const b of layout.buildings) {
        expect(validateBuilding(b, BUILDING_TEMPLATES[b.type]), `${b.type} seed ${seed}`).toEqual([]);
        // the whole building stands on dry land
        for (let ly = 0; ly < b.h; ly++) {
          for (let lx = 0; lx < b.w; lx++) {
            expect(["deep", "sea", "lake", "river"], `${b.type} seed ${seed} is dry`).not.toContain(world.tile(b.x + lx, b.y + ly).biome);
            const sp = world.siteAt(b.x + lx, b.y + ly);
            expect(sp, `${b.type} tile exposed through the site`).not.toBeNull();
            if (sp!.wall) walls++;
            if (sp!.door) doors++;
            // collision is structural: walls block, walkable cells do not
            expect(world.passable(b.x + lx, b.y + ly)).toBe(!sp!.wall);
          }
        }
        // the entrance faces the heart of the settlement
        const ent = b.doors.find((d) => d.external)!;
        const [dx, dy] = ent.dir === "n" ? [0, -1] : ent.dir === "s" ? [0, 1] : ent.dir === "w" ? [-1, 0] : [1, 0];
        const d2 = (px: number, py: number): number => (px - ham!.x) ** 2 + (py - ham!.y) ** 2;
        expect(d2(b.x + ent.lx + dx, b.y + ent.ly + dy), `${b.type} entrance faces the green`).toBeLessThan(d2(b.x + ent.lx, b.y + ent.ly));
        expect(world.passable(b.x + ent.lx + dx, b.y + ent.ly + dy)).toBe(true);
      }
      expect(walls).toBeGreaterThan(8);
      expect(doors).toBeGreaterThanOrEqual(3);

      // the folk stand at their posts, clear of walls and doorways
      const folk = world.settlementNpcs(ham!);
      expect(folk.length).toBe(3);
      for (const n of folk) {
        expect(world.npcAt(n.x, n.y)?.name).toBe(n.name);
        expect(world.passable(n.x, n.y)).toBe(true);
        const sp = world.siteAt(n.x, n.y);
        expect(sp?.wall).not.toBe(true);
        expect(sp?.door).not.toBe(true);
      }

      // a recruiter posts on the green with an association slot, not a fabricated chapter
      const rec = world.settlementRecruiter(ham!);
      expect(rec?.role).toBe("recruiter");
      expect(rec?.assocSlot).not.toBeUndefined();
      expect(world.passable(rec!.x, rec!.y)).toBe(true);

      // two residents wander all day on open public ground, deterministically
      const seen = new Set<string>();
      let moves = 0;
      for (let t = 0; t < DAY_TICKS; t++) {
        const res = world.settlementResidents(ham!, t);
        expect(res.length).toBe(2);
        expect(res[0].name).not.toBe(res[1].name);
        for (const n of res) {
          expect(n.role).toBe("resident");
          expect(n.home).toBeDefined();
          const sp = world.siteAt(n.x, n.y);
          expect(world.passable(n.x, n.y)).toBe(true);
          expect(sp?.wall || sp?.door || sp?.buildingId).toBeFalsy();
          expect(Math.abs(n.x - ham!.x)).toBeLessThanOrEqual(11);
          expect(Math.abs(n.y - ham!.y)).toBeLessThanOrEqual(11);
          seen.add(`${n.x},${n.y}`);
        }
        if (t > 0) {
          const prev = world.settlementResidents(ham!, t - 1);
          if (res.some((n, i) => n.x !== prev[i].x || n.y !== prev[i].y)) moves++;
        }
      }
      expect(moves).toBeGreaterThan(30);
      expect(seen.size).toBeGreaterThanOrEqual(12);
      expect(JSON.stringify(world.settlementResidents(ham!, 137))).toBe(JSON.stringify(getWorld(seed).settlementResidents(ham!, 137)));
    }
  });
});
