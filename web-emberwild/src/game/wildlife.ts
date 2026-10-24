/**
 * Wildlife behavior (Phase 9) — the unified, needs-driven decision layer for
 * wild monsters.
 *
 * Responsibilities are split along the roadmap lines without inventing a heavy
 * AI framework:
 *  - Profiles: species-derived behavioral tendencies (sociality, nest defense,
 *    challenge willingness, injury fear) so strategies come from species data,
 *    never hardcoded per-species conditionals in the decision code.
 *  - Perception: one bounded pass over the bodies the sim already collected
 *    (`near`, everything within the simulation radius) answers every question
 *    the decisions ask — threats, prey, mates, kin, range intruders, brood.
 *  - Decisions: migration (pressure-driven, cooldown-gated, real movement) and
 *    dominance transfer live here; sim.ts executes movement and combat through
 *    its existing machinery, and the authoritative territory, mating, ecology
 *    and reproduction systems keep their roles untouched.
 *
 * Everything is deterministic: decisions read only seeded hashes and state the
 * sim already gathered. No global searches; strategic decisions are staggered.
 */
import { SPECIES, developmentTypeFor } from "./data";
import { isDependent } from "./growth";
import { canMate } from "./mating";
import { hashString } from "./rng";
import { SURFACE } from "./height";
import { ensureTerritory, releaseTerritoryOwner, territoryOf } from "./territory";
import type { TerritoryEcology } from "./ecology";
import type { GameState, Nest, Territory, WildCreature } from "./types";

const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/* --------------------------------- Profiles ---------------------------------- */

export type Sociality = "pack" | "loose" | "solitary";

export interface BehaviorProfile {
  social: Sociality;
  /** Defends nests and developing offspring. */
  defendsNest: boolean;
  /** May depose a weakened same-species alpha. */
  challenges: boolean;
  /** hpFrac below which the body breaks off and flees. */
  fleeHp: number;
}

/** Named overrides where species data alone misleads (kept minimal). */
/* --------------------------- Courtship & family config ------------------------ */

/** How far an eligible adult can spot a potential mate (tiles, chebyshev). */
export const MATE_SEEK_R = 14;
/** A pursuit beyond this far is abandoned — the candidate drifted out of reach. */
export const MATE_GIVEUP_R = 26;
/** Satiety both bodies need before courtship (feeding beats breeding). */
export const MATE_SATIETY = 50;
/** How far a mating call carries (tiles, chebyshev). */
export const CALL_HEAR_R = 14;
/** Ticks between a body's mating calls (per-body stagger on top of the hash gate). */
export const CALL_COOLDOWN = 120;
/** Per-tick chance an eligible, unmated adult calls (hash-gated: ~1.2 calls/day). */
export const CALL_CHANCE = 0.004;
/** A dependent juvenile keeps this close to its parent (tiles, chebyshev). */
export const FOLLOW_DIST = 2;
/** A parent closes in on its young when they drift past this far. */
export const PARENT_LEASH = 6;
/** How far a parent tracks its dependent young. */
export const YOUNG_SIGHT_R = 16;

const OVERRIDES: Record<string, Partial<BehaviorProfile>> = {
  crystal_golem: { social: "solitary", challenges: false, defendsNest: false },
  ironfang_tyrant: { social: "solitary", challenges: true },
};

const profiles = new Map<string, BehaviorProfile>();

/** Species-derived behavioral profile (cached; species data is the single source). */
export function profileOf(speciesId: string): BehaviorProfile {
  const hit = profiles.get(speciesId);
  if (hit) return hit;
  const sp = SPECIES[speciesId];
  const social: Sociality = sp.family === "Beast" && sp.aggression >= 0.35 ? "pack" : sp.family === "Bug" || sp.family === "Spirit" ? "solitary" : "loose";
  const p: BehaviorProfile = {
    social,
    defendsNest: developmentTypeFor(speciesId, "sexual") === "egg" || social !== "solitary",
    challenges: sp.aggression >= 0.45 && social !== "solitary",
    fleeHp: Math.min(0.32, Math.max(0.08, 0.3 - sp.aggression * 0.2)),
  };
  const out: BehaviorProfile = { ...p, ...OVERRIDES[speciesId] };
  profiles.set(speciesId, out);
  return out;
}

/** Predator/prey rule — the one source both perception and hunting use. A
 *  desperate (starving) predator stretches the rule by one size class and one
 *  level; threat detection always uses the strict rule. */
export function predatesOn(a: WildCreature, b: WildCreature, desperate = false): boolean {
  const sa = SPECIES[a.speciesId];
  const sb = SPECIES[b.speciesId];
  if (a.speciesId === b.speciesId || b.alpha) return false;
  if (sa.diet === "carnivore" || (sa.diet === "omnivore" && a.satiety < 25)) {
    return desperate
      ? sa.size + 1 >= sb.size && a.level + 3 >= b.level
      : sa.size >= sb.size && a.level + 2 >= b.level;
  }
  return false;
}

/* -------------------------------- Perception --------------------------------- */

export interface WildlifePerception {
  /** A predator that can eat this body (nearest first). */
  threat: WildCreature | null;
  /** The best prey this body can hunt. */
  prey: WildCreature | null;
  /** A compatible, ready mate within touching distance. */
  mate: WildCreature | null;
  /** Same-species free-roaming bodies nearby (competition metric). */
  kin: number;
  /** A non-kin body inside this body's territory. */
  intruder: WildCreature | null;
  /** This body's (or its range's) nest with developing young. */
  brood: Nest | null;
  /** A body loitering beside the brood. */
  broodThreat: WildCreature | null;
  /** The nearest compatible mate within courting range (not merely touching). */
  mateCandidate: WildCreature | null;
  /** This body's nearest dependent offspring in sight. */
  young: WildCreature | null;
  /** A predator loitering beside the young. */
  youngThreat: WildCreature | null;
}

/** One bounded pass over the sim's collected bodies answers every query below. */
export function perceiveWildlife(state: GameState, c: WildCreature, near: WildCreature[], terr: Territory | null, tick: number): WildlifePerception {
  const packmate = (o: WildCreature): boolean => o.pack === c.id || c.pack === o.id || (c.pack !== undefined && o.pack === c.pack);
  let threat: WildCreature | null = null;
  let threatD = 5;
  let prey: WildCreature | null = null;
  let preyD = 7;
  let mate: WildCreature | null = null;
  let mateCandD = MATE_SEEK_R + 1;
  let mateCandidate: WildCreature | null = null;
  let youngD = YOUNG_SIGHT_R + 1;
  let young: WildCreature | null = null;
  let kin = 0;
  let intruder: WildCreature | null = null;
  let intruderD = 99;
  for (const o of near) {
    if (o === c || !state.creatures[o.id]) continue;
    const d = cheb(o.x, o.y, c.x, c.y);
    if (d < threatD && predatesOn(o, c) && o.satiety < 50) {
      threat = o;
      threatD = d;
    }
    if (d < preyD && predatesOn(c, o)) {
      prey = o;
      preyD = d;
    }
    if (o.speciesId === c.speciesId && d <= 8 && !o.alpha && !o.pack) kin++;
    // a courtable partner anywhere in courting range — nearest first
    if (d < mateCandD && c.satiety > MATE_SATIETY && o.satiety > MATE_SATIETY && !o.alpha && !o.pack && (o.layer ?? SURFACE) === (c.layer ?? SURFACE) && canMate(c, o, "wild", tick).ok) {
      mateCandidate = o;
      mateCandD = d;
    }
    // my own dependent young, nearest first
    if (d < youngD && o.parents?.includes(c.id) && isDependent(o.bornTick, o.speciesId, tick)) {
      young = o;
      youngD = d;
    }
    // both parents reasonably fed — breeding no longer demands near-full satiety;
    // hungry bodies still feed first (the feeding branch runs below satiety 45)
    if (!mate && c.satiety > 50 && d <= 1 && !o.alpha && !o.pack && o.satiety > 50 && canMate(c, o, "wild", tick).ok) mate = o;
    // intruder checks are column-spanning: for a flier, the sky above the range is part of it
    if (terr && !packmate(o) && d < intruderD && cheb(o.x, o.y, terr.x, terr.y) <= terr.radius) {
      intruder = o;
      intruderD = d;
    }
  }
  // brood: my own nest, else any developing clutch registered to my range
  let brood: Nest | null = null;
  const own = c.repro?.nestId ? state.nests[c.repro.nestId] : null;
  if (own && own.state === "active" && own.developmentIds.some((id) => state.developments[id]?.state === "developing")) brood = own;
  else if (terr) {
    for (const nid of terr.nestIds) {
      const n = state.nests[nid];
      if (n && n.state === "active" && n.developmentIds.some((id) => state.developments[id]?.state === "developing")) {
        brood = n;
        break;
      }
    }
  }
  let broodThreat: WildCreature | null = null;
  if (brood) {
    let bd = 4;
    for (const o of near) {
      if (o === c || !state.creatures[o.id] || packmate(o) || o.speciesId === c.speciesId) continue;
      const d = cheb(o.x, o.y, brood.x, brood.y);
      if (d <= 3 && d < bd) {
        broodThreat = o;
        bd = d;
      }
    }
  }
  let youngThreat: WildCreature | null = null;
  if (young) {
    let ytd = 4;
    for (const o of near) {
      if (o === c || o === young || !state.creatures[o.id] || o.speciesId === c.speciesId) continue;
      const d = cheb(o.x, o.y, young.x, young.y);
      if (d <= 3 && d < ytd && predatesOn(o, young)) {
        youngThreat = o;
        ytd = d;
      }
    }
  }
  return { threat, prey, mate, kin, intruder, brood, broodThreat, mateCandidate, young, youngThreat };
}

/* --------------------------------- Courtship ---------------------------------- */

/**
 * Validates this body's courting intent and returns the live target, picking a
 * fresh one from perception when the old one died, drifted away, or became
 * ineligible. The intent is stable: a body keeps its chosen mate until one of
 * those conditions breaks — no target switching without a reason.
 */
export function seekMateTarget(state: GameState, c: WildCreature, per: WildlifePerception, tick: number): WildCreature | null {
  const cur = c.mateTarget ? state.creatures[c.mateTarget] : undefined;
  if (cur && cur !== c && (cur.layer ?? SURFACE) === (c.layer ?? SURFACE) && cheb(cur.x, cur.y, c.x, c.y) <= MATE_GIVEUP_R && canMate(c, cur, "wild", tick).ok) {
    return cur;
  }
  // stale, dead, out of reach, or unavailable — reselect deterministically
  c.mateTarget = per.mateCandidate?.id;
  return per.mateCandidate ?? null;
}

/**
 * Emits a mating call: every compatible, eligible listener within hearing sets
 * out toward the caller (as its courting intent). Never teleports, never
 * creates creatures, never bypasses the mating rules — permission is checked
 * per listener. Returns the number of bodies that responded.
 */
export function emitMatingCall(state: GameState, caller: WildCreature, near: WildCreature[], tick: number): number {
  let heard = 0;
  for (const o of near) {
    if (o === caller || !state.creatures[o.id] || o.speciesId !== caller.speciesId) continue;
    if (o.mateTarget || o.alpha || o.pack || o.satiety <= MATE_SATIETY) continue;
    if (cheb(o.x, o.y, caller.x, caller.y) > CALL_HEAR_R) continue;
    if (!canMate(o, caller, "wild", tick).ok) continue;
    o.mateTarget = caller.id;
    o.activity = "Answering a mating call";
    heard++;
  }
  return heard;
}

/* ---------------------------------- Family ------------------------------------ */

/**
 * This dependent juvenile's guardian: the first parent still alive on the same
 * layer (deterministic parent order; a second parent is the natural fallback).
 * Null when orphaned or independent — the body then behaves like any adult.
 */
export function guardianOf(state: GameState, c: WildCreature, tick: number): WildCreature | null {
  if (!isDependent(c.bornTick, c.speciesId, tick) || !c.parents) return null;
  for (const pid of c.parents) {
    const p = state.creatures[pid];
    if (p && (p.layer ?? SURFACE) === (c.layer ?? SURFACE)) return p;
  }
  return null;
}

/* --------------------------------- Migration ---------------------------------- */

/** Migration pressure a body must see before leaving its range (hysteresis). */
export const MIGRATION_PRESSURE = 0.55;
/** Ticks before the same body may settle again (no oscillation). */
export const MIGRATION_COOLDOWN = 576;
/** Ticks between settlement retries while still inside the old range's gravity. */
export const MIGRATION_RETRY = 48;

export interface MigrationIntent {
  active: boolean;
  tx: number;
  ty: number;
}

/**
 * Decides whether a body strikes out for new grounds. The decision is O(1) —
 * the caller's per-tick assessment cache does the heavy lifting — and
 * cooldown-gated so a settling body never oscillates; movement stays with the
 * sim.
 */
export function migrationIntent(gs: GameState, c: WildCreature, eco: TerritoryEcology | undefined, home: { x: number; y: number }, tick: number): MigrationIntent {
  const none: MigrationIntent = { active: false, tx: 0, ty: 0 };
  if (!eco || c.alpha) return none;
  if (c.migrateUntil !== undefined && tick < c.migrateUntil) return none;
  if (eco.migrationPressure < MIGRATION_PRESSURE) return none;
  const bearing = (hashString(c.id) % 628) / 100;
  return { active: true, tx: Math.round(home.x + Math.cos(bearing) * 22), ty: Math.round(home.y + Math.sin(bearing) * 22) };
}

/**
 * A migrating body that has cleared its old range settles through the Phase 6
 * system — joining a same-species range or founding its own. Returns true when
 * the body's home actually changed; otherwise a short retry cooldown prevents
 * per-tick churn (no abandon/re-enter oscillation).
 */
export function settleMigration(gs: GameState, c: WildCreature, oldTerritoryId: string | undefined, tick: number): boolean {
  delete c.territoryId;
  const t = ensureTerritory(gs, c, { x: c.x, y: c.y });
  if (t.id !== oldTerritoryId) {
    c.migrateUntil = tick + MIGRATION_COOLDOWN;
    return true;
  }
  c.migrateUntil = tick + MIGRATION_RETRY;
  return false;
}

/* --------------------------------- Dominance ---------------------------------- */

/**
 * Dominance transfer after a won challenge: the old alpha loses rank and
 * loyalty, the challenger takes the pack and the range's ownership. Ownership
 * stays with the territory system — this only writes the fields that system
 * already owns.
 */
export function seizeTerritory(gs: GameState, c: WildCreature, alpha: WildCreature, tick: number): void {
  const t = territoryOf(gs, alpha);
  const wasOwner = !!t && t.ownerId === alpha.id;
  releaseTerritoryOwner(gs, alpha.id);
  if (t) {
    // membership follows the takeover: the challenger now belongs to the
    // claimed range, and its own former claim (if any) lapses
    const prev = territoryOf(gs, c);
    if (prev && prev.id !== t.id && prev.ownerId === c.id) {
      prev.ownerId = undefined;
      prev.contested = true;
    }
    c.territoryId = t.id;
    if (wasOwner || !t.ownerId) {
      t.ownerId = c.id;
      t.contested = false;
    }
  }
  alpha.alpha = false;
  alpha.pack = undefined;
  alpha.disposition = "skittish";
  alpha.calmUntil = tick + 240;
  alpha.stalking = false;
  c.alpha = true;
  c.stalking = false;
  for (const o of Object.values(gs.creatures)) if (o.pack === alpha.id) o.pack = c.id;
}
