import { describe, expect, it } from "vitest";

import { getSettlementFootprint, isSettlement, settlementId, settlementTier } from "@/game/settlement";
import { seedFromText, World, getWorld } from "@/game/world";
import { heightOf, tileCost } from "@/game/height";
import { getFactions } from "@/game/factions";
import {
  ROAD_CLASS_RANK,
  ROAD_WIDTH,
  bridgeAt,
  finishRoads,
  pumpRoads,
  roadAt,
  roadClassFor,
  mapRoadLines,
  roadNetworkOf,
  settlementEntranceAt,
  settlementRoads,
  type RoadNetwork,
  type RoadSettlement,
} from "@/game/roads";

/**
 * The national road network: hierarchy, honesty, determinism. Each seed builds
 * a full network once per describe block — the build is a pure function of the
 * world, so every test below reads the same realized network.
 */

const SEED = seedFromText("EMBER");

let net: RoadNetwork | null = null;

function network(): RoadNetwork {
  if (!net) net = finishRoads(getWorld(SEED));
  return net;
}

const nodeOf = (n: RoadNetwork, id: string): RoadSettlement => {
  const node = n.byId.get(id);
  expect(node).toBeDefined();
  return node!;
};

describe("the national road network", () => {
  it("connects nearly every settlement and reports the failures honestly", () => {
    const n = network();
    expect(n.settlements.length).toBeGreaterThan(250);
    const built = n.roads.filter((r) => r.status === "built");
    expect(built.length).toBeGreaterThan(0);
    for (const r of n.roads) {
      if (r.status === "built") {
        expect(r.reason).toBeUndefined();
        expect(r.route).not.toBeNull();
        expect(r.entranceA).not.toBeNull();
        expect(r.entranceB).not.toBeNull();
      } else {
        expect(r.reason).toBeTruthy();
        expect(r.route).toBeNull();
      }
    }
    // at most a handful of settlements stay truly roadless, and only when
    // every rescue attempt also failed
    expect(n.isolated.length).toBeLessThanOrEqual(8);
  }, 600_000);

  it("classifies every road by the settlement hierarchy", () => {
    const n = network();
    for (const r of n.roads) {
      const a = nodeOf(n, r.a);
      const b = nodeOf(n, r.b);
      expect(r.cls).toBe(roadClassFor(a.tier, b.tier));
      if (r.cls === "major") {
        expect(a.tier === "city" || b.tier === "city").toBe(true);
        expect(a.tier !== "hamlet" && b.tier !== "hamlet").toBe(true);
      }
      if (r.cls === "regional") expect(a.tier !== "hamlet" || b.tier !== "hamlet").toBe(true);
    }
  }, 600_000);

  it("keeps national trunks national and lets bridges cross banners", () => {
    const n = network();
    for (const r of n.roads) {
      const cross = nodeOf(n, r.a).nation !== nodeOf(n, r.b).nation;
      expect(r.crossNational).toBe(cross);
      if (r.crossNational) expect(r.kind).toBe("bridge");
    }
    const crosses = n.roads.filter((r) => r.crossNational && r.status === "built");
    const internal = n.roads.filter((r) => !r.crossNational && r.status === "built");
    // cross-national roads exist but stay uncommon against the national web
    expect(crosses.length).toBeGreaterThan(0);
    expect(crosses.length).toBeLessThan(internal.length / 3);
  }, 600_000);

  it("is a web, not a mesh — no settlement is joined to every other", () => {
    const n = network();
    const S = n.settlements.length;
    expect(S * (S - 1) / 2).toBeGreaterThan(n.roads.length * 8);
    // every connected settlement has a small handful of roads at most
    for (const s of n.settlements) {
      const rs = settlementRoads(n, s.id);
      expect(rs.length).toBeLessThanOrEqual(12);
    }
  }, 600_000);

  it("builds real, walkable routes that honor closed country", () => {
    const n = network();
    const world = getWorld(SEED);
    for (const r of n.roads) {
      if (r.status !== "built" || !r.route) continue;
      const ea = r.entranceA!;
      const eb = r.entranceB!;
      const eaE = nodeOf(n, r.a).entrances.find((e) => e.id === ea)!;
      const ebE = nodeOf(n, r.b).entrances.find((e) => e.id === eb)!;
      expect(r.route[0]).toEqual({ x: eaE.x, y: eaE.y });
      expect(r.route[r.route.length - 1]).toEqual({ x: ebE.x, y: ebE.y });
      for (const p of r.route) {
        const site = world.siteAt(p.x, p.y);
        expect(site?.wall ?? false).toBe(false);
        expect(site?.door ?? false).toBe(false);
        // roads are laid on land only — never on open water
        expect(world.passable(p.x, p.y)).toBe(true);
        // no route cuts through a third settlement's ground
        for (const f of world.featuresNear(p.x, p.y, 69)) {
          if (!isSettlement(f)) continue;
          const id = settlementId(f);
          if (id === r.a || id === r.b) continue;
          const half = getSettlementFootprint(settlementTier(f) ?? "hamlet").w >> 1;
          expect(Math.max(Math.abs(p.x - f.x), Math.abs(p.y - f.y)) <= half).toBe(false);
        }
      }
    }
  }, 600_000);

  it("marks the strongest class on every shared tile, never a conflict", () => {
    const n = network();
    for (const r of n.roads) {
      if (r.status !== "built" || !r.route) continue;
      for (const p of r.route) {
        const mark = n.tiles.get(p.y * 4096 + p.x);
        expect(mark).toBeDefined();
        expect(ROAD_CLASS_RANK[mark!]).toBeGreaterThanOrEqual(ROAD_CLASS_RANK[r.cls]);
      }
    }
    const marks = roadAt(getWorld(SEED), ...firstRoadTile(n));
    expect(marks).not.toBeNull();
  }, 600_000);

  it("makes roads fast going — packed earth beats the marsh and the scree", () => {
    const n = network();
    const world = getWorld(SEED);
    let checked = 0;
    for (const r of n.roads) {
      if (r.status !== "built" || !r.route) continue;
      for (const p of r.route) {
        const t = world.tile(p.x, p.y);
        if (t.biome === "marsh" || t.biome === "mountain" || t.biome === "snow") {
          expect(tileCost(world, 0, p.x, p.y)).toBe(1);
          if (++checked >= 5) return;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 600_000);

  it("produces the identical network from the same seed, fresh instances", () => {
    const dump = (n: RoadNetwork): string =>
      JSON.stringify({
        s: n.settlements.map((x) => [x.id, x.nation, x.tier, x.entrances.map((e) => e.id)]),
        r: n.roads.map((r) => [r.id, r.cls, r.kind, r.crossNational, r.status, r.reason ?? 0, r.route]),
        t: [...n.tiles.entries()].sort((x, y) => x[0] - y[0]),
        bd: [...n.bridges].sort((x, y) => x - y),
        pa: [...n.paths].sort((x, y) => x - y),
        i: n.isolated,
      });
    const a = finishRoads(new World(SEED));
    const b = finishRoads(new World(SEED));
    expect(dump(a)).toBe(dump(b));
    expect(dump(a)).toBe(dump(network()));
  }, 600_000);

  it("builds the same network pumped in slices as drained at once", () => {
    const world = new World(SEED);
    roadNetworkOf(world);
    for (let i = 0; i < 40; i++) pumpRoads(world, 25);
    const finished = finishRoads(world);
    expect(finished.roads.length).toBe(network().roads.length);
    expect(finished.tiles.size).toBe(network().tiles.size);
    expect(finished.paths.size).toBe(network().paths.size);
    expect(finished.isolated).toEqual(network().isolated);
  }, 600_000);

  it("builds roads wider than the survey line — a lane per class", () => {
    const n = network();
    const world = getWorld(SEED);
    // every marked tile outside the centerlines is the widening swath
    const center = new Set<number>();
    for (const r of n.roads) {
      if (r.status !== "built" || !r.route) continue;
      expect(ROAD_WIDTH[r.cls]).toBeGreaterThanOrEqual(2);
      for (const p of r.route) center.add(p.y * 4096 + p.x);
    }
    // some swath exists beyond the centerlines, and widening never lands
    // on water, walls, doors or peaks
    let swath = 0;
    for (const k of n.tiles.keys()) {
      if (center.has(k)) continue;
      swath++;
      const x = k % 4096;
      const y = Math.floor(k / 4096);
      const b = world.tile(x, y).biome;
      expect(b === "river" || b === "lake" || b === "sea" || b === "deep").toBe(false);
      expect(b).not.toBe("peak");
      const site = world.siteAt(x, y);
      expect(site?.wall ?? false).toBe(false);
      expect(site?.door ?? false).toBe(false);
    }
    expect(swath).toBeGreaterThan(n.roads.length);
  }, 600_000);

  it("generates on land only — never a road tile on open water", () => {
    const n = network();
    const world = getWorld(SEED);
    let wet = 0;
    for (const r of n.roads) {
      if (r.status !== "built" || !r.route) continue;
      for (const p of r.route) {
        const b = world.tile(p.x, p.y).biome;
        const site = world.siteAt(p.x, p.y);
        // open water never carries a road; a settlement's reclaimed river-bed
        // floor (a site tile inside the hamlet) is land like any other
        if (b === "river" || b === "lake" || b === "sea" || b === "deep") {
          expect(site && !site.wall && !site.door).toBe(true);
          wet++;
        }
        expect(world.passable(p.x, p.y)).toBe(true);
      }
    }
    for (const k of n.tiles.keys()) {
      const b = world.tile(k % 4096, Math.floor(k / 4096)).biome;
      if (b === "river" || b === "lake" || b === "sea" || b === "deep") {
        const site = world.siteAt(k % 4096, Math.floor(k / 4096));
        expect(site && !site.wall && !site.door).toBe(true);
        wet++;
      }
    }
    // any water tile under a road is reclaimed settlement ground, never open water
    expect(n.bridges.size).toBe(0);
    expect(bridgeAt(getWorld(SEED), ...firstRoadTile(n))).toBe(false);
  }, 600_000);

  it("walks every building's door to the green with a trodden path", () => {
    const n = network();
    const world = getWorld(SEED);
    // path tiles keep to their own settlement's ground: no water, no peaks,
    // no walls, nothing outside every footprint
    for (const k of n.paths) {
      const x = k % 4096;
      const y = Math.floor(k / 4096);
      const b = world.tile(x, y).biome;
      expect(b === "river" || b === "lake" || b === "sea" || b === "deep" || b === "peak").toBe(false);
      const site = world.siteAt(x, y);
      expect(site?.wall ?? false).toBe(false);
      expect(site?.door ?? false).toBe(false);
      expect(
        n.settlements.some((s) => Math.max(Math.abs(x - s.x), Math.abs(y - s.y)) <= s.half),
      ).toBe(true);
    }
    expect(n.paths.size).toBeGreaterThan(0);
    // nearly every building with an external door has a path (or road) at it
    let served = 0;
    let total = 0;
    for (const s of n.settlements) {
      const f = world.tile(s.x, s.y).feature;
      if (!f) continue;
      for (const b of world.settlementLayout(f).buildings) {
        let hasDoor = false;
        let has = false;
        for (const d of b.doors) {
          if (!d.external || !d.dir) continue;
          hasDoor = true;
          const v = d.dir === "n" ? [0, -1] : d.dir === "s" ? [0, 1] : d.dir === "w" ? [-1, 0] : [1, 0];
          const k = (b.y + d.ly + v[1]) * 4096 + (b.x + d.lx + v[0]);
          if (n.paths.has(k) || n.tiles.has(k)) has = true;
        }
        if (hasDoor) {
          total++;
          if (has) served++;
        }
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(served / total).toBeGreaterThan(0.95);
  }, 600_000);

  it("carries travelers who walk the roads between settlements", () => {
    const n = network();
    const world = getWorld(SEED);
    const tick = 6000;
    const travelers = world.roadTravelers(tick);
    expect(travelers.length).toBeGreaterThan(0);
    for (const t of travelers) {
      expect(t.role).toBe("traveler");
      expect(n.tiles.has(t.y * 4096 + t.x)).toBe(true);
      expect(world.passable(t.x, t.y)).toBe(true);
      // bound for a real place — settlements may share a name, so the
      // distinctness is the road's own: its two endpoints are different ids
      expect(t.boundFor).toBeTruthy();
      expect(t.settlement).toBeTruthy();
    }
    // deterministic: the same seed and tick walk the same people
    const w2 = new World(SEED);
    finishRoads(w2);
    expect(JSON.stringify(w2.roadTravelers(tick))).toEqual(JSON.stringify(travelers));
    // they actually walk as the day passes
    const later = world.roadTravelers(tick + 30);
    expect(travelers.some((t) => later.some((l) => l.name === t.name && (l.x !== t.x || l.y !== t.y)))).toBe(true);
    // npcAt greets a traveler at their tile (a resident may share a road tile
    // for a tick; someone on the road is always resolvable)
    const met = travelers.find((t) => world.npcAt(t.x, t.y, tick)?.role === "traveler");
    expect(met).toBeTruthy();
    expect(world.npcAt(met!.x, met!.y, tick)!.name).toBe(met!.name);
  }, 600_000);

  it("draws map road lines that keep to their routes", () => {
    const n = network();
    const built = n.roads.filter((r) => r.status === "built");
    const lines = mapRoadLines(n, 8);
    expect(lines.length).toBe(built.length);
    for (const line of lines) {
      const route = line.road.route!;
      expect(route.length).toBeGreaterThan(0);
      for (const p of line.pts) {
        expect(route.some((q) => q.x === p.x && q.y === p.y)).toBe(true);
      }
      expect(line.pts[0]).toEqual(route[0]);
      expect(line.pts[line.pts.length - 1]).toEqual(route[route.length - 1]);
    }
  }, 600_000);

  it("indexes every deliberate entrance for the map and NPC layers", () => {
    const n = network();
    for (const s of n.settlements) {
      for (const e of s.entrances) {
        expect(n.entranceTiles.has(e.y * 4096 + e.x)).toBe(true);
        expect(settlementEntranceAt(n, e.x, e.y)?.id).toBe(e.id);
      }
    }
  }, 600_000);

  it("never lays a road on any part of a building", () => {
    const n = network();
    const world = getWorld(SEED);
    const center = new Set<number>();
    for (const r of n.roads) {
      if (r.status !== "built" || !r.route) continue;
      for (const p of r.route) center.add(p.y * 4096 + p.x);
    }
    const solidAt = (x: number, y: number): boolean => {
      const sp = world.siteAt(x, y);
      return !!sp && !!(sp.wall || sp.door || sp.buildingId);
    };
    let onBuilding = 0;
    let squeezedSwath = 0;
    for (const k of n.tiles.keys()) {
      const x = k % 4096;
      const y = Math.floor(k / 4096);
      if (solidAt(x, y)) {
        onBuilding++;
        continue;
      }
      if (center.has(k)) continue;
      const squeezed =
        (solidAt(x - 1, y) && solidAt(x, y - 1)) ||
        (solidAt(x + 1, y) && solidAt(x, y - 1)) ||
        (solidAt(x - 1, y) && solidAt(x, y + 1)) ||
        (solidAt(x + 1, y) && solidAt(x, y + 1));
      if (squeezed) squeezedSwath++;
    }
    expect(onBuilding).toBe(0);
    expect(squeezedSwath).toBe(0);
  }, 600_000);

  it("meets the town at its gate and walks a lane to the green", () => {
    const n = network();
    // inside an endpoint's footprint, a route keeps to the entrance apron
    for (const r of n.roads) {
      if (r.status !== "built" || !r.route) continue;
      for (const endId of [r.a, r.b]) {
        const node = nodeOf(n, endId);
        const en = node.entrances.find((e) => e.id === (r.a === endId ? r.entranceA : r.entranceB));
        expect(en).toBeDefined();
        for (const p of r.route) {
          if (Math.max(Math.abs(p.x - node.x), Math.abs(p.y - node.y)) > node.half) continue;
          expect(Math.max(Math.abs(p.x - en!.x), Math.abs(p.y - en!.y))).toBeLessThanOrEqual(3);
        }
      }
    }
    // and every gate a road arrives at is lane-connected to the green at the
    // heart of its settlement
    const laneConnected = (endId: string, en: { x: number; y: number }): boolean => {
      const node = nodeOf(n, endId);
      let goal: { x: number; y: number } | null = null;
      outer: for (let rr = 0; rr <= 3; rr++) {
        for (let dy = -rr; dy <= rr; dy++) {
          for (let dx = -rr; dx <= rr; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== rr) continue;
            const x = node.x + dx;
            const y = node.y + dy;
            if (Math.max(Math.abs(x - node.x), Math.abs(y - node.y)) > node.half) continue;
            if (n.tiles.has(y * 4096 + x)) {
              goal = { x, y };
              break outer;
            }
          }
        }
      }
      if (!goal) return false;
      const seen = new Set<number>([goal.y * 4096 + goal.x]);
      const q: [number, number][] = [[goal.x, goal.y]];
      while (q.length) {
        const [cx, cy] = q.shift()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          const k = ny * 4096 + nx;
          if (seen.has(k)) continue;
          if (Math.max(Math.abs(nx - node.x), Math.abs(ny - node.y)) > node.half) continue;
          if (!n.tiles.has(k)) continue;
          seen.add(k);
          q.push([nx, ny]);
        }
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (seen.has((en.y + dy) * 4096 + en.x + dx)) return true;
        }
      }
      return false;
    };
    let gates = 0;
    for (const r of n.roads) {
      if (r.status !== "built" || !r.route) continue;
      for (const endId of [r.a, r.b]) {
        const node = nodeOf(n, endId);
        const en = node.entrances.find((e) => e.id === (r.a === endId ? r.entranceA : r.entranceB))!;
        gates++;
        expect(laneConnected(endId, { x: en.x, y: en.y })).toBe(true);
      }
    }
    expect(gates).toBeGreaterThan(0);
  }, 600_000);

  it("makes every entrance a real gate — solid posts flanking the way in", () => {
    const n = network();
    const world = getWorld(SEED);
    let posts = 0;
    for (const s of n.settlements) {
      for (const e of s.entrances) {
        const outX = e.dir === "w" ? -1 : e.dir === "e" ? 1 : 0;
        const outY = e.dir === "n" ? -1 : e.dir === "s" ? 1 : 0;
        const perpX = outY !== 0 ? 1 : 0;
        const perpY = outX !== 0 ? 1 : 0;
        // both flanks carry a solid gatepost or an existing wall
        let flanks = 0;
        for (const side of [-1, 1]) {
          for (const [fx, fy] of [[e.x + outX + perpX * side, e.y + outY + perpY * side], [e.x + perpX * side, e.y + perpY * side]]) {
            const sp = world.siteAt(fx, fy);
            if (!sp) {
              // a waterfront flank is its own gate
              const b = world.tile(fx, fy).biome;
              if (["river", "lake", "sea", "deep"].includes(b)) flanks++;
              continue;
            }
            if (sp.post) {
              flanks++;
              posts++;
              // a post is a solid structure, never on the road, never on water
              expect(sp.wall).toBe(true);
              expect(n.tiles.has(fy * 4096 + fx)).toBe(false);
              const b = world.tile(fx, fy).biome;
              expect(["river", "lake", "sea", "deep"]).not.toContain(b);
            } else if (sp.wall || sp.door || sp.buildingId) flanks++;
            if (sp.post || sp.wall || sp.door || sp.buildingId) break;
          }
        }
        expect(flanks).toBeGreaterThanOrEqual(1);
      }
    }
    expect(posts).toBeGreaterThan(0);
  }, 600_000);

  it("leaves settlement, terrain and height generation untouched", () => {
    const n = network();
    const world = getWorld(SEED);
    expect(n.settlements.length).toBe(world.allFeatures().filter((f) => ["hamlet", "town", "city"].includes(f.kind)).length);
    // the heightfield answers as it always did off the roads
    const off = roadAt(world, 0, 0);
    expect(off).toBeNull();
    expect(heightOf(world).level(2048, 2048)).toBeGreaterThanOrEqual(0);
    expect(getFactions(SEED, world).nations.length).toBeGreaterThan(0);
  }, 600_000);
});

function firstRoadTile(n: RoadNetwork): [number, number] {
  for (const r of n.roads) {
    if (r.status === "built" && r.route?.length) return [r.route[0].x, r.route[0].y];
  }
  return [0, 0];
}
