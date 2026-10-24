import { describe, expect, it } from "vitest";

import { SPECIES } from "@/game/data";
import { SKY, SURFACE, UW, PLAYER_MOVER, heightOf, moverOf, tierName, walkable, heightLOS } from "@/game/height";
import { objectAt } from "@/game/objects";
import { advance, changeLayer, columnBodies, loadChunks, newGame, previewStarter } from "@/game/sim";
import { territoryOf } from "@/game/territory";
import { perceiveWildlife } from "@/game/wildlife";
import type { GameState, WildCreature } from "@/game/types";
import { getWorld } from "@/game/world";

const SEED = 20260101;
const world = getWorld(SEED);
const hf = heightOf(world);

/** First tile matching a predicate on a coarse scan grid (fast, deterministic). */
const findTile = (pred: (x: number, y: number) => boolean, from = 200): { x: number; y: number } | null => {
  for (let y = from; y < 3900; y += 13) {
    for (let x = from; x < 3900; x += 13) {
      if (pred(x, y)) return { x, y };
    }
  }
  return null;
};

describe("physical objects on the surface", () => {
  it("an object tile blocks walking, sight and shots; open ground beside it does not", () => {
    const clearRow = (x: number, y: number): boolean =>
      [x - 1, x, x + 1].every((ax) => objectAt(world, ax, y) === null && world.passable(ax, y));
    const spot = findTile((x, y) => objectAt(world, x, y) !== null && clearRow(x, y + 1));
    expect(spot).not.toBeNull();
    expect(walkable(world, 0, spot!.x, spot!.y)).toBe(false);
    expect(walkable(world, 0, spot!.x + 1, spot!.y + 1)).toBe(true);
    // sight: a line crossing the object tile is blocked, the clear row beside it is not
    expect(heightLOS(world, 0, spot!.x - 2, spot!.y, spot!.x + 2, spot!.y)).toBe(false);
    expect(heightLOS(world, 0, spot!.x - 1, spot!.y + 1, spot!.x + 1, spot!.y + 1)).toBe(true);
  });

  it("every reserved space stays clear: settlements, their grounds, landmark plateaus and cave mouths", () => {
    let settlements = 0;
    let mouths = 0;
    let checked = 0;
    for (let cy = 4; cy < 167 && settlements < 6; cy++) {
      for (let cx = 4; cx < 167; cx++) {
        const f = world.featureCell(cx, cy);
        if (!f) continue;
        settlements++;
        for (let dy = -12; dy <= 12; dy++) {
          for (let dx = -12; dx <= 12; dx++) {
            const x = f.x + dx;
            const y = f.y + dy;
            if (!world.inBounds(x, y)) continue;
            if (world.siteAt(x, y) || (world.tile(x, y).feature && Math.max(Math.abs(dx), Math.abs(dy)) <= 6)) {
              checked++;
              expect(objectAt(world, x, y)).toBeNull();
            }
          }
        }
        if (settlements >= 6) break;
      }
    }
    expect(settlements).toBeGreaterThan(2);
    expect(checked).toBeGreaterThan(100);
    for (const m of hf.mouthsIn(0, 0, 4095, 4095)) {
      mouths++;
      expect(objectAt(world, m.x, m.y)).toBeNull();
      expect(objectAt(world, m.x, m.y + 1)).toBeNull();
      expect(objectAt(world, m.x, m.y + 2)).toBeNull();
      if (mouths > 40) break;
    }
    expect(mouths).toBeGreaterThan(5);
  }, 30000);

  it("placement is natural, not uniform: dense forest groves, thin glades, near-empty meadows", () => {
    const density = (cx: number, cy: number): number => {
      let objs = 0;
      for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) if (objectAt(world, cx + dx, cy + dy)) objs++;
      return objs / 289;
    };
    const dense = findTile((x, y) => world.tile(x, y).biome === "forest" && density(x, y) > 0.3);
    expect(dense).not.toBeNull();
    const meadow = findTile((x, y) => world.tile(x, y).biome === "meadow" && density(x, y) < 0.15);
    expect(meadow).not.toBeNull();
  });

  it("a body trapped by objects can always find open ground nearby", () => {
    const dense = findTile((x, y) => objectAt(world, x, y) !== null);
    expect(dense).not.toBeNull();
    const ring = walkable(world, 0, dense!.x + 1, dense!.y) || walkable(world, 0, dense!.x - 1, dense!.y) || walkable(world, 0, dense!.x, dense!.y + 1) || walkable(world, 0, dense!.x, dense!.y - 1);
    expect(ring).toBe(true);
  });
});

describe("the open sky", () => {
  it("thermals rise over high proud land, never over water, settlements or objects", () => {
    let thermal = 0;
    let land = 0;
    for (let y = 200; y < 3900; y += 24) {
      for (let x = 200; x < 3900; x += 24) {
        if (hf.thermalAt(x, y)) {
          thermal++;
          const t = world.tile(x, y);
          expect(t.biome === "deep" || t.biome === "sea" || t.biome === "lake" || t.biome === "river").toBe(false);
          expect(world.siteAt(x, y)).toBeNull();
          expect(objectAt(world, x, y)).toBeNull();
        }
        if (!hf.isSwim(x, y)) land++;
      }
    }
    expect(thermal).toBeGreaterThan(20);
    expect(land).toBeGreaterThan(thermal);
  });

  it("a flier rides a thermal up and can descend anywhere; a walker cannot rise", () => {
    const spot = findTile((x, y) => hf.thermalAt(x, y));
    expect(spot).not.toBeNull();
    expect(hf.transitionAt(0, spot!.x, spot!.y, { ...PLAYER_MOVER, flies: true })).toBe(SKY);
    expect(hf.transitionAt(0, spot!.x, spot!.y, PLAYER_MOVER)).toBeNull();
    expect(hf.transitionAt(SKY, spot!.x, spot!.y, { ...PLAYER_MOVER, flies: true })).toBe(0);
    expect(tierName(0, SKY)).toBe("Open Sky");
  });

  it("the sky has no resident population — fliers belong to the ground", () => {
    const gs: GameState = newGame("SKY-1", "Rook", "ranger", "#e8742a", previewStarter("SKY-1", "mossback"));
    loadChunks(gs);
    expect(columnBodies(gs, SKY)).toHaveLength(0);
    // every flying body the world spawns is a grounded surface animal
    const fliers = Object.values(gs.creatures).filter((c) => moverOf(c.speciesId).flies);
    for (const c of fliers) expect(c.layer ?? SURFACE).toBe(SURFACE);
  }, 30000);

  it("a fed flier takes off anywhere and lands again; a grounded flier needs no thermal", () => {
    const gs: GameState = newGame("WING-1", "Rook", "ranger", "#e8742a", previewStarter("WING-1", "mossback"));
    gs.tick = 12 * 60; // noon: diurnal bodies are awake
    loadChunks(gs);
    // pick a flier the simulation actually carries (within SIM_R of the player)
    const flier: WildCreature | undefined = Object.values(gs.creatures)
      .filter((c) => (c.layer ?? SURFACE) === SURFACE && SPECIES[c.speciesId].traits.includes("flutter"))
      .sort((a, b) => Math.max(Math.abs(a.x - gs.player.x), Math.abs(a.y - gs.player.y)) - Math.max(Math.abs(b.x - gs.player.x), Math.abs(b.y - gs.player.y)))[0];
    expect(flier).toBeDefined();
    flier!.satiety = 95;
    let tookOff = false;
    for (let i = 0; i < 2400 && !tookOff; i++) {
      advance(gs, 1);
      tookOff = gs.creatures[flier!.id]?.layer === SKY;
    }
    expect(tookOff).toBe(true);
    // a fed body comes back down: hunger lands it on open ground. Bring the
    // traveler back over the player first — bodies beyond the sim radius rest
    // frozen, and a long aloft errand can carry one past it.
    const body = gs.creatures[flier!.id];
    expect(body).toBeDefined();
    const w = getWorld(gs.seed);
    const spot = [[1, 0], [0, 1], [2, 0], [0, 2], [1, 1], [-1, 0], [0, -1], [-1, -1]].map(([dx, dy]) => ({ x: gs.player.x + dx, y: gs.player.y + dy })).find((p) => walkable(w, SURFACE, p.x, p.y));
    expect(spot).toBeDefined();
    body!.x = spot!.x;
    body!.y = spot!.y;
    body!.satiety = 10;
    let landed = false;
    for (let i = 0; i < 2400 && !landed; i++) {
      advance(gs, 1);
      landed = gs.creatures[body!.id]?.layer === undefined;
    }
    expect(landed).toBe(true);
  }, 30000);

  it("an airborne predator dives at the player and engages on the ground", () => {
    const gs: GameState = newGame("DIVE-1", "Rook", "ranger", "#e8742a", previewStarter("DIVE-1", "mossback"));
    gs.tick = 12 * 60;
    loadChunks(gs);
    const flier: WildCreature | undefined = Object.values(gs.creatures)
      .filter((c) => (c.layer ?? SURFACE) === SURFACE && SPECIES[c.speciesId].traits.includes("flutter"))
      .sort((a, b) => Math.max(Math.abs(a.x - gs.player.x), Math.abs(a.y - gs.player.y)) - Math.max(Math.abs(b.x - gs.player.x), Math.abs(b.y - gs.player.y)))[0];
    expect(flier).toBeDefined();
    // stage the ambush: hungry, aggressive, close overhead, over landable ground
    const w2 = getWorld(gs.seed);
    const over = [[2, 0], [0, 2], [2, 2], [-2, 0], [0, -2], [1, 1]].map(([dx, dy]) => ({ x: gs.player.x + dx, y: gs.player.y + dy })).find((p) => walkable(w2, SURFACE, p.x, p.y));
    expect(over).toBeDefined();
    // clear the stage: no rival predators to scare the diver off, no rival prey
    for (const o of Object.values(gs.creatures)) {
      if (o !== flier && Math.max(Math.abs(o.x - gs.player.x), Math.abs(o.y - gs.player.y)) <= 15) delete gs.creatures[o.id];
    }
    flier!.satiety = 10;
    flier!.disposition = "aggressive";
    flier!.stalking = false;
    flier!.x = over!.x;
    flier!.y = over!.y;
    flier!.layer = SKY;
    let landed = false;
    let fed = false;
    for (let i = 0; i < 2400 && !(landed && fed); i++) {
      advance(gs, 1);
      const b = gs.creatures[flier!.id];
      if (!b) {
        // a landed body may fall in the fight it picked — that is engagement
        if (landed) fed = true;
        break;
      }
      if (b.layer === undefined) {
        landed = true;
        // it hunts: stalks the player, or feeds on whatever prey it scented
        fed = fed || b.stalking === true || b.satiety > 15;
      }
    }
    const fin = gs.creatures[flier!.id];
    const diag = fin ? `${fin.activity} layer ${fin.layer ?? 0} sat ${fin.satiety.toFixed(0)} at ${fin.x},${fin.y}` : `body gone; removed@${gs.removed[flier!.id]} log:${gs.log.slice(-4).map((l) => l.text).join(" | ")}`;
    expect(landed, diag).toBe(true);
    expect(fed, diag).toBe(true);
  }, 30000);

  it("a flier's territory spans ground and the sky above it", () => {
    const gs: GameState = newGame("AIR-1", "Rook", "ranger", "#e8742a", previewStarter("AIR-1", "mossback"));
    loadChunks(gs);
    const flier: WildCreature | undefined = Object.values(gs.creatures).find((c) => SPECIES[c.speciesId].traits.includes("flutter") && !!territoryOf(gs, c));
    expect(flier).toBeDefined();
    const terr = territoryOf(gs, flier!)!;
    const intruder: WildCreature | undefined = Object.values(gs.creatures).find((o) => o !== flier && !o.pack);
    expect(intruder).toBeDefined();
    // the same body, aloft over the range, is still an intruder in it
    intruder!.x = terr.x + 2;
    intruder!.y = terr.y;
    intruder!.layer = SKY;
    const per = perceiveWildlife(gs, flier!, [intruder!], terr, gs.tick);
    expect(per.intruder).toBe(intruder);
    // and the column renderer's shadow source is exactly the bodies aloft
    expect(columnBodies(gs, SKY)).toContain(intruder);
  }, 30000);
});

describe("the world beneath the deep", () => {
  it("the seafloor exists only beneath deep water", () => {
    for (let y = 100; y < 4000; y += 31) {
      for (let x = 100; x < 4000; x += 31) {
        if (!hf.uwOpen(x, y)) continue;
        const b = world.tile(x, y).biome;
        expect(b === "deep" || b === "lake").toBe(true);
      }
    }
  });

  it("a swimmer dives from deep water and surfaces again; a walker cannot", () => {
    const spot = findTile((x, y) => hf.uwOpen(x, y) && world.tile(x, y).biome === "deep");
    expect(spot).not.toBeNull();
    expect(hf.transitionAt(0, spot!.x, spot!.y, { ...PLAYER_MOVER, swims: true })).toBe(UW);
    expect(hf.transitionAt(0, spot!.x, spot!.y, PLAYER_MOVER)).toBeNull();
    expect(hf.transitionAt(UW, spot!.x, spot!.y, { ...PLAYER_MOVER, swims: true })).toBe(0);
    expect(tierName(0, UW)).toBe("Underwater");
  });

  it("the seafloor loads with the surface — the column needs no travel", () => {
    const gs: GameState = newGame("COL-1", "Rook", "ranger", "#e8742a", previewStarter("COL-1", "mossback"));
    const dive = findTile((x, y) => hf.uwOpen(x, y) && world.tile(x, y).biome === "deep");
    gs.player.x = dive!.x;
    gs.player.y = dive!.y;
    // no changeLayer: the player stays on the surface, and the seafloor below
    // still fills with its own swimming population
    loadChunks(gs);
    const sea = columnBodies(gs, UW);
    expect(sea.length).toBeGreaterThan(0);
    for (const c of sea) {
      expect(SPECIES[c.speciesId].swims).toBe(true);
      expect(hf.uwOpen(c.x, c.y)).toBe(true);
    }
  }, 30000);

  it("the seafloor spawns swimming creatures only", () => {
    const gs: GameState = newGame("DEEP-1", "Rook", "ranger", "#e8742a", previewStarter("DEEP-1", "mossback"));
    const dive = findTile((x, y) => hf.uwOpen(x, y) && world.tile(x, y).biome === "deep");
    gs.player.x = dive!.x;
    gs.player.y = dive!.y;
    changeLayer(gs, UW);
    loadChunks(gs);
    const sea = Object.values(gs.creatures).filter((c) => c.layer === UW);
    expect(sea.length).toBeGreaterThan(0);
    for (const c of sea) {
      expect(SPECIES[c.speciesId].swims).toBe(true);
      expect(walkable(getWorld(gs.seed), UW, c.x, c.y)).toBe(true);
      expect(hf.uwOpen(c.x, c.y)).toBe(true);
    }
  }, 30000);
});

describe("the vertical world is deterministic", () => {
  it("the same seed regenerates every layer tile-for-tile", () => {
    const a = getWorld(4242);
    const b = getWorld(4242);
    const ha = heightOf(a);
    const hb = heightOf(b);
    for (let y = 600; y < 700; y++) {
      for (let x = 600; x < 700; x++) {
        expect(objectAt(a, x, y)).toBe(objectAt(b, x, y));
        expect(ha.thermalAt(x, y)).toBe(hb.thermalAt(x, y));
        expect(ha.uwOpen(x, y)).toBe(hb.uwOpen(x, y));
        expect(ha.skyDecor(x, y)).toBe(hb.skyDecor(x, y));
      }
    }
  });
});
