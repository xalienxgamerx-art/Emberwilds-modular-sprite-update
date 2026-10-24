import { DAY_TICKS, PARTY_MAX, PEN_MAX, SPECIES } from "./data";
import { coreExchange, fieldTamerTeam, openGrudge, wildMonster } from "./combat";
import { walkable } from "./height";
import { skillOf } from "./signature";
import { createMonster, displayName, grantXp, statOf as statOfMon } from "./monster";
import { getFactions } from "./factions";
import { addLog } from "./log";
import { ensureRosterLooks } from "./appearance";
import { hash2, hashString, Rng } from "./rng";
import { carrierExchange, nearestSettlement, recordEvent, setKey } from "./rumors";
import { settlementEntrances } from "./roads";
import { isSettlement } from "./settlement";
import { dangerLevel } from "./sim";
import type { GameState, Monster, Tamer, TamerGoalKind, WorldEvent } from "./types";
import { FEATURE_CELL, findPath, getWorld, type Feature, type World } from "./world";
import { WORLD_SIZE } from "./data";
import type { Fighter } from "./combat";

/**
 * Persistent rival tamers — real world participants.
 *
 * A bounded roster is drawn from the seed once (deterministic per world);
 * from then on they live in gs.tamers and are never regenerated. They keep
 * real monster teams under the same rules as the player, travel by actual
 * roads via findPath, hunt alphas they have credible word of, duel rivals,
 * recover after defeats, and carry rumors between settlements.
 *
 * Off-screen encounters resolve headlessly through coreExchange — the exact
 * hit/damage/status rules the live map engine uses — so there is one
 * authoritative ruleset at two levels of detail.
 */

/** Bounded roster: a living world has room for a dozen named careers. */
const TAMER_COUNT = 12;
/** Expensive decisions are staggered on this cadence (ticks). */
const THINK_INTERVAL = 40;
/** Road pace: one tile every two ticks (a laden walker, quicker than a wanderer). */
const TICKS_PER_STEP = 2;
/** Live encounters only happen within this range of the player — beyond it, headless rules. */
const LIVE_RADIUS = 24;
/** How much reserve room a working tamer keeps (bounded, like the player's pen). */
const TAMER_RESERVE_MAX = Math.min(PEN_MAX, 4);

const TAMER_NAMES = ["Mera", "Doss", "Kell", "Iva", "Brant", "Sefa", "Orlo", "Piet", "Nash", "Yara", "Colm", "Reva", "Tam", "Ulla", "Verel", "Wren"];
const SCARFS = ["#a33327", "#2f5f8a", "#c9a227", "#3d6b35", "#7b3f9d", "#a05a2c", "#8e2f4f", "#2e7d76"];

/* ------------------------------ Initialization ------------------------------ */

/** A deterministic starter team for one tamer: home-region species at fair levels. */
function rollTeam(gs: GameState, t: { x: number; y: number }, rng: Rng): Monster[] {
  const world = getWorld(gs.seed);
  const biome = world.tile(t.x, t.y).biome;
  const h = dangerLevel(world, t.x, t.y, biome, rng.int(1, 9999));
  const count = 1 + rng.int(0, PARTY_MAX - 1);
  const team: Monster[] = [];
  for (let i = 0; i < count; i++) {
    const sp = world.pickSpecies(biome, rng.int(1, 999_999)) ?? Object.keys(SPECIES)[0];
    team.push(createMonster(gs, sp, Math.max(3, h - rng.int(0, 2)), { seed: rng.int(1, 2_000_000_000), origin: "The wilds", mutations: [] }));
  }
  return team;
}

/**
 * Draws the world's starting roster from the seed: one tamer per chosen
 * settlement, spread across the map. Deterministic per seed; called from
 * newGame and from migration — never regenerates existing tamers.
 */
export function initTamers(gs: GameState): void {
  if (gs.tamers && Object.keys(gs.tamers).length) return;
  const world = getWorld(gs.seed);
  const tamers: Record<string, Tamer> = {};
  gs.tamers = tamers;
  gs.tamerSeq = 0;
  const usedNames = new Set<string>();
  // spread homes across the map: hash-order over the settlement census with a
  // minimum spacing, so the roster covers the world rather than one corner
  const spots = censusSettlements(world).sort((a, b) => hash2(gs.seed ^ 0x1a4f, a.x, a.y) - hash2(gs.seed ^ 0x1a4f, b.x, b.y));
  const chosen: Feature[] = [];
  for (const s of spots) {
    if (chosen.length >= TAMER_COUNT) break;
    if (chosen.some((c) => Math.max(Math.abs(c.x - s.x), Math.abs(c.y - s.y)) < 420)) continue;
    chosen.push(s);
  }
  for (const s of chosen) {
    const n = (gs.tamerSeq ?? 0) + 1;
    gs.tamerSeq = n;
    const rng = new Rng(hash2(gs.seed ^ 0x71de, s.x, s.y));
    let name = "";
    for (let k = 0; k < 20 && !name; k++) {
      const candidate = TAMER_NAMES[(rng.int(0, TAMER_NAMES.length - 1) + k) % TAMER_NAMES.length];
      if (!usedNames.has(candidate)) name = candidate;
    }
    if (!name) name = `Tamer ${n}`;
    usedNames.add(name);
    const ent = settlementEntrances(world, s).find((e) => walkable(world, 0, e.x, e.y)) ?? { x: s.x, y: s.y };
    const homeKey = setKey(s.x, s.y);
    const homeName = homeNameOf(world, s);
    const t: Tamer = {
      id: `t${n}`,
      name,
      homeKey,
      homeName,
      x: ent.x,
      y: ent.y,
      layer: 0,
      team: [],
      reserve: [],
      gold: 30 + rng.int(0, 60),
      scarf: SCARFS[n % SCARFS.length],
      goal: "develop",
      route: null,
      hunt: null,
      duel: null,
      recoverUntil: 0,
      nextThink: THINK_INTERVAL + (hash2(gs.seed, n, 77) % THINK_INTERVAL),
      career: { battles: 0, wins: 0, losses: 0, alphaKills: 0, tames: 0 },
      knowledge: { settlements: { [homeKey]: { name: homeName, x: s.x, y: s.y, tick: gs.tick } }, alphas: {}, rivals: {}, heard: {} },
      field: {},
    };
    t.team = rollTeam(gs, t, rng);
    tamers[t.id] = t;
  }
  // appearances come from their own seed stream after the roster is drawn, so
  // the gameplay rng (names, gold, teams) is untouched by cosmetic choices
  ensureRosterLooks(gs.seed, tamers);
}

function homeNameOf(world: World, s: { x: number; y: number }): string {
  return world.tile(s.x, s.y).feature?.name ?? "home";
}

/* --------------------------------- Travel --------------------------------- */

/** True when the tamer's next route tile can actually be walked (routes re-plan when wrong). */
function stepOk(gs: GameState, t: Tamer, x: number, y: number): boolean {
  const world = getWorld(gs.seed);
  if (!world.inBounds(x, y)) return false;
  if (world.siteAt(x, y)?.wall) return false;
  const biome = world.tile(x, y).biome;
  return biome !== "peak" && biome !== "deep" && biome !== "sea" && biome !== "lake";
}

/** Walks one route step. Returns true when the tamer moved. */
function walkRoute(gs: GameState, t: Tamer): boolean {
  const route = t.route;
  if (!route || !route.path.length) return false;
  // a stale route (an old plan) is re-thought, not followed forever
  if (gs.tick - route.plannedTick > DAY_TICKS) {
    t.route = null;
    return false;
  }
  const [nx, ny] = route.path[0];
  if (!stepOk(gs, t, nx, ny)) {
    t.route = null; // blocked: think() will re-plan or re-choose
    return false;
  }
  route.path.shift();
  t.x = nx;
  t.y = ny;
  return true;
}

/** Commits a goal: routes to the destination through real country, snapping to walkable ground when the exact tile is blocked. */
function routeTo(gs: GameState, t: Tamer, goal: TamerGoalKind, dx: number, dy: number, destName: string): void {
  const world = getWorld(gs.seed);
  let path = findPath(world, t.x, t.y, dx, dy, 8000, t.layer);
  if (!path) {
    // the destination tile may carry a rock or lean wall: snap to the nearest
    // walkable ground (deterministic scan) and route there instead
    seek: for (let r = 1; r <= 6; r++) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
          const nx = dx + ox;
          const ny = dy + oy;
          if (!walkable(world, t.layer, nx, ny)) continue;
          path = findPath(world, t.x, t.y, nx, ny, 8000, t.layer);
          if (path) {
            dx = nx;
            dy = ny;
            break seek;
          }
        }
      }
    }
  }
  t.goal = goal;
  t.route = path ? { dx, dy, destName, goal, path: path.slice(1), plannedTick: gs.tick } : { dx, dy, destName, goal, path: [], plannedTick: gs.tick };
}

/* ------------------------------ Goal selection ----------------------------- */

const teamAvg = (t: Tamer, f: (m: Monster) => number): number => (t.team.length ? t.team.reduce((a, m) => a + f(m), 0) / t.team.length : 0);
const teamHpFrac = (t: Tamer): number => teamAvg(t, (m) => m.hp / Math.max(1, statOfMon(m, "hp", gs0(t))));
const teamLevel = (t: Tamer): number => teamAvg(t, (m) => m.level);

/** Team stats read at the tamer's own clock, not the player's. */
let gs0Tick = 0;
function gs0(t: Tamer): number {
  void t;
  return gs0Tick;
}

/** Picks the next goal from what the tamer actually knows and how the team feels. */
export function think(gs: GameState, t: Tamer): void {
  gs0Tick = gs.tick;
  const world = getWorld(gs.seed);
  // recovery first: a beaten tamer lies low and binds wounds
  if (t.recoverUntil > gs.tick) {
    t.goal = "resupply";
    for (const m of [...t.team, ...t.reserve]) m.hp = Math.min(statOfMon(m, "hp", gs.tick), m.hp + Math.ceil(statOfMon(m, "hp", gs.tick) * 0.1));
    return;
  }
  // hurt or hungry team: the nearest settlement they know
  if (teamHpFrac(t) < 0.55 || teamAvg(t, (m) => m.satiety) < 25) {
    const dest = nearestKnownSettlement(t);
    if (dest) {
      routeTo(gs, t, "resupply", dest.ex, dest.ey, dest.name);
      return;
    }
  }
  // a credible alpha lead the team can plausibly take
  if (t.hunt) {
    const lead = t.knowledge.alphas[t.hunt];
    if (lead) {
      routeTo(gs, t, "alpha", lead.x, lead.y, `the ${SPECIES[lead.speciesId]?.name ?? "great beast"} grounds`);
      return;
    }
    t.hunt = null; // stale lead
  }
  for (const id in t.knowledge.alphas) {
    const lead = t.knowledge.alphas[id];
    if (gs.tick - lead.tick > DAY_TICKS * 8) {
      delete t.knowledge.alphas[id]; // old word of a moving beast is no word at all
      continue;
    }
    if (teamLevel(t) + 3 < lead.level) continue; // honest risk: too big for this team
    t.hunt = id;
    routeTo(gs, t, "alpha", lead.x, lead.y, `the ${SPECIES[lead.speciesId]?.name ?? "great beast"} grounds`);
    return;
  }
  // a rival worth challenging — last seen not too far, team in fighting shape
  if (t.duel) return; // already pursuing one
  for (const rid in t.knowledge.rivals) {
    const r = t.knowledge.rivals[rid];
    if (gs.tick - r.tick > DAY_TICKS * 6) continue;
    const d = Math.max(Math.abs(r.x - t.x), Math.abs(r.y - t.y));
    if (d > 90) continue;
    if (teamHpFrac(t) < 0.7) break;
    if (new Rng(hash2(gs.seed ^ 0x3d, hashString(t.id) + Math.floor(gs.tick / THINK_INTERVAL), r.tick)).next() < 0.35) continue;
    t.duel = rid;
    routeTo(gs, t, "duel", r.x, r.y, `${r.name}'s road`);
    return;
  }
  // otherwise: work the region — seek a recruit, develop the team
  const spots = netSettlementsNear(world, t.x, t.y, 160);
  const pick = spots.length ? spots[hash2(gs.seed ^ 0x5e, t.x, t.y + gs.tick) % spots.length] : null;
  const recruitRoll = new Rng(hash2(gs.seed ^ 0x5f, t.x + gs.tick, t.y)).next();
  if (pick && recruitRoll < 0.4) routeTo(gs, t, "recruit", pick.ex, pick.ey, pick.name);
  else {
    const rng = new Rng(gs.tick ^ hashString(t.id));
    routeTo(gs, t, "develop", Math.max(8, Math.min(4087, t.x + rng.int(-60, 60))), Math.max(8, Math.min(4087, t.y + rng.int(-60, 60))), "good training grounds");
  }
}

function nearestKnownSettlement(t: Tamer): { name: string; ex: number; ey: number } | null {
  let best: { name: string; ex: number; ey: number; d: number } | null = null;
  for (const k in t.knowledge.settlements) {
    const s = t.knowledge.settlements[k];
    const d = Math.max(Math.abs(s.x - t.x), Math.abs(s.y - t.y));
    if (!best || d < best.d) best = { name: s.name, ex: s.x, ey: s.y, d };
  }
  return best ? { name: best.name, ex: best.ex, ey: best.ey } : null;
}

/**
 * Settlements on a stride-3 sweep of the feature grid — deliberately sparse
 * (the full census costs over a second of settlement generation), fully
 * deterministic, and still world-wide: plenty of homes for a dozen tamers.
 */
function censusSettlements(world: World): Feature[] {
  const cells = Math.ceil(WORLD_SIZE / FEATURE_CELL);
  const out: Feature[] = [];
  for (let cy = 0; cy < cells; cy += 3) {
    for (let cx = 0; cx < cells; cx += 3) {
      const f = world.featureCell(cx, cy);
      if (f && isSettlement(f)) out.push(f);
    }
  }
  return out;
}

/** Settlements near a spot with their entrance tiles (blocked entrances skipped). */
function netSettlementsNear(world: World, x: number, y: number, r: number): { name: string; ex: number; ey: number }[] {
  const out: { name: string; ex: number; ey: number }[] = [];
  for (const f of world.featuresNear(x, y, r)) {
    if (!isSettlement(f)) continue;
    const ent = settlementEntrances(world, f).find((e) => walkable(world, 0, e.x, e.y)) ?? { x: f.x, y: f.y };
    out.push({ name: f.name, ex: ent.x, ey: ent.y });
  }
  return out;
}

/* -------------------------------- Encounters ------------------------------- */

/** A synthetic stand-in for an off-screen alpha, built only from what the event knows. */
function alphaMonster(gs: GameState, speciesId: string, level: number, creatureId: string): Monster {
  const c = {
    id: creatureId,
    speciesId,
    level,
    x: 0,
    y: 0,
    homeX: 0,
    homeY: 0,
    hpFrac: 1,
    satiety: 80,
    disposition: "aggressive" as const,
    activity: "Hunting",
    personality: "fierce" as const,
    geneSeed: hash2(gs.seed ^ 0xa1fa, hashString(creatureId), level),
    alpha: true,
  };
  return wildMonster(gs, c as never);
}

/** A combat side for headless resolution. */
interface Side {
  id: string;
  name: string;
  team: Monster[];
}

/** Synthetic fighters park on distinct tiles so rng keys and terrain read deterministically. */
function synth(m: Monster, owner: string, i: number): Fighter {
  return { key: m.uid, side: "tamer", owner, mon: m, x: 2 + i, y: 2, fp: 1, creatureId: null };
}

/**
 * Headless team battle using the shared combat rules — one authoritative
 * exchange function, greedy picks, no map. Downed monsters stay downed (they
 * recover, they do not die). Returns the winning side id.
 */
function skirmish(gs: GameState, a: Side, b: Side, rounds = 30): "a" | "b" {
  const live = (s: Side): Monster[] => s.team.filter((m) => m.hp > 0);
  for (let round = 0; round < rounds; round++) {
    for (const [atk, def] of [[a, b], [b, a]] as [Side, Side][]) {
      const attackers = live(atk);
      const defenders = live(def);
      if (!attackers.length || !defenders.length) continue;
      const m = attackers.reduce((x, y) => (statOfMon(x, "atk", gs.tick) >= statOfMon(y, "atk", gs.tick) ? x : y));
      const d = defenders.reduce((x, y) => (x.hp <= y.hp ? x : y));
      // greedy skill pick by the same damage estimate the planner uses
      let bestSid = m.skills[0];
      let bestDmg = -1;
      for (const sid of m.skills) {
        const ex = coreExchange(gs, synth(m, atk.id, 0), synth(d, def.id, 0), sid, false);
        if (ex.hit && ex.dmg > bestDmg) {
          bestDmg = ex.dmg;
          bestSid = sid;
        }
      }
      if (!bestSid) continue;
      const ex = coreExchange(gs, synth(m, atk.id, 0), synth(d, def.id, 0), bestSid, false);
      if (ex.hit) {
        d.hp = Math.max(0, d.hp - ex.dmg);
        // statuses apply through the same fighter store the live engine reads
        if (ex.statusHit && d.hp > 0) {
          const st = skillOf(m, bestSid)?.status;
          if (st) {
            const fs = (gs.fighters[d.uid] ??= { statuses: [], cooldowns: {} });
            fs.statuses.push({ id: st[0], turns: st[2] });
          }
        }
      }
    }
    if (!live(a).length || !live(b).length) break;
  }
  const aLeft = live(a).reduce((s, m) => s + m.hp, 0);
  const bLeft = live(b).reduce((s, m) => s + m.hp, 0);
  return bLeft > aLeft ? "b" : "a";
}

/** Nurses downed monsters back to a quarter of their strength — carried home, not lost. */
function nurseBack(gs: GameState, team: Monster[]): void {
  for (const m of team) {
    if (m.hp > 0) continue;
    m.hp = Math.max(1, Math.round(statOfMon(m, "hp", gs.tick) * 0.25));
  }
}

/** Career + rumor bookkeeping for a resolved duel. Exactly one event per duel. */
function resolveDuelOutcome(gs: GameState, winner: Side, loser: Side, x: number, y: number, loserTamer?: Tamer, winnerTamer?: Tamer): void {
  const avgLvl = Math.round((teamLevelOf(winner) + teamLevelOf(loser)) / 2);
  recordEvent(gs, {
    cat: "duel",
    subject: winner.id,
    subjectName: winner.name,
    other: loser.id,
    otherName: loser.name,
    x,
    y,
    tick: gs.tick,
    sig: Math.max(1, Math.min(4, 1 + Math.floor(avgLvl / 10))),
    won: true,
    nationId: nationIdOf(gs, x, y),
    assocId: null,
    alphaSpeciesId: null,
    alphaLevel: null,
  });
  if (loserTamer) {
    loserTamer.career.battles += 1;
    loserTamer.career.losses += 1;
    loserTamer.recoverUntil = gs.tick + DAY_TICKS * 2;
    loserTamer.duel = null;
    loserTamer.route = null;
  }
  if (winnerTamer) {
    winnerTamer.career.battles += 1;
    winnerTamer.career.wins += 1;
    winnerTamer.duel = null;
    winnerTamer.route = null;
  }
  for (const m of winner.team) {
    if (m.hp <= 0) continue;
    for (const l of grantXp(m, 8 + avgLvl)) void l;
    m.wins += 1;
  }
}

function teamLevelOf(s: Side): number {
  return s.team.length ? s.team.reduce((a, m) => a + m.level, 0) / s.team.length : 1;
}

function nationIdOf(gs: GameState, x: number, y: number): string | null {
  return getFactions(gs.seed).nationAt(x, y)?.id ?? null;
}

/** One alpha hunt, resolved. Live when the player can see it; headless otherwise. */
function resolveHunt(gs: GameState, t: Tamer, alphaId: string, live: boolean): void {
  const lead = t.knowledge.alphas[alphaId];
  const body = gs.creatures[alphaId] ?? null;
  const speciesId = body?.speciesId ?? lead?.speciesId;
  const level = body?.level ?? lead?.level ?? 0;
  if (!speciesId || !level) {
    t.hunt = null;
    return;
  }
  const x = body?.x ?? lead?.x ?? t.x;
  const y = body?.y ?? lead?.y ?? t.y;
  if (live && body) {
    // live encounter: the engine's own multi-party combat takes over — field
    // the team and provoke the alpha; tamerCombatTurn drives the fight
    fieldTamerTeam(gs, t);
    body.stalking = true;
    return;
  }
  // headless: same rules, no map
  const side: Side = { id: t.id, name: t.name, team: t.team };
  const alpha: Side = { id: alphaId, name: `the great ${SPECIES[speciesId].name.toLowerCase()}`, team: [alphaMonster(gs, speciesId, level, alphaId)] };
  const won = skirmish(gs, side, alpha) === "a";
  nurseBack(gs, t.team);
  t.career.battles += 1;
  if (won) {
    t.career.wins += 1;
    t.career.alphaKills += 1;
    // the body — when its chunk loads — must not respawn: the removed ledger
    // is the world's own respawn guard, so this kill is authoritative
    gs.removed[alphaId] = gs.tick;
    if (body) {
      delete gs.creatures[alphaId];
      delete gs.fighters[alphaId];
    }
    // a slain alpha's bloodline is worth a claim: the victor sometimes keeps it
    if (t.team.length + t.reserve.length < PARTY_MAX + TAMER_RESERVE_MAX && new Rng(hash2(gs.seed ^ 0xbe, hashString(alphaId), gs.tick)).next() < 0.5) {
      t.reserve.push(alphaMonster(gs, speciesId, Math.max(1, level - 2), `tamed_${alphaId}`));
      t.career.tames += 1;
    }
  } else {
    t.career.losses += 1;
    t.recoverUntil = gs.tick + DAY_TICKS * 2;
  }
  t.hunt = null;
  recordEvent(gs, {
    cat: won ? "alpha_kill" : "alpha_loss",
    subject: t.id,
    subjectName: t.name,
    other: alphaId,
    otherName: `the great ${SPECIES[speciesId].name.toLowerCase()}`,
    x,
    y,
    tick: gs.tick,
    sig: Math.max(1, Math.min(5, 1 + Math.floor(level / 8))),
    won,
    nationId: nationIdOf(gs, x, y),
    assocId: null,
    alphaSpeciesId: speciesId,
    alphaLevel: level,
  });
}

/** Opens a real on-map duel between two fielded teams (the player can watch). */
function openLiveDuel(gs: GameState, t: Tamer, rival: Tamer): void {
  openGrudge(gs, t.id, rival.id);
  fieldTamerTeam(gs, t);
  fieldTamerTeam(gs, rival);
  addLog(gs, `${t.name} and ${rival.name} meet on the field!`, "combat");
}

/* --------------------------------- The tick -------------------------------- */

/**
 * Advances every tamer one tick: recovery, travel, staggered decisions, and
 * encounter checks. Bounded work — O(tamers) cheap checks per tick; route
 * planning only on goal change.
 */
export function advanceTamers(gs: GameState): void {
  const tamers = gs.tamers;
  if (!tamers) return;
  const world = getWorld(gs.seed);
  for (const t of Object.values(tamers)) {
    if (t.recoverUntil > gs.tick) {
      // downed monsters mend slowly; the tamer travels nowhere
      if (gs.tick % 8 === 0) for (const m of [...t.team, ...t.reserve]) m.hp = Math.min(statOfMon(m, "hp", gs.tick), m.hp + 1);
      continue;
    }
    if (t.route?.path.length) {
      // mid-journey: walk, and re-think on the usual cadence (a think may re-route)
      if (gs.tick >= t.nextThink) {
        t.nextThink = gs.tick + THINK_INTERVAL;
        think(gs, t);
        continue;
      }
      if (gs.tick % TICKS_PER_STEP === 0) walkRoute(gs, t);
      continue;
    }
    // arrived (or idle): act on the goal, then think again next tick
    const goal = t.goal;
    const here = nearestSettlement(world, t.x, t.y, 8);
    if (here) {
      carrierExchange(gs, t.id, here.key, 0.85);
      t.knowledge.settlements[here.key] = { name: here.name, x: here.x, y: here.y, tick: gs.tick };
      if (goal === "resupply") resupply(gs, t);
    }
    if (goal === "alpha" && t.hunt) {
      const lead = t.knowledge.alphas[t.hunt];
      const d = lead ? Math.max(Math.abs(lead.x - t.x), Math.abs(lead.y - t.y)) : 99;
      if (d <= 14 || gs.creatures[t.hunt]) resolveHunt(gs, t, t.hunt, !!gs.creatures[t.hunt]);
      else t.hunt = null; // the beast moved on — the word was stale
    }
    if (goal === "duel" && t.duel) {
      const rival = gs.tamers?.[t.duel];
      if (rival && !rival.recoverUntil) {
        const d = Math.max(Math.abs(rival.x - t.x), Math.abs(rival.y - t.y));
        if (d <= 4) {
          const nearPlayer = Math.max(Math.abs(gs.player.x - t.x), Math.abs(gs.player.y - t.y)) <= LIVE_RADIUS;
          if (nearPlayer) {
            // a real on-map duel — the engine's multi-party turn driver takes over
            openLiveDuel(gs, t, rival);
            t.duel = null;
            rival.duel = null;
          } else {
            const winner = skirmish(gs, { id: t.id, name: t.name, team: t.team }, { id: rival.id, name: rival.name, team: rival.team });
            nurseBack(gs, t.team);
            nurseBack(gs, rival.team);
            if (winner === "a") resolveDuelOutcome(gs, { id: t.id, name: t.name, team: t.team }, { id: rival.id, name: rival.name, team: rival.team }, t.x, t.y, rival, t);
            else resolveDuelOutcome(gs, { id: rival.id, name: rival.name, team: rival.team }, { id: t.id, name: t.name, team: t.team }, t.x, t.y, t, rival);
          }
        } else if (gs.tick >= t.nextThink) {
          // the rival moved on: follow their last known position once more
          t.knowledge.rivals[rival.id] = { name: rival.name, x: rival.x, y: rival.y, tick: gs.tick, last: t.knowledge.rivals[rival.id]?.last ?? null };
        }
      } else t.duel = null;
    }
    if (goal === "recruit" && here) recruitTry(gs, t);
    t.nextThink = gs.tick + 1;
  }
}

/** Buys recovery and feed at a settlement — the same services the player pays for. */
function resupply(gs: GameState, t: Tamer): void {
  const cost = t.team.length * 6;
  if (t.gold >= cost) {
    t.gold -= cost;
    for (const m of t.team) {
      m.hp = statOfMon(m, "hp", gs.tick);
      m.satiety = Math.min(100, m.satiety + 60);
    }
  }
  // promote a stronger reserve monster when the team runs thin
  if (t.reserve.length && t.team.length < PARTY_MAX) {
    const i = t.reserve.findIndex((m) => m.level > teamLevel(t));
    if (i >= 0) t.team.push(...t.reserve.splice(i, 1));
  }
  t.route = null;
}

/** A tamer at the wilds tries to add a monster to the team (bounded, deterministic). */
function recruitTry(gs: GameState, t: Tamer): void {
  const rng = new Rng(hash2(gs.seed ^ 0x6ca, t.x + gs.tick, hashString(t.id)));
  if (rng.next() > 0.3) return;
  const world = getWorld(gs.seed);
  const biome = world.tile(t.x, t.y).biome;
  const sp = world.pickSpecies(biome, rng.int(1, 999_999));
  if (!sp) return;
  const lvl = Math.max(3, Math.round(teamLevel(t)) - 2 + rng.int(0, 3));
  const mon = createMonster(gs, sp, lvl, { seed: rng.int(1, 2_000_000_000), origin: `Tamed near ${t.homeName}`, mutations: [] });
  t.career.tames += 1;
  if (t.team.length < PARTY_MAX) t.team.push(mon);
  else if (t.reserve.length < TAMER_RESERVE_MAX) t.reserve.push(mon);
}

/* ------------------------------ Player meeting ----------------------------- */

/**
 * Logs the first meeting between the player and each tamer they come close
 * to. Called once per tick from the sim, after travel has run.
 */
export function tamerProximity(gs: GameState): void {
  const tamers = gs.tamers;
  if (!tamers) return;
  for (const t of Object.values(tamers)) {
    const d = Math.max(Math.abs(t.x - gs.player.x), Math.abs(t.y - gs.player.y));
    if (d <= 12 && !gs.metTamers?.[t.id]) {
      gs.metTamers = gs.metTamers ?? {};
      gs.metTamers[t.id] = { name: t.name, tick: gs.tick };
      addLog(gs, `${t.name}, a tamer out of ${t.homeName}, regards your team with a professional eye.`, "info");
    }
  }
}

/** Exposed for tests and UI: a tamer's full record. */
export function tamerProfile(gs: GameState, id: string): Tamer | null {
  return gs.tamers?.[id] ?? null;
}

/** Event rows for UI: the notable career events a subject owns. */
export function eventsOf(gs: GameState, subject: string): WorldEvent[] {
  return (gs.events ?? []).filter((e) => e.subject === subject || e.other === subject);
}

/** True when this fighter belongs to a rival tamer rather than the player. */
export const isRivalFighter = (f: Fighter): boolean => f.side === "tamer";
