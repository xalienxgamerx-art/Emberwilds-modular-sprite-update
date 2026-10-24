/**
 * Lineage (Phase 10) — persistent, bounded ancestry bookkeeping on top of the
 * authoritative genetics.
 *
 * Lineage identity describes ancestry and is deliberately separate from
 * species identity (which describes biology) and from individual ids. Records
 * are event-fed at birth/death through the breeding and ecology pipelines and
 * rebuilt idempotently on load, so ancestry outlives the bodies that carried
 * it while no query ever scans unbounded history: parents come from the body,
 * children from a capped persistent index, and lineage facts from the record.
 *
 * Nothing here changes inheritance, mutation, or species determination — those
 * remain the exclusive business of genetics.ts and breeding.ts.
 */
import { expressGenome, founderLineage } from "./genetics";
import type { GameState, Genes, LineageRecord, Monster, MutationRecord, WildCreature } from "./types";

/** Member sample kept per lineage record (bounded). */
export const LINEAGE_MEMBER_CAP = 32;
/** Notable mutation records kept per lineage (bounded). */
export const LINEAGE_MUTATION_CAP = 16;
/** Children remembered per parent (bounded; newest kept). */
export const CHILD_INDEX_CAP = 24;

type Body = Monster | WildCreature;

const bodyId = (b: Body): string => ("uid" in b ? b.uid : b.id);

/** A body's lineage id, falling back to founder status for legacy bodies. */
export const lineageIdOf = (b: Body): string => b.lineageId ?? founderLineage(bodyId(b));

/** Generation number (founders and legacy bodies are generation 1). */
export const generationOf = (b: Body): number => (b as Monster).generation ?? (b as WildCreature).gen ?? 1;

/** Direct parents, when recorded (wild founders and pre-lineage saves have none). */
export function parentsOf(b: Body): string[] {
  const p = (b as Monster).parents;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
}

function recordOf(gs: GameState, id: string, speciesId: string, tick: number): LineageRecord {
  gs.lineages ??= {};
  let r = gs.lineages[id];
  if (!r) {
    r = { id, speciesId, foundedTick: tick, depth: 1, living: 0, historical: 0, peakGenes: {} as Genes, notable: [], members: [] };
    gs.lineages[id] = r;
  }
  return r;
}

function noteGenes(rec: LineageRecord, genes: Genes | undefined): void {
  if (!genes) return;
  for (const k of Object.keys(genes) as (keyof Genes)[]) {
    rec.peakGenes[k] = Math.max(rec.peakGenes[k] ?? 0, genes[k]);
  }
}

function noteMutations(rec: LineageRecord, history: MutationRecord[] | undefined): void {
  if (!history?.length) return;
  for (const m of history) {
    if (rec.notable.some((n) => n.gene === m.gene && n.gen === m.gen && n.from === m.from && n.to === m.to)) continue;
    rec.notable.push(m);
  }
  if (rec.notable.length > LINEAGE_MUTATION_CAP) rec.notable.splice(0, rec.notable.length - LINEAGE_MUTATION_CAP);
}

/**
 * A body entered the world through the breeding pipeline. Event-fed exactly
 * once per birth (deliverOffspring records only on completion), it updates the
 * lineage record and the parent → child index.
 */
export function recordLineageBirth(gs: GameState, b: Body, parents?: string[]): void {
  const rec = recordOf(gs, lineageIdOf(b), b.speciesId, gs.tick);
  const id = bodyId(b);
  rec.living++;
  rec.historical++;
  rec.depth = Math.max(rec.depth, generationOf(b));
  noteGenes(rec, b.genes ? expressGenome(b.genes) : undefined);
  noteMutations(rec, (b as Monster).mutHistory);
  rec.members.push(id);
  if (rec.members.length > LINEAGE_MEMBER_CAP) rec.members.splice(0, rec.members.length - LINEAGE_MEMBER_CAP);
  if (parents?.length) {
    gs.childIndex ??= {};
    for (const p of parents) {
      const kids = gs.childIndex[p] ?? (gs.childIndex[p] = []);
      if (!kids.includes(id)) kids.push(id);
      if (kids.length > CHILD_INDEX_CAP) kids.splice(0, kids.length - CHILD_INDEX_CAP);
    }
  }
}

/** A wild body died (approximate between loads; records themselves never decay). */
export function recordLineageDeath(gs: GameState, b: Body): void {
  const rec = gs.lineages?.[lineageIdOf(b)];
  if (rec) rec.living = Math.max(0, rec.living - 1);
}

/** Direct offspring of a body id (bounded persistent index; O(1)). */
export function childrenOf(gs: GameState, id: string): string[] {
  return gs.childIndex?.[id] ?? [];
}

/** The lineage record for an id, if any (O(1)). */
export function lineageSummary(gs: GameState, lineageId: string): LineageRecord | null {
  return gs.lineages?.[lineageId] ?? null;
}

/** Relationship between two bodies' ancestries — ids only, no traversal. */
export function relatedness(a: Body, b: Body): "same lineage" | "siblings" | "unrelated" {
  if (lineageIdOf(a) === lineageIdOf(b)) return "same lineage";
  const pa = new Set(parentsOf(a));
  if (parentsOf(b).some((p) => pa.has(p))) return "siblings";
  return "unrelated";
}

/**
 * Idempotent load-time rebuild: creates records for living lineages, recomputes
 * living counts and member samples from the bodies actually present, keeps
 * depth/peakGenes monotonic, and rebuilds the child index. Old saves without
 * any lineage metadata are backfilled as founders by migrateBiology first.
 */
export function migrateLineages(gs: GameState): void {
  gs.lineages ??= {};
  gs.childIndex = {};
  const bodies: Body[] = [...gs.party, ...gs.pen, ...Object.values(gs.creatures)];
  for (const b of bodies) {
    const rec = recordOf(gs, lineageIdOf(b), b.speciesId, gs.tick);
    rec.depth = Math.max(rec.depth, generationOf(b));
    noteGenes(rec, b.genes ? expressGenome(b.genes) : undefined);
  }
  for (const rec of Object.values(gs.lineages)) rec.living = 0;
  for (const b of bodies) recordOf(gs, lineageIdOf(b), b.speciesId, gs.tick).living++;
  for (const rec of Object.values(gs.lineages)) {
    rec.members = bodies
      .filter((b) => lineageIdOf(b) === rec.id)
      .slice(-LINEAGE_MEMBER_CAP)
      .map((b) => bodyId(b));
  }
  for (const b of bodies) {
    const id = bodyId(b);
    for (const p of parentsOf(b)) {
      const kids = gs.childIndex[p] ?? (gs.childIndex[p] = []);
      if (!kids.includes(id)) kids.push(id);
    }
  }
  for (const k of Object.keys(gs.childIndex)) {
    if (gs.childIndex[k].length > CHILD_INDEX_CAP) gs.childIndex[k] = gs.childIndex[k].slice(gs.childIndex[k].length - CHILD_INDEX_CAP);
  }
}
