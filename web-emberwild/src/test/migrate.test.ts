import { describe, expect, it } from "vitest";

import { migrateLoaded } from "@/game/migrate";
import { newGame, previewStarter, SAVE_VERSION } from "@/game/sim";
import type { GameState } from "@/game/types";

const makeGs = (): GameState => {
  const gs = newGame("MIG-1", "Rook", "ranger", "#e8742a", previewStarter("MIG-1", "mossback"));
  gs.tick = 9999;
  gs.player.x = 1234;
  gs.player.y = 2345;
  return gs;
};

describe("save migration (Phase 8)", () => {
  it("a current save round-trips through migrateLoaded without losing player state", () => {
    const gs = makeGs();
    const json = JSON.stringify(gs);
    const parsed = JSON.parse(json) as GameState;
    expect(migrateLoaded(parsed)).toBe(true);
    expect(parsed.version).toBe(SAVE_VERSION);
    // player progress, inventory, creatures and world knowledge all survive
    expect(JSON.stringify(parsed.party)).toBe(JSON.stringify(gs.party));
    expect(JSON.stringify(parsed.pen)).toBe(JSON.stringify(gs.pen));
    expect(JSON.stringify(parsed.bag)).toBe(JSON.stringify(gs.bag));
    expect(parsed.player.x).toBe(1234);
    expect(parsed.player.y).toBe(2345);
    expect(parsed.seed).toBe(gs.seed);
    expect(parsed.seedText).toBe(gs.seedText);
    expect(parsed.tick).toBe(9999);
    expect(JSON.stringify(parsed.knowledge)).toBe(JSON.stringify(gs.knowledge));
  }, 30000);

  it("migration is idempotent — migrating twice changes nothing", () => {
    const parsed = JSON.parse(JSON.stringify(makeGs())) as GameState;
    expect(migrateLoaded(parsed)).toBe(true);
    const once = JSON.stringify(parsed);
    expect(migrateLoaded(parsed)).toBe(true);
    expect(JSON.stringify(parsed)).toBe(once);
  });

  it("a legacy v3 save is migrated: knowledge backfilled, party deployed", () => {
    const parsed = JSON.parse(JSON.stringify(makeGs())) as GameState & { version: number };
    delete parsed.knowledge;
    delete parsed.field;
    delete parsed.orders;
    parsed.version = 3;
    expect(migrateLoaded(parsed)).toBe(true);
    expect(parsed.version).toBe(SAVE_VERSION);
    expect(parsed.knowledge).toBeDefined();
    expect(Object.keys(parsed.knowledge.explored).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.field).length).toBeGreaterThan(0);
    expect(parsed.party[0].uid).toBeDefined();
  });

  it("a save from a newer build is refused, not silently downgraded", () => {
    const parsed = JSON.parse(JSON.stringify(makeGs())) as GameState & { version: number };
    parsed.version = SAVE_VERSION + 1;
    expect(migrateLoaded(parsed)).toBe(false);
  });

  it("malformed save data fails safely", () => {
    expect(migrateLoaded(null as unknown as GameState)).toBe(false);
    expect(migrateLoaded({} as unknown as GameState)).toBe(false);
    expect(migrateLoaded({ version: 22 } as unknown as GameState)).toBe(false);
    expect(migrateLoaded({ version: 22, seed: 1, player: {} } as unknown as GameState)).toBe(false);
    expect(migrateLoaded("garbage" as unknown as GameState)).toBe(false);
  });
});
