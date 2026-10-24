/**
 * Signature Moves (procedurally evolving techniques).
 *
 * One evolving technique per monster. The framework is a thin layer over the
 * existing SkillDef architecture: modifiers are pure functions over a mutable
 * copy of the base move's definition, resolution happens at execution time,
 * and every chosen modifier is stored — so a save/load replays the exact same
 * move. Wild monsters use the identical catalog through deterministic
 * auto-evolution; offspring inherit copies through the breeding blueprint.
 *
 * The base move id stays in the monster's skills array (its castable slot);
 * inherited techniques occupy their own `sig:<n>` slots on the same array.
 * Nothing here duplicates combat math — strike/useSkill read the resolved
 * definition like any base move.
 */
import { ELEMENTS, SKILLS, SPECIES, type SkillDef } from "./data";
import { Rng, hash01, hashString } from "./rng";
import type { GameState, Monster, SignatureState, StatusId } from "./types";

/** SkillDef plus the few execution hooks only signature resolution can add. */
export interface EffectiveSkill extends SkillDef {
  /** Extra strikes on the same target (each after the first at reduced key). */
  hits?: number;
  /** +25% damage while the target carries any status. */
  bonusVsStatus?: boolean;
  /** Damage multiplier against wounded targets (< 40% HP). */
  execute?: number;
  /** Fraction of dealt damage returned as HP. */
  lifesteal?: number;
}

type MutSkill = EffectiveSkill & { dice: [number, number]; status?: [StatusId, number, number]; selfStatus?: [StatusId, number] };

/** Evolution milestones: every 10 levels starting at 10. */
export const SIG_MILESTONE = 10;
/** Wild monsters at/above this level may have developed a signature. */
export const WILD_SIG_MIN_LEVEL = 10;
/** Chance a generated wild body of qualifying level carries one. */
export const WILD_SIG_CHANCE = 0.1;
/** Chance an offspring inherits a parent's signature move. */
export const SIG_INHERIT_CHANCE = 0.35;

/* ------------------------------- The catalog --------------------------------- */

export interface SigMod {
  id: string;
  cat: "power" | "delivery" | "status" | "conditional" | "sustain" | "battlefield";
  label: string;
  /** What the choice adds, shown before confirming. */
  desc: string;
  /** Name adjective contributed when this shapes the move's identity. */
  adj?: string;
  /** Delivery noun override (Lance, Burst, Barrage...). */
  noun?: string;
  /** Higher wins when several nouns could apply. */
  nounPrio?: number;
  fits(cfg: EffectiveSkill): boolean;
  apply(cfg: MutSkill): void;
}

const atkMove = (cfg: EffectiveSkill): boolean => cfg.dice[0] > 0;
const noStatus = (cfg: EffectiveSkill): boolean => !cfg.status;

export const SIG_MODS: Record<string, SigMod> = {
  /* ---- power: numeric, never changes the name ---- */
  power_focus: {
    id: "power_focus", cat: "power", label: "Focused Power",
    desc: "Hits harder (max die +2), but takes longer to ready (cooldown +1).",
    fits: atkMove,
    apply: (c) => { c.dice[1] += 2; c.cooldown += 1; },
  },
  power_brutal: {
    id: "power_brutal", cat: "power", label: "Brutal Force",
    desc: "An extra damage die, at the cost of accuracy (-1).",
    fits: atkMove,
    apply: (c) => { c.dice[0] += 1; c.acc -= 1; },
  },
  keen: {
    id: "keen", cat: "power", label: "Keen Aim",
    desc: "+2 accuracy — lands far more reliably.",
    fits: (c) => atkMove(c) || !!c.status,
    apply: (c) => { c.acc += 2; },
  },
  shattering: {
    id: "shattering", cat: "power", label: "Armor-Piercing",
    desc: "+2 penetration — bites through heavy armor.",
    fits: atkMove,
    apply: (c) => { c.pen += 2; },
  },
  /* ---- delivery: shapes how the move travels ---- */
  reach: {
    id: "reach", cat: "delivery", label: "Extended Reach",
    desc: "Flies to targets 2 tiles further away.",
    noun: "Lance", nounPrio: 1,
    fits: (c) => c.range < 8 && !c.dash && atkMove(c),
    apply: (c) => { c.range = Math.min(8, c.range + 2); },
  },
  wide: {
    id: "wide", cat: "delivery", label: "Wide Sweep",
    desc: "Strikes an area (radius +1), spreading its power thinner (-20% per die).",
    noun: "Burst", nounPrio: 2,
    fits: (c) => atkMove(c) && !c.dash,
    apply: (c) => { c.radius = Math.max(1, c.radius + 1); c.dice[1] = Math.max(2, Math.round(c.dice[1] * 0.8)); },
  },
  twin: {
    id: "twin", cat: "delivery", label: "Twin Strike",
    desc: "Strikes twice, each blow 30% lighter.",
    adj: "Twin",
    fits: (c) => atkMove(c) && !c.hits,
    apply: (c) => { c.hits = 2; c.dice[1] = Math.max(2, Math.round(c.dice[1] * 0.7)); },
  },
  barrage: {
    id: "barrage", cat: "delivery", label: "Projectile Barrage",
    desc: "Looses three homing volleys (55% damage each) from one casting.",
    noun: "Barrage", nounPrio: 3,
    fits: (c) => atkMove(c) && c.range > 1 && c.radius === 0 && (c.hits ?? 1) < 3,
    apply: (c) => { c.hits = 3; c.dice[1] = Math.max(2, Math.round(c.dice[1] * 0.55)); c.range = Math.min(8, c.range + 1); },
  },
  swift: {
    id: "swift", cat: "delivery", label: "Swift Casting",
    desc: "Readies 1 turn faster (cooldown -1).",
    fits: (c) => c.cooldown > 0,
    apply: (c) => { c.cooldown = Math.max(0, c.cooldown - 1); },
  },
  /* ---- status: one status shaping, or deepening the existing one ---- */
  searing: {
    id: "searing", cat: "status", label: "Searing Touch",
    desc: "May set the target Burning (50%, 3 turns).",
    adj: "Blazing",
    fits: (c) => noStatus(c) && atkMove(c),
    apply: (c) => { c.status = ["burning", 0.5, 3]; },
  },
  chilling: {
    id: "chilling", cat: "status", label: "Chill",
    desc: "May leave the target Slowed (60%, 2 turns).",
    adj: "Chilling",
    fits: (c) => noStatus(c) && atkMove(c),
    apply: (c) => { c.status = ["slowed", 0.6, 2]; },
  },
  venomed: {
    id: "venomed", cat: "status", label: "Venom",
    desc: "May Poison the target (50%, 3 turns).",
    adj: "Venomous",
    fits: (c) => noStatus(c) && atkMove(c),
    apply: (c) => { c.status = ["poisoned", 0.5, 3]; },
  },
  binding: {
    id: "binding", cat: "status", label: "Binding Grip",
    desc: "May Root the target in place (40%, 2 turns).",
    adj: "Binding",
    fits: (c) => noStatus(c) && atkMove(c),
    apply: (c) => { c.status = ["rooted", 0.4, 2]; },
  },
  staggering: {
    id: "staggering", cat: "status", label: "Staggering Blow",
    desc: "May Stun the target (25%, 1 turn).",
    adj: "Staggering",
    fits: (c) => noStatus(c) && atkMove(c),
    apply: (c) => { c.status = ["stunned", 0.25, 1]; },
  },
  blinding: {
    id: "blinding", cat: "status", label: "Dazzle",
    desc: "May Blind the target (-5 to hit, 60%, 2 turns).",
    adj: "Blinding",
    fits: (c) => noStatus(c) && atkMove(c),
    apply: (c) => { c.status = ["blinded", 0.6, 2]; },
  },
  potency: {
    id: "potency", cat: "status", label: "Heightened Potency",
    desc: "Its status bites deeper: +20% chance and +1 turn.",
    fits: (c) => !!c.status,
    apply: (c) => { if (c.status) c.status = [c.status[0], Math.min(0.95, c.status[1] + 0.2), c.status[2] + 1]; },
  },
  /* ---- conditional: specialized, situational power ---- */
  culling: {
    id: "culling", cat: "conditional", label: "Culling Strike",
    desc: "+40% damage against wounded targets (below 40% HP).",
    adj: "Dire",
    fits: atkMove,
    apply: (c) => { c.execute = Math.max(c.execute ?? 1, 1.4); },
  },
  hunters: {
    id: "hunters", cat: "conditional", label: "Hunter's Insight",
    desc: "+25% damage against targets already suffering a status.",
    adj: "Hunter's",
    fits: atkMove,
    apply: (c) => { c.bonusVsStatus = true; },
  },
  /* ---- sustain ---- */
  siphoning: {
    id: "siphoning", cat: "sustain", label: "Siphoning",
    desc: "Drinks 30% of the damage it deals back as HP.",
    adj: "Siphoning",
    fits: atkMove,
    apply: (c) => { c.lifesteal = Math.max(c.lifesteal ?? 0, 0.3); },
  },
  warding: {
    id: "warding", cat: "sustain", label: "Wary Stance",
    desc: "Grants Wary (+3 defense) for 2 turns when cast.",
    fits: (c) => !c.selfStatus,
    apply: (c) => { c.selfStatus = ["wary", 2]; },
  },
  shelling: {
    id: "shelling", cat: "sustain", label: "Shell Guard",
    desc: "Grants Shelled (+4 armor) for 2 turns when cast.",
    fits: (c) => !c.selfStatus,
    apply: (c) => { c.selfStatus = ["shelled", 2]; },
  },
  mending: {
    id: "mending", cat: "sustain", label: "Deep Mending",
    desc: "Restores 4 more HP when it heals.",
    fits: (c) => !!c.heal,
    apply: (c) => { c.heal = (c.heal ?? 0) + 4; },
  },
  /* ---- battlefield ---- */
  scorched: {
    id: "scorched", cat: "battlefield", label: "Scorching Wake",
    desc: "Sets the ground where it lands alight.",
    adj: "Blazing",
    fits: (c) => !c.ignite && atkMove(c),
    apply: (c) => { c.ignite = true; },
  },
};

/* ------------------------------- Resolution ---------------------------------- */

/** Merges the base move with its accumulated modifiers (no naming — pure mechanics). */
function mergeMods(baseId: string, mods: string[]): MutSkill {
  const base = SKILLS[baseId];
  const cfg: MutSkill = { ...base, dice: [base.dice[0], base.dice[1]] };
  if (base.status) cfg.status = [...base.status] as [StatusId, number, number];
  if (base.selfStatus) cfg.selfStatus = [...base.selfStatus] as [StatusId, number];
  for (const id of mods) SIG_MODS[id]?.apply(cfg);
  return cfg;
}

/** Merges the base move with its accumulated modifiers. Pure; save-stable. */
export function resolveSignature(baseId: string, mods: string[]): EffectiveSkill {
  const cfg = mergeMods(baseId, mods);
  cfg.name = nameFor(baseId, mods);
  cfg.desc = describe(baseId, mods);
  return cfg;
}

/** The definition a body casts for a given skill-slot id (base id or sig instance). */
export function skillOf(owner: { sig?: SignatureState; sigKnown?: SignatureState[] } | null | undefined, id: string): EffectiveSkill | undefined {
  if (id.startsWith("sig:")) {
    const st = owner?.sigKnown?.find((s) => s.uid === id);
    return st ? resolveSignature(st.baseId, st.mods) : undefined;
  }
  if (owner?.sig && owner.sig.baseId === id) return resolveSignature(owner.sig.baseId, owner.sig.mods);
  return SKILLS[id] as EffectiveSkill | undefined;
}

/* --------------------------------- Naming ------------------------------------ */

const ELEMENT_WORD: Record<string, string> = {
  neutral: "Iron", fire: "Flame", water: "Tide", earth: "Stone", air: "Gale", nature: "Briar", frost: "Frost", shadow: "Umbra",
};

/** Adjective priority: the rarest-conditional behavior leads the name. */
const ADJ_ORDER = ["Siphoning", "Dire", "Hunter's", "Blazing", "Venomous", "Staggering", "Binding", "Blinding", "Chilling", "Twin"];

/** The generated name — computed from the move's full accumulated behavior. */
export function nameFor(baseId: string, mods: string[]): string {
  const base = SKILLS[baseId];
  if (!base) return baseId;
  const cfg = mergeMods(baseId, mods);
  const nouns: { n: string; p: number }[] = [];
  if (cfg.dash) nouns.push({ n: "Pounce", p: 4 });
  if ((cfg.hits ?? 1) >= 3) nouns.push({ n: "Barrage", p: 5 });
  if (cfg.radius > 0) nouns.push({ n: "Burst", p: 3 });
  if (cfg.range >= 4) nouns.push({ n: "Lance", p: 2 });
  else if (cfg.range > 1) nouns.push({ n: "Bolt", p: 1 });
  const adj = mods.map((m) => SIG_MODS[m]?.adj).filter((a): a is string => !!a)
    .sort((a, b) => ADJ_ORDER.indexOf(a) - ADJ_ORDER.indexOf(b))[0];
  const top = nouns.sort((a, b) => b.p - a.p)[0];
  // melee moves keep their own recognizable noun; ranged identity shifts rename
  const noun = top ? top.n : base.name;
  const head = adj ?? (top ? ELEMENT_WORD[base.element] : "");
  const grand = !adj && (cfg.hits ?? 0) >= 2 ? "Grand " : "";
  return `${grand}${head ? `${head} ` : ""}${noun}`;
}

/** Mechanical readout shown on the move card — what each modifier adds. */
export function describe(baseId: string, mods: string[]): string {
  const base = SKILLS[baseId];
  if (!base) return "";
  if (!mods.length) return base.desc;
  const parts = mods.map((m) => SIG_MODS[m]?.desc.replace(/\.$/, "")).filter(Boolean);
  return `${base.name} — ${parts.join("; ")}.`;
}

/* --------------------------- Evolution & choices ------------------------------ */

/** Whether the body's signature has an evolution waiting at its current level. */
export function sigEvolutionReady(sig: SignatureState, level: number): boolean {
  return level >= sig.nextLevel;
}

/**
 * The three choices for the next milestone — deterministic for a given
 * signature state, so the same offer persists until a choice is made.
 */
export function evolutionChoices(sig: SignatureState): SigMod[] {
  const rng = new Rng(hashString(sig.uid) ^ hashString(sig.baseId) ^ sig.gen * 7919 ^ 0x51c);
  const cfg = resolveSignature(sig.baseId, sig.mods);
  const owned = new Set(sig.mods);
  const pool = Object.values(SIG_MODS).filter((m) => !owned.has(m.id) && m.fits(cfg));
  // shuffle deterministically, then take one per distinct category for variety
  const shuffled = [...pool].sort(() => rng.next() - 0.5);
  const picked: SigMod[] = [];
  const cats = new Set<string>();
  for (const m of shuffled) {
    if (cats.has(m.cat)) continue;
    picked.push(m);
    cats.add(m.cat);
    if (picked.length === 3) break;
  }
  for (const m of shuffled) {
    if (picked.length === 3) break;
    if (!picked.includes(m)) picked.push(m);
  }
  return picked;
}

/** Applies a chosen modifier: permanent, accumulating, re-named. */
export function applyEvolution(sig: SignatureState, modId: string): string {
  const mod = SIG_MODS[modId];
  if (!mod || sig.mods.includes(modId)) return "";
  sig.mods.push(modId);
  sig.gen += 1;
  sig.history.push(`Added ${mod.label}`);
  sig.name = nameFor(sig.baseId, sig.mods);
  sig.nextLevel += SIG_MILESTONE;
  return sig.name;
}

/* ------------------------------- Wild development ----------------------------- */

/**
 * A newly generated wild body may carry a signature developed over its
 * lifetime: the base move is drawn from its learnset and one evolution is
 * auto-applied per milestone it has passed, all from its deterministic seed.
 */
export function buildWildSignature(speciesId: string, level: number, skills: string[], seed: number): SignatureState | null {
  if (level < WILD_SIG_MIN_LEVEL) return null;
  if (hash01(seed, level, 0x51c) >= WILD_SIG_CHANCE) return null;
  const castable = skills.filter((s) => SKILLS[s]);
  if (!castable.length) return null;
  const rng = new Rng(seed ^ 0x516);
  const baseId = castable[rng.int(0, castable.length - 1)];
  const sig: SignatureState = {
    uid: "sig:w",
    baseId,
    name: SKILLS[baseId].name,
    mods: [],
    gen: 0,
    history: [SKILLS[baseId].name],
    nextLevel: SIG_MILESTONE,
    origin: "wild",
  };
  const milestones = Math.min(4, Math.floor(level / SIG_MILESTONE));
  for (let i = 0; i < milestones; i++) {
    const choices = evolutionChoices(sig);
    if (!choices.length) break;
    applyEvolution(sig, choices[rng.int(0, choices.length - 1)].id);
  }
  sig.nextLevel = (Math.floor(level / SIG_MILESTONE) + 1) * SIG_MILESTONE;
  return sig;
}

/** A wild body that levels past a milestone evolves on its own (deterministic). */
export function autoEvolveWild(sig: SignatureState, seed: number): void {
  const rng = new Rng(seed ^ hashString(sig.uid) ^ sig.gen * 104729 ^ 0x51d);
  const choices = evolutionChoices(sig);
  if (choices.length) applyEvolution(sig, choices[rng.int(0, choices.length - 1)].id);
}

/* ------------------------------ Player actions -------------------------------- */

/** Designates one of the monster's moves as its permanent Signature Move. */
export function designateSignature(gs: GameState, uid: string, skillId: string): { ok: boolean; msg?: string } {
  const mon = gs.party.find((m) => m.uid === uid);
  if (!mon) return { ok: false };
  if (mon.sig) return { ok: false };
  if (!SKILLS[skillId] || !mon.skills.includes(skillId)) return { ok: false };
  mon.sig = {
    uid: skillId,
    baseId: skillId,
    name: SKILLS[skillId].name,
    mods: [],
    gen: 0,
    history: [SKILLS[skillId].name],
    nextLevel: mon.level < SIG_MILESTONE ? SIG_MILESTONE : (Math.floor(mon.level / SIG_MILESTONE) + 1) * SIG_MILESTONE,
    origin: "chosen",
  };
  return { ok: true, msg: `${SKILLS[skillId].name} is now ${displayNameOf(mon)}'s Signature Move — this choice is permanent.` };
}

/** Records the player's evolution choice at a milestone. */
export function chooseEvolution(gs: GameState, uid: string, modId: string): { ok: boolean; msg?: string } {
  const mon = gs.party.find((m) => m.uid === uid);
  if (!mon?.sig) return { ok: false };
  if (mon.level < mon.sig.nextLevel) return { ok: false };
  const name = applyEvolution(mon.sig, modId);
  return name ? { ok: true, msg: `The technique deepens — it is now ${name}.` } : { ok: false };
}

const displayNameOf = (m: Monster): string => m.nickname ?? SPECIES[m.speciesId].name;

/* -------------------------------- Inheritance --------------------------------- */

/**
 * Rolls signature inheritance from a breeding pair (blueprint stage). Returns
 * a full copy of the donor's evolved move — a normal move for the offspring,
 * never its active signature.
 */
export function inheritSignature(donors: (SignatureState | undefined)[], nextSlot: number, rng: Rng): SignatureState | undefined {
  const live = donors.filter((s): s is SignatureState => !!s);
  if (!live.length || !rng.chance(SIG_INHERIT_CHANCE)) return undefined;
  const donor = live[rng.int(0, live.length - 1)];
  return { ...donor, mods: [...donor.mods], history: [...donor.history], uid: `sig:${nextSlot}`, origin: "inherited" };
}
