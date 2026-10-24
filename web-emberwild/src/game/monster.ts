import { MUTATIONS, PERSONALITIES, SKILLS, SPECIES } from "./data";
import { expressGene, founderLineage, rollGenome, sizeStatMul, speciesSizePair } from "./genetics";
import { matureAgeOf, growthOf, growthStatMul } from "./growth";
import { Rng, hashString } from "./rng";
import { makeReproProfile, rollReproMode } from "./reproduction";
import { sigEvolutionReady } from "./signature";
import type { GameState, GeneKey, Genome, Monster, MutationId, MutationRecord, PersonalityId, Sex, SignatureState, StatKey, Stats } from "./types";

export const GENE_FOR: Record<StatKey, GeneKey> = { hp: "vigor", atk: "might", def: "guard", agi: "swift", wis: "wit" };
export const GENE_LABEL: Record<GeneKey, string> = { vigor: "Vigor", might: "Might", guard: "Guard", swift: "Swift", wit: "Wit", size: "Size" };
export { getGeneGrade as geneGrade } from "./genetics";
const GROWTH: Record<StatKey, number> = { hp: 0.13, atk: 0.09, def: 0.09, agi: 0.08, wis: 0.09 };
const PERSONALITY_IDS = Object.keys(PERSONALITIES) as PersonalityId[];
export const GOOD_MUTS: MutationId[] = ["thick_hide", "twin_hearted", "luminous", "quickened", "iron_jaw", "old_soul", "ember_veins", "star_marked"];
export const BAD_MUTS: MutationId[] = ["frail", "hollow_eyed"];

/** Founder genome — delegates to the shared genetics module. */
export function rollGenes(rng: Rng, bonus = 0, speciesId: string): Genome {
  return rollGenome(rng, speciesId, bonus);
}

export function rollPersonality(rng: Rng): PersonalityId {
  return rng.pick(PERSONALITY_IDS);
}

/** Display info for each sex: glyph, label and UI color. */
export const SEX_INFO: Record<Sex, { label: string; glyph: string; color: string }> = {
  male: { label: "Male", glyph: "♂", color: "#3f7fd0" },
  female: { label: "Female", glyph: "♀", color: "#c2527f" },
  asexual: { label: "Asexual", glyph: "◌", color: "#8a8477" },
};

/** Rolls a monster's sex: male/female for sexed species, asexual for spirits, slimes, the golem and plants. */
export function rollSex(rng: Rng, speciesId: string): Sex {
  return rollReproMode(rng, speciesId);
}

export function rollMutations(rng: Rng, gloom: boolean): MutationId[] {
  const out: MutationId[] = [];
  const chance = gloom ? 0.18 : 0.06;
  if (rng.chance(chance)) {
    const bad = rng.chance(gloom ? 0.55 : 0.25);
    out.push(bad ? rng.pick(BAD_MUTS) : rng.pick(GOOD_MUTS));
  }
  return out;
}

export function skillsForLevel(speciesId: string, level: number): string[] {
  const sp = SPECIES[speciesId];
  return sp.learnset.filter(([lv]) => lv <= level).map(([, s]) => s).slice(-5);
}

export function xpToNext(level: number): number {
  return Math.round(18 * Math.pow(level, 1.55));
}

export function newUid(state: GameState): string {
  state.uidSeq += 1;
  return `m${state.uidSeq.toString(36)}`;
}

export function createMonster(
  state: GameState,
  speciesId: string,
  level: number,
  opts: {
    genes?: Genome;
    personality?: PersonalityId;
    mutations?: MutationId[];
    origin: string;
    seed: number;
    parents?: string[] | null;
    parentNames?: string[];
    plus?: number;
    sex?: Sex;
    skills?: string[];
    generation?: number;
    lineageId?: string;
    mutHistory?: MutationRecord[];
    /** Life stage at creation: "mature" (default — starters, tamed adults) or "newborn" (bred offspring). */
    stage?: "mature" | "newborn";
    /** Inherited signature technique(s) delivered with the offspring. */
    sigKnown?: SignatureState[];
  },
): Monster {
  const rng = new Rng(opts.seed);
  const genes = opts.genes ?? rollGenes(rng, 0, speciesId);
  const personality = opts.personality ?? rollPersonality(rng);
  const mutations = opts.mutations ?? rollMutations(rng, false);
  const sex = opts.sex ?? rollSex(rng, speciesId);
  const skills = opts.skills ?? skillsForLevel(speciesId, level);
  const mon: Monster = {
    uid: newUid(state),
    speciesId,
    nickname: null,
    level,
    xp: 0,
    hp: 1,
    genes,
    mutations,
    personality,
    sex,
    skills,
    satiety: 80,
    bond: 20,
    plus: opts.plus ?? 0,
    origin: opts.origin,
    // bred offspring start life as newborns; everything else enters as a young adult
    bornTick: opts.stage === "newborn" ? state.tick : state.tick - matureAgeOf(speciesId) - 1,
    parents: opts.parents ?? null,
    parentNames: opts.parentNames,
    generation: opts.generation ?? 1,
    lineageId: opts.lineageId ?? founderLineage("pending"),
    mutHistory: opts.mutHistory ?? [],
    repro: makeReproProfile(sex, level, state.tick),
    wins: 0,
  };
  if (!opts.lineageId) mon.lineageId = founderLineage(mon.uid);
  if (opts.sigKnown?.length) {
    mon.sigKnown = opts.sigKnown;
    for (const s of opts.sigKnown) if (!mon.skills.includes(s.uid)) mon.skills.push(s.uid);
  }
  mon.hp = statOf(mon, "hp");
  return mon;
}

/**
 * A monster's stat. `tick` opts into growth scaling (the young are frail,
 * elders wane); without it the mature value is returned — the historical
 * behavior every legacy call site expects.
 */
export function statOf(mon: Monster, key: StatKey, tick?: number): number {
  const sp = SPECIES[mon.speciesId];
  const base = sp.base[key];
  const grown = base * (1 + (mon.level - 1) * GROWTH[key]);
  const gene = 0.82 + (expressGene(mon.genes[GENE_FOR[key]]) / 100) * 0.36;
  const size = sizeStatMul(key, expressGene(mon.genes.size));
  let mod = PERSONALITIES[mon.personality].mods[key] ?? 1;
  for (const m of mon.mutations) mod *= MUTATIONS[m].mods[key] ?? 1;
  const plus = 1 + mon.plus * 0.05;
  const hungry = key !== "hp" && mon.satiety < 15 ? 0.88 : 1;
  const growth = tick !== undefined ? growthStatMul(growthOf(mon.bornTick, mon.speciesId, tick), key) : 1;
  return Math.max(1, Math.round(grown * gene * size * mod * plus * hungry * growth));
}

export function statsOf(mon: Monster): Stats {
  return { hp: statOf(mon, "hp"), atk: statOf(mon, "atk"), def: statOf(mon, "def"), agi: statOf(mon, "agi"), wis: statOf(mon, "wis") };
}

export function displayName(mon: Monster): string {
  return mon.nickname ?? SPECIES[mon.speciesId].name;
}

/** Grants XP; returns lines describing level-ups and newly learned skills. */
export function grantXp(mon: Monster, amount: number): string[] {
  const lines: string[] = [];
  mon.xp += amount;
  while (mon.xp >= xpToNext(mon.level) && mon.level < 50) {
    mon.xp -= xpToNext(mon.level);
    const before = statOf(mon, "hp");
    mon.level += 1;
    const after = statOf(mon, "hp");
    mon.hp = Math.min(after, mon.hp + (after - before));
    lines.push(`${displayName(mon)} grew to level ${mon.level}!`);
    // the signature technique announces that it is ready to deepen
    if (mon.sig && sigEvolutionReady(mon.sig, mon.level)) lines.push(`${displayName(mon)}'s ${mon.sig.name} stirs — it can evolve!`);
    for (const [lv, skill] of SPECIES[mon.speciesId].learnset) {
      if (lv === mon.level && !mon.skills.includes(skill)) {
        mon.skills.push(skill);
        if (mon.skills.length > 6) {
          // signature techniques are permanent: forget something else first
          const keep = new Set<string>([...(mon.sig ? [mon.sig.baseId] : []), ...(mon.sigKnown ?? []).map((s) => s.uid)]);
          const idx = mon.skills.findIndex((s) => !keep.has(s));
          if (idx >= 0) mon.skills.splice(idx, 1);
        }
        lines.push(`${displayName(mon)} learned ${SKILLS[skill].name}.`);
      }
    }
  }
  return lines;
}

/** Backfills sex for pre-v8 saves, deterministically from the monster's uid. */
export function migrateMonsterSex(m: Monster): void {
  if (!m.sex) m.sex = rollSex(new Rng(hashString(m.uid) ^ 0x53e0), m.speciesId);
}

