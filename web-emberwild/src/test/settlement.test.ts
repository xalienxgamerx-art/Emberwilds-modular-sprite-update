import { describe, expect, it } from "vitest";

import {
  SETTLEMENT_TIERS,
  getSettlementFootprint,
  hasSettlementTier,
  isSettlement,
  settlementId,
  settlementSeed,
  settlementTier,
} from "@/game/settlement";
import { getWorld, type Feature } from "@/game/world";

const hamlet: Feature = { kind: "hamlet", name: "Greywick", x: 100, y: 100, speciesId: null };
const ruin: Feature = { kind: "ruin", name: "Oldstones", x: 0, y: 0, speciesId: null };

describe("settlement model", () => {
  it("classifies settlements by tier and rejects everything else", () => {
    expect(SETTLEMENT_TIERS).toEqual(["hamlet", "town", "city"]);
    expect(isSettlement(hamlet)).toBe(true);
    expect(settlementTier(hamlet)).toBe("hamlet");
    expect(hasSettlementTier(hamlet, "hamlet")).toBe(true);
    expect(hasSettlementTier(hamlet, "town")).toBe(false);
    for (const f of [ruin, { kind: "shrine", name: "S", x: 0, y: 0, speciesId: null } as Feature, { kind: "lair", name: "L", x: 0, y: 0, speciesId: null } as Feature, null, undefined]) {
      expect(isSettlement(f)).toBe(false);
      expect(settlementTier(f)).toBeNull();
    }
  });

  it("defines one footprint per tier", () => {
    expect(getSettlementFootprint("hamlet")).toEqual({ w: 23, h: 23 });
    expect(getSettlementFootprint("town")).toEqual({ w: 46, h: 46 });
    expect(getSettlementFootprint("city")).toEqual({ w: 69, h: 69 });
  });

  it("derives stable identity and generation seeds from the feature", () => {
    expect(settlementId(hamlet)).toBe("s:100:100");
    expect(settlementId({ x: 101, y: 100 })).not.toBe(settlementId(hamlet));
    expect(settlementSeed(777, hamlet)).toBe(settlementSeed(777, { x: 100, y: 100 }));
    expect(settlementSeed(778, hamlet)).not.toBe(settlementSeed(777, hamlet));
  });

  it("generates a working, deterministic hamlet at the start", () => {
    const a = getWorld(424242);
    const b = getWorld(424242);
    const start = a.startPoint();
    const here = a.featuresNear(start.x, start.y, 6).find((f) => isSettlement(f) && f.x === start.x && f.y === start.y);
    expect(here).toBeDefined();
    expect(settlementTier(here)).toBe("hamlet");

    // the site structure is intact and the folk stand at their posts
    const center = a.siteAt(start.x, start.y);
    expect(center).not.toBeNull();
    expect(center?.wall).toBe(false);
    const npcs = a.settlementNpcs(here!);
    expect(npcs.length).toBe(3);
    for (const n of npcs) expect(a.npcAt(n.x, n.y)?.role).toBe(n.role);

    // the same seed rebuilds the same world, folk and layout
    const fa = a.featuresNear(start.x, start.y, 6).find((f) => isSettlement(f));
    const fb = b.featuresNear(b.startPoint().x, b.startPoint().y, 6).find((f) => isSettlement(f));
    expect(fa).toEqual(fb);
    expect(JSON.stringify(b.settlementNpcs(fb!))).toBe(JSON.stringify(npcs));
    expect(JSON.stringify(b.settlementLayout(fb!).buildings)).toBe(JSON.stringify(a.settlementLayout(here!).buildings));
  });

  it("keeps a full dry gap between every pair of settlement sites", () => {
    const world = getWorld(424242);
    const R: Record<string, number> = { hamlet: 11, town: 23, city: 34 };
    const setl: Feature[] = [];
    const cells = world as unknown as { cellFeature(cx: number, cy: number): Feature | null };
    for (let cy = 0; cy < 171; cy++) {
      for (let cx = 0; cx < 171; cx++) {
        const f = cells.cellFeature(cx, cy);
        if (f && isSettlement(f)) setl.push(f);
      }
    }
    expect(setl.length).toBeGreaterThan(100);
    for (let i = 0; i < setl.length; i++) {
      for (let j = i + 1; j < setl.length; j++) {
        const a = setl[i];
        const b = setl[j];
        const gap = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) - R[a.kind] - R[b.kind];
        expect(gap, `${a.name} (${a.kind}) sits too near ${b.name} (${b.kind})`).toBeGreaterThanOrEqual(12);
      }
    }
  }, 120_000);
});
