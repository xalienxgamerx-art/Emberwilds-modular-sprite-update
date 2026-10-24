import { DAY_TICKS } from "./data";
import { getFactions } from "./factions";
import { hash2, hashString } from "./rng";
import { isSettlement, settlementId } from "./settlement";
import type { GameState, RumorMemory, RumorTransfer, WorldEvent } from "./types";
import { getWorld, type World } from "./world";
import { applyEventToCommunity, duelLoserDelta } from "./reputation";

/**
 * The rumor network — how notable deeds become common knowledge over time.
 *
 * An authoritative WorldEvent records what actually happened, once, and is
 * never rewritten. Rumor copies (RumorMemory) live in two bounded places:
 * a settlement's board (what that community talks about) and a tamer's
 * knowledge (what they personally carry). Copies reference the event id —
 * they never duplicate its payload.
 *
 * Propagation rides the existing world: tamers carry reports when they
 * arrive at a settlement, association channels carry word to a chapter, and
 * a slow scheduled queue moves news along road connections at travel time.
 * Nothing is ever learned "because it exists in GameState" — a community
 * knows only what a credible source brought to it, after a plausible delay.
 */

/** Bounded history: the world remembers its last N notable events. */
const EVENT_CAP = 240;
/** A settlement's talk is bounded: the N strongest stories survive pruning. */
const BOARD_CAP = 12;
/** Bounded transfer queue: news past this is too stale to still be traveling. */
const QUEUE_CAP = 320;
/** Rumor hops die out: secondhand of secondhand of secondhand fades mid-sentence. */
const MAX_HOPS = 4;
/** Below this confidence the story is not worth repeating. */
const MIN_CONFIDENCE = 0.2;
/** Process the transfer queue on this cadence (ticks) — never per tick per rumor. */
const PROPAGATION_INTERVAL = 8;
/** Ticks per road tile at a walker's pace (matches roadTravelers: 1 step / 3 ticks). */
const TICKS_PER_TILE = 3;
/** A deed done this close to a settlement is witnessed by it directly. */
export const WITNESS_RADIUS = 40;
/** How far (chebyshev) word can walk in one hop. */
const NEIGHBOR_REACH = 220;
/** Great deeds are murmured broadly on their first day, not just along one road. */
const FIRST_DAY_REACH = 120;

/** Stable settlement identity, matching the world's own settlementId convention. */
export const setKey = (x: number, y: number): string => settlementId({ x, y });

function board(gs: GameState): Record<string, RumorMemory[]> {
  return (gs.rumorBoard ??= {});
}

function applied(gs: GameState): Record<string, 1> {
  return (gs.repApplied ??= {});
}

/** Deterministic propagation randomness — pure in seed, event and destination. */
function propRng(gs: GameState, eventId: string, toKey: string): number {
  return hash2(gs.seed ^ 0x7b6d, hashString(eventId), hashString(toKey));
}

/** Road distance between two settlement keys (chebyshev over the network nodes). */
function keyDistance(a: string, b: string): number {
  const pa = a.split(":");
  const pb = b.split(":");
  return Math.max(Math.abs(Number(pa[1]) - Number(pb[1])), Math.abs(Number(pa[2]) - Number(pb[2])));
}

/** Travel time in ticks for word (or a walker) to cover a road of this length. */
function transferTicks(gs: GameState, sig: number, dist: number, eventId: string, toKey: string): number {
  // great deeds travel on running feet; small ones stroll
  const per = sig >= 4 ? TICKS_PER_TILE : TICKS_PER_TILE * 2;
  const drift = 0.8 + 0.4 * propRng(gs, eventId, toKey);
  return Math.max(PROPAGATION_INTERVAL * 4, Math.round(dist * per * drift));
}

function scheduleTransfer(gs: GameState, t: RumorTransfer): void {
  const q = (gs.rumorQ ??= []);
  if (q.length >= QUEUE_CAP) return;
  q.push(t);
}

/** The settlement whose green is nearest this spot (null = deep wilds). Local feature scan — cheap and deterministic. */
export function nearestSettlement(world: World, x: number, y: number, radius = WITNESS_RADIUS): { key: string; name: string; x: number; y: number } | null {
  let best: { key: string; name: string; x: number; y: number; d: number } | null = null;
  for (const f of world.featuresNear(x, y, radius)) {
    if (!isSettlement(f)) continue;
    const d = Math.max(Math.abs(f.x - x), Math.abs(f.y - y));
    if (!best || d < best.d) best = { key: setKey(f.x, f.y), name: f.name, x: f.x, y: f.y, d };
  }
  return best;
}

/** The association whose chapter (or headquarters) stands in this settlement, if any. */
export function assocAtKey(gs: GameState, key: string): string | null {
  const [, sx, sy] = key.split(":").map(Number);
  const f = getWorld(gs.seed).tile(sx, sy).feature;
  if (!f) return null;
  const fac = getFactions(gs.seed);
  return fac.associationAt(f)?.id ?? fac.headquartersAt(f)?.id ?? null;
}

/** The nation whose territory covers this settlement key, if any. */
export function nationAtKey(gs: GameState, key: string): string | null {
  const [, sx, sy] = key.split(":").map(Number);
  return getFactions(gs.seed).nationAt(sx, sy)?.id ?? null;
}

/** The chapter settlement key of an association id (null = unknown association). */
export function chapterKeyOf(gs: GameState, assocId: string): string | null {
  const a = getFactions(gs.seed).assocs.find((x) => x.id === assocId);
  return a ? setKey(a.chapter.x, a.chapter.y) : null;
}

/** Schedules onward hops out of a settlement that just learned the event — to the nearest settlements along plausible travel times. */
function scheduleFrom(gs: GameState, world: World, e: WorldEvent, fromKey: string, confidence: number): void {
  const [, hx, hy] = fromKey.split(":").map(Number);
  // the nearest green folk could walk the story to, at a walker's pace
  const near = world
    .featuresNear(hx, hy, NEIGHBOR_REACH)
    .filter((f) => isSettlement(f) && setKey(f.x, f.y) !== fromKey)
    .map((f) => ({ f, d: Math.max(Math.abs(f.x - hx), Math.abs(f.y - hy)) }))
    .sort((a, b) => a.d - b.d || a.f.x - b.f.x || a.f.y - b.f.y)
    .slice(0, 4);
  for (const { f, d } of near) {
    const toKey = setKey(f.x, f.y);
    scheduleTransfer(gs, {
      eventId: e.id,
      toKey,
      dueTick: gs.tick + transferTicks(gs, e.sig, d, e.id, toKey),
      confidence: confidence * 0.8,
      from: fromKey,
      hops: 1,
    });
  }
  // great deeds outrun the mail: fresh major news is murmured broadly at once
  if (e.sig >= 4) {
    for (const { f, d } of near) {
      const toKey = setKey(f.x, f.y);
      scheduleTransfer(gs, {
        eventId: e.id,
        toKey,
        dueTick: gs.tick + transferTicks(gs, e.sig, d, e.id, toKey),
        confidence: confidence * 0.6,
        from: fromKey,
        hops: 2,
      });
    }
  }
}

/** Opinion of one subject moves in exactly one community — guarded, so a rumor returning changes nothing twice. */
function applyOpinion(gs: GameState, e: WorldEvent, key: string): void {
  const com = { key, nationId: nationAtKey(gs, key), assocId: assocAtKey(gs, key) };
  applyEventToCommunity(gs, e, e.subject, com);
  if (e.cat === "duel") {
    // a duel has two subjects: the loser's name is tied to the loss in the
    // same breath — a distinct guard via the mirrored event id
    applyEventToCommunity(gs, { ...e, id: `${e.id}l`, won: !e.won, subject: e.other, other: e.subject }, e.other, com);
    void duelLoserDelta;
  }
}

/** Bounded insert: strongest stories survive; stale low-confidence talk is pruned. */
function addMemory(gs: GameState, key: string, mem: RumorMemory): void {
  const b = (gs.rumorBoard ??= {});
  const arr = (b[key] ??= []);
  if (arr.some((m) => m.eventId === mem.eventId)) return;
  arr.push(mem);
  while (arr.length > BOARD_CAP) {
    let worst = 0;
    let worstScore = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const m = arr[i];
      const score = m.confidence - ((gs.tick - m.learnedTick) / DAY_TICKS) * 0.08;
      if (score < worstScore) {
        worstScore = score;
        worst = i;
      }
    }
    arr.splice(worst, 1);
  }
}

/**
 * Delivers an event to one settlement's board and opinion. Repetition
 * corroborates (confidence firms up) but reputation is applied at most once
 * per (event, settlement) — a repeated report can never re-pay a deed.
 */
export function deliverToSettlement(gs: GameState, e: WorldEvent, key: string, learnedTick: number, confidence: number, from: string, hops: number): void {
  const arr = board(gs)[key];
  const existing = arr?.find((m) => m.eventId === e.id);
  if (existing) {
    existing.confidence = Math.min(1, existing.confidence + 0.1);
    return;
  }
  addMemory(gs, key, { eventId: e.id, learnedTick, confidence, from, hops });
  applyOpinion(gs, e, key);
}

/**
 * Records one authoritative career event. Returns the event, or null for
 * trivial incidents history should not keep. The witness community hears it
 * immediately; road neighbors and the association channel follow by schedule.
 */
export function recordEvent(gs: GameState, ev: Omit<WorldEvent, "id">): WorldEvent | null {
  if (ev.sig < 1) return null;
  const events = (gs.events ??= []);
  const e: WorldEvent = { ...ev, id: `e${(gs.eventSeq ??= 0) + 1}` };
  gs.eventSeq += 1;
  events.push(e);
  if (events.length > EVENT_CAP) events.splice(0, events.length - EVENT_CAP);

  const world = getWorld(gs.seed);
  const near = nearestSettlement(world, e.x, e.y);
  if (near) {
    deliverToSettlement(gs, e, near.key, e.tick, 1, e.subject === "player" ? "player" : e.subject, 0);
    scheduleFrom(gs, world, e, near.key, 1);
  }

  // the association channel: chapter personnel carry members' deeds to the
  // hall, however far it stands
  if (e.assocId) {
    const hall = chapterKeyOf(gs, e.assocId);
    if (hall && hall !== near?.key) {
      scheduleTransfer(gs, {
        eventId: e.id,
        toKey: hall,
        dueTick: e.tick + transferTicks(gs, e.sig, keyDistance(hall, setKey(e.x, e.y)), e.id, hall),
        confidence: 0.9,
        from: "assoc",
        hops: 1,
      });
    }
  }
  return e;
}

/**
 * Steps the network: delivers due transfers, lets each delivered settlement
 * schedule onward hops along its roads. Called on the propagation cadence
 * from advance — bounded work, no full-world scans.
 */
export function advanceRumors(gs: GameState): void {
  if (gs.tick % PROPAGATION_INTERVAL !== 0) return;
  const q = gs.rumorQ;
  if (!q?.length) return;
  const world = getWorld(gs.seed);
  const stillPending: RumorTransfer[] = [];
  for (const t of q) {
    if (t.dueTick > gs.tick) {
      stillPending.push(t);
      continue;
    }
    const e = gs.events?.find((x) => x.id === t.eventId);
    if (!e) continue; // the event aged out of living memory — the rumor dies with it
    if (t.confidence < MIN_CONFIDENCE || t.hops >= MAX_HOPS) continue;
    const arr = board(gs)[t.toKey];
    if (arr?.some((m) => m.eventId === t.eventId)) continue; // already known here
    deliverToSettlement(gs, e, t.toKey, gs.tick, t.confidence, t.from, t.hops);
    // onward, along the roads, fading
    const onward = t.confidence * (0.55 + 0.3 * propRng(gs, t.eventId, t.toKey));
    if (onward >= MIN_CONFIDENCE) scheduleFrom(gs, world, e, t.toKey, onward);
  }
  gs.rumorQ = stillPending.slice(-QUEUE_CAP);
}

/**
 * A carrier arrives at a settlement: they tell what they know that the green
 * does not, and (for tamers) hear what the green has to say. One exchange,
 * bounded by both sides' caps.
 */
export function carrierExchange(gs: GameState, carrierId: string, key: string, confidence: number): void {
  const events = gs.events ?? [];
  const isPlayer = carrierId === "player";
  const heard = isPlayer ? null : gs.tamers?.[carrierId]?.knowledge.heard;

  // deposit: the carrier's own fresh news
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (gs.tick - e.tick > DAY_TICKS * 6) break; // older news is not worth the telling
    if (!isPlayer && !heard?.[e.id]) continue;
    // the player tells their own deeds; a tamer tells what they have heard of
    if (isPlayer && e.subject !== "player") continue;
    if (!board(gs)[key]?.some((m) => m.eventId === e.id)) {
      addMemory(gs, key, { eventId: e.id, learnedTick: gs.tick, confidence: confidence * 0.9, from: carrierId, hops: 1 });
    }
  }

  // pick up: what the green knows that the tamer does not
  if (heard) {
    for (const m of board(gs)[key] ?? []) {
      if (heard[m.eventId]) continue;
      heard[m.eventId] = 1;
      const e = events.find((x) => x.id === m.eventId);
      if (e) absorbForTamer(gs, carrierId, e, m.confidence * 0.9);
    }
  }
}

/** Folds an event's facts into a tamer's own knowledge (alpha word, rivals). */
export function absorbForTamer(gs: GameState, tamerId: string, e: WorldEvent, confidence: number): void {
  const t = gs.tamers?.[tamerId];
  if (!t || t.knowledge.heard[e.id]) return;
  t.knowledge.heard[e.id] = 1;
  if (e.alphaSpeciesId && e.alphaLevel) {
    // a lead is only a lead while the alpha still walks: defeats of tamers
    // mark a live alpha, victories mark a dead one
    if (e.cat === "alpha_loss") {
      t.knowledge.alphas[e.other] = { x: e.x, y: e.y, speciesId: e.alphaSpeciesId, level: e.alphaLevel, tick: e.tick, secondhand: confidence < 0.95 };
    } else if (e.cat === "alpha_kill" && !e.won) {
      t.knowledge.alphas[e.other] = { x: e.x, y: e.y, speciesId: e.alphaSpeciesId, level: e.alphaLevel, tick: e.tick, secondhand: confidence < 0.95 };
    }
  }
  if (e.cat === "duel") {
    const isSubject = e.subject === tamerId;
    const rivalId = isSubject ? e.other : e.subject;
    const rivalName = isSubject ? e.otherName : e.subjectName;
    const won = isSubject ? e.won : !e.won;
    t.knowledge.rivals[rivalId] = { name: rivalName, x: e.x, y: e.y, tick: e.tick, last: won ? "win" : "loss" };
  }
}

/* --------------------------------- Queries --------------------------------- */

/** The stories a settlement is currently talking about, freshest first. */
export function boardOf(gs: GameState, key: string): RumorMemory[] {
  return [...(gs.rumorBoard?.[key] ?? [])].sort((a, b) => b.learnedTick - a.learnedTick || b.confidence - a.confidence);
}

/** The event behind a rumor memory (null if it aged out of living history). */
export function eventOf(gs: GameState, mem: RumorMemory): WorldEvent | null {
  return gs.events?.find((e) => e.id === mem.eventId) ?? null;
}

/** How stale a memory is, in days. */
export const ageDays = (gs: GameState, mem: RumorMemory): number => Math.floor((gs.tick - mem.learnedTick) / DAY_TICKS);

/** Debug helper for mapcheck: total persisted rumor state size (bounded). */
export function rumorStateSize(gs: GameState): number {
  const b = gs.rumorBoard ?? {};
  let n = 0;
  for (const k in b) n += b[k].length;
  return n + (gs.rumorQ?.length ?? 0) + (gs.events?.length ?? 0);
}

/**
 * The events the PLAYER can honestly know: their own deeds, deeds they took
 * part in, and deeds whose witness settlement they have actually discovered.
 * Undiscovered history stays undiscovered.
 */
export function eventsKnownToPlayer(gs: GameState, limit = 10): WorldEvent[] {
  const events = gs.events ?? [];
  const k = gs.knowledge;
  const world = getWorld(gs.seed);
  const out: WorldEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i];
    if (e.subject === "player" || e.other === "player") {
      out.push(e);
      continue;
    }
    const near = nearestSettlement(world, e.x, e.y, WITNESS_RADIUS);
    if (near && k.discovered[`f:${near.x}:${near.y}`]) out.push(e);
  }
  return out;
}
