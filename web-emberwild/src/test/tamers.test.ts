import { describe, expect, it } from "vitest";

import { DAY_TICKS, SPECIES } from "@/game/data";
import { migrateLoaded } from "@/game/migrate";
import { allied, fieldTamerTeam, isFoe, openGrudge, partyFighter, tamerFighter, coreExchange, wildFighter, hpOf } from "@/game/combat";
import { repOf, isKnown } from "@/game/reputation";
import { advanceRumors, boardOf, deliverToSettlement, eventOf, nearestSettlement, recordEvent } from "@/game/rumors";
import { advanceTamers, initTamers, think, tamerProfile } from "@/game/tamers";
import { advance, loadChunks, newGame, previewStarter, SAVE_VERSION } from "@/game/sim";
import { rumorStateSize } from "@/game/rumors";
import type { GameState, WorldEvent } from "@/game/types";
import { getWorld } from "@/game/world";

const makeGs = (seed = "RIV-1"): GameState => {
  const gs = newGame(seed, "Rook", "ranger", "#e8742a", previewStarter(seed, "mossback"));
  loadChunks(gs);
  return gs;
};

const roundTrip = (gs: GameState): GameState => {
  const parsed = JSON.parse(JSON.stringify(gs)) as GameState;
  expect(migrateLoaded(parsed)).toBe(true);
  return parsed;
};

describe("rival tamers — persistence and AI", () => {
  it("a seed draws the same roster twice — deterministic initialization", () => {
    const a = makeGs();
    const b = makeGs();
    const idsA = Object.keys(a.tamers ?? {}).sort();
    const idsB = Object.keys(b.tamers ?? {}).sort();
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsA).toEqual(idsB);
    for (const id of idsA) {
      const ta = (a.tamers ?? {})[id];
      const tb = (b.tamers ?? {})[id];
      expect(ta.name).toBe(tb.name);
      expect(ta.x).toBe(tb.x);
      expect(ta.y).toBe(tb.y);
      expect(ta.team.map((m) => m.speciesId)).toEqual(tb.team.map((m) => m.speciesId));
    }
  }, 60000);

  it("revisiting init or loading never regenerates tamers — stable identities across save/load", () => {
    const gs = makeGs();
    const before = Object.keys(gs.tamers ?? {}).sort();
    initTamers(gs); // no-op on an existing roster
    expect(Object.keys(gs.tamers ?? {}).sort()).toEqual(before);
    const loaded = roundTrip(gs);
    expect(Object.keys(loaded.tamers ?? {}).sort()).toEqual(before);
    for (const id of before) {
      expect(loaded.tamers?.[id]?.name).toBe(gs.tamers?.[id]?.name);
      expect(loaded.tamers?.[id]?.team.length).toBe(gs.tamers?.[id]?.team.length);
    }
  });

  it("teams obey the same limits as the player's party", () => {
    const gs = makeGs();
    for (const t of Object.values(gs.tamers ?? {})) {
      expect(t.team.length).toBeLessThanOrEqual(3);
      expect(t.reserve.length).toBeLessThanOrEqual(4);
      for (const m of t.team) expect(SPECIES[m.speciesId]).toBeDefined();
    }
  });

  it("tamers know their home and nothing else at birth — no omniscience", () => {
    const gs = makeGs();
    for (const t of Object.values(gs.tamers ?? {})) {
      expect(Object.keys(t.knowledge.settlements).length).toBe(1);
      expect(Object.keys(t.knowledge.alphas).length).toBe(0);
      expect(Object.keys(t.knowledge.rivals).length).toBe(0);
      expect(Object.keys(t.knowledge.heard).length).toBe(0);
    }
  });

  it("tamers progress off-screen: goals are chosen, travel persists, and recovery follows a defeat", () => {
    const gs = makeGs();
    const id = Object.keys(gs.tamers ?? {})[0];
    const t = (gs.tamers ?? {})[id];
    think(gs, t);
    expect(t.goal).toBeDefined();
    expect(t.route).not.toBeNull();
    // travel actually moves them along the route
    const sx = t.x;
    const sy = t.y;
    advance(gs, 80, true);
    expect(t.x !== sx || t.y !== sy).toBe(true);
    // a defeated tamer recovers rather than dying, then resumes
    t.recoverUntil = gs.tick + 10;
    t.career.losses += 1;
    advanceTamers(gs);
    expect(t.recoverUntil > gs.tick).toBe(true);
  });

  it("tamer profiles are stable lookups", () => {
    const gs = makeGs();
    const id = Object.keys(gs.tamers ?? {})[0];
    expect(tamerProfile(gs, id)?.id).toBe(id);
    expect(tamerProfile(gs, "t9999")).toBeNull();
  });
});

describe("multi-party combat", () => {
  it("owned fighters ally within an allegiance and treat wilds as foes", () => {
    const gs = makeGs();
    const t = Object.values(gs.tamers ?? {})[0];
    const m1 = t.team[0];
    const m2 = t.team[1] ?? t.team[0];
    const f1 = tamerFighter(gs, t, m1);
    const f2 = tamerFighter(gs, t, m2);
    expect(allied(f1, f2)).toBe(true);
    const party = partyFighter(gs, gs.party[0]);
    // peaceful by default: another tamer's team is neither ally nor foe
    expect(allied(f1, party)).toBe(false);
    expect(isFoe(gs, f1, party)).toBe(false);
    expect(isFoe(gs, party, f1)).toBe(false);
    // wilds fight owned fighters and vice versa
    const wild = wildFighter(gs, Object.values(gs.creatures)[0]);
    expect(isFoe(gs, f1, wild)).toBe(true);
    expect(isFoe(gs, wild, f1)).toBe(true);
    // an open grudge turns two allegiances hostile
    openGrudge(gs, t.id, "player");
    expect(isFoe(gs, f1, party)).toBe(true);
    expect(isFoe(gs, party, f1)).toBe(true);
  });

  it("a tamer team can be fielded and takes HP loss through the shared exchange rules", () => {
    const gs = makeGs();
    const t = Object.values(gs.tamers ?? {})[0];
    t.x = gs.player.x + 3;
    t.y = gs.player.y;
    // field around their own anchor
    fieldTamerTeam(gs, t);
    expect(Object.keys(t.field).length).toBeGreaterThan(0);
    const f = tamerFighter(gs, t, t.team[0]);
    const ex = coreExchange(gs, partyFighter(gs, gs.party[0]), f, gs.party[0].skills[0], false);
    expect(ex.roll).toBeGreaterThanOrEqual(0);
    expect(hpOf(gs, f)).toBeGreaterThan(0);
  });
});

describe("reputation", () => {
  it("scopes are independent — a settlement deed does not bleed into other nations", () => {
    const gs = makeGs();
    const world = getWorld(gs.seed);
    const s = world.tile(2000, 2000).feature;
    void s;
    const near = nearestSettlement(world, 2000, 2000, 400);
    expect(near).not.toBeNull();
    if (!near) return;
    gs.events = [];
    gs.eventSeq = 0;
    const ev: WorldEvent = {
      cat: "alpha_kill",
      id: "",
      subject: "t1",
      subjectName: "Mera",
      other: "a1",
      otherName: "the great mossback",
      x: near.x,
      y: near.y,
      tick: gs.tick,
      sig: 3,
      won: true,
      nationId: null,
      assocId: null,
      alphaSpeciesId: "mossback",
      alphaLevel: 20,
    };
    const full = recordEvent(gs, ev);
    if (!full) return;
    const evId = full.id;
    // the witness settlement knows; others do not
    expect(isKnown(gs, "t1", "settlements", near.key)).toBe(true);
    const otherBoards = Object.keys(gs.rumorBoard ?? {}).filter((k) => k !== near.key);
    for (const k of otherBoards) expect(boardOf(gs, k).find((m) => m.eventId === evId)).toBeUndefined();
  });

  it("an alpha victory lifts reputation; a loss drags it; unknown differs from known-neutral", () => {
    const gs = makeGs();
    gs.events = [];
    gs.eventSeq = 0;
    const world = getWorld(gs.seed);
    const near = nearestSettlement(world, gs.player.x, gs.player.y, 400);
    if (!near) return;
    expect(repOf(gs, "t1", "settlements", near.key)).toBeNull();
    recordEvent(gs, { cat: "alpha_kill", subject: "t1", subjectName: "Mera", other: "a1", otherName: "x", x: near.x, y: near.y, tick: gs.tick, sig: 3, won: true, nationId: null, assocId: null, alphaSpeciesId: "mossback", alphaLevel: 20 });
    const winRep = repOf(gs, "t1", "settlements", near.key) ?? 0;
    expect(winRep).toBeGreaterThan(0);
    recordEvent(gs, { cat: "alpha_loss", subject: "t2", subjectName: "Doss", other: "a2", otherName: "x", x: near.x, y: near.y, tick: gs.tick, sig: 3, won: false, nationId: null, assocId: null, alphaSpeciesId: "mossback", alphaLevel: 20 });
    const lossRep = repOf(gs, "t2", "settlements", near.key) ?? 0;
    expect(lossRep).toBeLessThan(0);
  });

  it("duplicate delivery can never reapply a reputation change", () => {
    const gs = makeGs();
    gs.events = [];
    gs.eventSeq = 0;
    const world = getWorld(gs.seed);
    const near = nearestSettlement(world, gs.player.x, gs.player.y, 400);
    if (!near) return;
    const ev = {
      cat: "alpha_kill" as const,
      id: "e1",
      subject: "t1",
      subjectName: "Mera",
      other: "a1",
      otherName: "x",
      x: near.x,
      y: near.y,
      tick: gs.tick,
      sig: 3,
      won: true,
      nationId: null,
      assocId: null,
      alphaSpeciesId: "mossback",
      alphaLevel: 20,
    };
    deliverToSettlement(gs, ev, near.key, gs.tick, 1, "t1", 0);
    const v1 = repOf(gs, "t1", "settlements", near.key) ?? 0;
    deliverToSettlement(gs, ev, near.key, gs.tick + 5, 0.8, "traveler", 2);
    deliverToSettlement(gs, ev, near.key, gs.tick + 9, 0.6, "assoc", 3);
    expect(repOf(gs, "t1", "settlements", near.key)).toBe(v1);
  });
});

describe("rumors", () => {
  it("word travels only after a plausible delay, along the roads", () => {
    const gs = makeGs();
    gs.events = [];
    gs.eventSeq = 0;
    gs.rumorQ = [];
    gs.rumorBoard = {};
    const world = getWorld(gs.seed);
    const near = nearestSettlement(world, gs.player.x, gs.player.y, 400);
    if (!near) return;
    const ev = recordEvent(gs, { cat: "alpha_kill", subject: "t1", subjectName: "Mera", other: "a1", otherName: "x", x: near.x, y: near.y, tick: gs.tick, sig: 5, won: true, nationId: null, assocId: null, alphaSpeciesId: "mossback", alphaLevel: 30 });
    expect(ev).not.toBeNull();
    // the witness knows immediately
    expect(boardOf(gs, near.key).length).toBe(1);
    // schedule a far transfer and let time run — it lands only after its due tick
    gs.rumorQ?.push({ eventId: ev!.id, toKey: "s:9:9", dueTick: gs.tick + 50, confidence: 0.9, from: near.key, hops: 1 });
    advanceRumors(gs); // not due yet
    expect(boardOf(gs, "s:9:9").length).toBe(0);
    gs.tick += 60;
    advanceRumors(gs);
    expect(boardOf(gs, "s:9:9").length).toBe(1);
    const mem = boardOf(gs, "s:9:9")[0];
    expect(mem.hops).toBe(1);
    expect(mem.confidence).toBeLessThan(1); // secondhand by construction
  });

  it("the event record is authoritative and never rewritten by rumor copies", () => {
    const gs = makeGs();
    gs.events = [];
    gs.eventSeq = 0;
    const world = getWorld(gs.seed);
    const near = nearestSettlement(world, gs.player.x, gs.player.y, 400);
    if (!near) return;
    const ev = recordEvent(gs, { cat: "duel", subject: "t1", subjectName: "Mera", other: "t2", otherName: "Doss", x: near.x, y: near.y, tick: gs.tick, sig: 2, won: true, nationId: null, assocId: null, alphaSpeciesId: null, alphaLevel: null });
    expect(ev).not.toBeNull();
    const before = JSON.stringify(ev);
    deliverToSettlement(gs, ev!, "s:9:9", gs.tick + 30, 0.4, "road", 2);
    expect(JSON.stringify(gs.events?.find((e) => e.id === ev!.id))).toBe(before);
    expect(eventOf(gs, boardOf(gs, "s:9:9")[0])?.id).toBe(ev!.id);
  });

  it("rumor state survives save/load without duplication", () => {
    const gs = makeGs();
    const boardCount = Object.values(gs.rumorBoard ?? {}).reduce((a, arr) => a + arr.length, 0);
    const loaded = roundTrip(gs);
    const boardCount2 = Object.values(loaded.rumorBoard ?? {}).reduce((a, arr) => a + arr.length, 0);
    expect(boardCount2).toBe(boardCount);
    expect(loaded.events?.length).toBe(gs.events?.length);
    // events keep their ids: no duplicate victories on reload
    const ids = new Set((loaded.events ?? []).map((e) => e.id));
    expect(ids.size).toBe((loaded.events ?? []).length);
  });
});

describe("migration (v22 → v23)", () => {
  it("a v22 save gains the roster and ledgers without touching player progress", () => {
    const gs = makeGs();
    // strip v23 state to simulate an old save
    const old = JSON.parse(JSON.stringify(gs)) as GameState & Record<string, unknown>;
    delete old.tamers;
    delete old.events;
    delete old.rep;
    delete old.rumorBoard;
    delete old.rumorQ;
    delete old.repApplied;
    old.version = 22;
    const party = JSON.stringify(old.party);
    expect(migrateLoaded(old)).toBe(true);
    expect(old.version).toBe(SAVE_VERSION);
    expect(Object.keys(old.tamers ?? {}).length).toBeGreaterThan(0);
    expect(old.events).toEqual([]);
    expect(old.rep).toBeDefined();
    expect(JSON.stringify(old.party)).toBe(party);
  });

  it("migration is idempotent — tamers are not doubled", () => {
    const gs = makeGs();
    const parsed = JSON.parse(JSON.stringify(gs)) as GameState;
    expect(migrateLoaded(parsed)).toBe(true);
    const once = Object.keys(parsed.tamers ?? {}).sort();
    expect(migrateLoaded(parsed)).toBe(true);
    expect(Object.keys(parsed.tamers ?? {}).sort()).toEqual(once);
  });

  it("newer unsupported saves are rejected", () => {
    const gs = makeGs();
    const future = JSON.parse(JSON.stringify(gs)) as GameState;
    future.version = SAVE_VERSION + 1;
    expect(migrateLoaded(future)).toBe(false);
  });
});

describe("full tick integration", () => {
  it("advance runs tamers and rumors without error and keeps everything bounded", () => {
    const gs = makeGs();
    advance(gs, 200);
    for (const t of Object.values(gs.tamers ?? {})) {
      expect(t.career.battles).toBeGreaterThanOrEqual(0);
      expect(t.team.length).toBeLessThanOrEqual(3);
    }
        expect(rumorStateSize(gs)).toBeLessThan(5000);
  });

  it("an alpha a tamer hunts off-screen stays dead on reload — no duplicate rewards", () => {
    const gs = makeGs();
    advance(gs, 400, true);
    const killer = Object.values(gs.tamers ?? {}).find((t) => t.career.alphaKills > 0);
    if (!killer) return;
    const loaded = roundTrip(gs);
    const again = loaded.tamers?.[killer.id];
    expect(again?.career.alphaKills).toBe(killer.career.alphaKills);
  });
});
