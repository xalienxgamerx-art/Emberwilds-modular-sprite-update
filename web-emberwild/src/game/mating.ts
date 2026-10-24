/**
 * Mating rules: the contextual permission layer between behavior and biology.
 *
 * Wildlife AI asks "who does this creature attempt to pair with?" and player
 * systems ask "is this pairing allowed here?" — both get their answer here,
 * while the biological reproduction engine (reproduction.ts) remains the single
 * authority on whether two bodies are actually capable of reproducing together.
 * This module never re-implements biological rules; it only decides permission.
 */
import { stageOf } from "./growth";
import { bodyId, canReproduce } from "./reproduction";
import type { MatingContext, Monster, WildCreature } from "./types";

/** Why a mating attempt was not permitted. */
export type MatingFailureReason =
  | "invalid_pair"
  | "same_individual"
  | "different_species"
  | "immature"
  | "biological_incompatibility";

/** Structured mating permission. `detail` carries the underlying biological reason for logs and debugging — not for player-facing UI. */
export interface MatingCheckResult {
  ok: boolean;
  reason?: MatingFailureReason;
  detail?: string;
}

/**
 * Contextual species restriction. Wild pairs must share a species; player pairs
 * are unrestricted. Future contexts and species-specific exceptions (e.g.
 * "species A may naturally mate with species B") extend here — the biological
 * engine stays species-blind and untouched.
 */
function speciesPermitted(a: Monster | WildCreature, b: Monster | WildCreature, context: MatingContext): boolean {
  switch (context) {
    case "player":
      return true;
    case "wild":
      return a.speciesId === b.speciesId;
  }
}

/**
 * Authoritative mating permission for a pair in a context. Rule order: validate
 * the pair → reject self-pairing → apply contextual species rules → require the
 * growth stage to be mature (Phase 8: reproductive maturity follows development,
 * not mere existence) → delegate biological compatibility to the reproduction
 * engine. Deterministic by design.
 */
export function canMate(
  a: Monster | WildCreature | null | undefined,
  b: Monster | WildCreature | null | undefined,
  context: MatingContext,
  tick: number,
): MatingCheckResult {
  if (!a || !b) return { ok: false, reason: "invalid_pair" };
  if (bodyId(a) === bodyId(b)) return { ok: false, reason: "same_individual" };
  if (!speciesPermitted(a, b, context)) return { ok: false, reason: "different_species" };
  if (stageOf(a.bornTick, a.speciesId, tick) !== "mature") return { ok: false, reason: "immature" };
  if (stageOf(b.bornTick, b.speciesId, tick) !== "mature") return { ok: false, reason: "immature" };
  const bio = canReproduce(a, b, tick);
  if (!bio.ok) return { ok: false, reason: "biological_incompatibility", detail: bio.reason };
  return { ok: true };
}
