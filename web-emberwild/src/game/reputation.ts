import type { GameState, RepEntry, ReputationState, WorldEvent } from "./types";

/**
 * Reputation — how the world's communities stand toward a tamer (the player
 * included), tracked independently at three scopes:
 *
 *   - nation      (ids from getFactions(seed) — a tamer famed in one realm can
 *                  be a stranger in the next)
 *   - association (ids from getFactions(seed) — an association is a charter,
 *                  not a geography; its regard is its own)
 *   - settlement  (stable "x,y" keys from actual settlement features — one
 *                  hamlet may celebrate what another resents)
 *
 * Scales are bounded [-100, +100] with centralized thresholds. Records are
 * sparse and lazily initialized: a subject gains an entry only when a real
 * event puts their name in a community's mouth, and an entry at v=0 still
 * means *known* — distinct from never having been heard of.
 *
 * Reputation is driven exclusively by authoritative career events, applied
 * idempotently: every application is guarded by `eventId:target` in
 * gs.repApplied, so repeated rumor reports can never re-pay the same deed.
 */

export const REP_MIN = -100;
export const REP_MAX = 100;

/** Reception bands, from notoriety through obscurity to renown. */
export const REP_BANDS: { min: number; label: string }[] = [
  { min: 60, label: "celebrated" },
  { min: 25, label: "esteemed" },
  { min: 5, label: "respected" },
  { min: -5, label: "known" },
  { min: -25, label: "distrusted" },
  { min: -60, label: "despised" },
  { min: -1000, label: "notorious" },
];

/** How a community of a given band receives a tamer. */
export function repLabel(v: number): string {
  for (const b of REP_BANDS) if (v >= b.min) return b.label;
  return "known";
}

/** Event weight table — the single tuning surface for reputation impact. */
const BASE_WEIGHT: Record<WorldEvent["cat"], number> = {
  alpha_kill: 7,
  alpha_loss: -5,
  duel: 4,
};

/** Scope multipliers: a settlement feels a deed fully; nation and association hear it secondhand. */
const NATION_SHARE = 0.5;
const ASSOC_SHARE = 0.5;

export function emptyRep(): ReputationState {
  return { nations: {}, assocs: {}, settlements: {} };
}

type Scope = "nations" | "assocs" | "settlements";

/** The subject's raw standing in one scope (null = has never been heard of there). */
export function repOf(gs: GameState, subject: string, scope: Scope, id: string): number | null {
  const ledger = gs.rep?.[scope];
  const e = ledger?.[subject]?.[id];
  return e ? e.v : null;
}

/** Whether the subject is known at all in one scope (an entry at 0 still counts). */
export function isKnown(gs: GameState, subject: string, scope: Scope, id: string): boolean {
  return repOf(gs, subject, scope, id) !== null;
}

/** Applies one bounded reputation change, creating the record lazily. */
function apply(gs: GameState, subject: string, scope: Scope, id: string, delta: number, at: number): void {
  const rep = gs.rep;
  if (!rep || !delta) return;
  const ledger = (rep[scope][subject] ??= {});
  const e: RepEntry = ledger[id] ?? { v: 0, at };
  e.v = Math.max(REP_MIN, Math.min(REP_MAX, e.v + delta));
  e.at = at;
  ledger[id] = e;
}

/** Significance → multiplier: minor scrapes move nobody; great deeds echo. */
function sigMul(sig: number): number {
  return 0.5 + sig * 0.25; // sig 1 → 0.75, sig 5 → 1.75
}

export interface CommunityContext {
  /** The settlement this community lives in (stable "x,y" key). */
  key: string;
  nationId: string | null;
  assocId: string | null;
}

/**
 * Delivers one authoritative event to one community's opinion of one subject,
 * exactly once per (event, community). Scopes: the settlement itself at full
 * weight, its nation and chapter association at shared weight. A community
 * with no nation or association simply applies less.
 *
 * Returns the settlement-scope delta applied (0 when already applied).
 */
export function applyEventToCommunity(gs: GameState, ev: WorldEvent, subject: string, com: CommunityContext): number {
  const guard = `${ev.id}:${com.key}`;
  if (gs.repApplied?.[guard]) return 0;
  gs.repApplied[guard] = 1;
  const base = BASE_WEIGHT[ev.cat] * sigMul(ev.sig) * (ev.won ? 1 : 1);
  // the deed itself speaks: victories lift, defeats weigh, scaled by type
  const delta = Math.round(base);
  apply(gs, subject, "settlements", com.key, delta, ev.tick);
  if (com.nationId) apply(gs, subject, "nations", com.nationId, Math.round(delta * NATION_SHARE), ev.tick);
  if (com.assocId) apply(gs, subject, "assocs", com.assocId, Math.round(delta * ASSOC_SHARE), ev.tick);
  return delta;
}

/**
 * A defeat reads worse than a win reads well at the same significance —
 * folk remember who lost the ring. Applied for duel events only, where the
 * loser is a subject in their own right.
 */
export function duelLoserDelta(ev: WorldEvent): number {
  return Math.round(BASE_WEIGHT.duel * sigMul(ev.sig) * -1.25);
}
