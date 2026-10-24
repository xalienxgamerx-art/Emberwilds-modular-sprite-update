import { initField } from "./combat";
import { migrateBreeding } from "./breeding";
import { migrateBiology, migrateMonsterGenes } from "./genetics";
import { migrateMonsterSex } from "./monster";
import { migrateRepro } from "./reproduction";
import { migrateTerritories } from "./territory";
import { migrateHeight } from "./height";
import { migrateGrowth } from "./growth";
import { migrateEcology } from "./ecology";
import { migrateLineages } from "./lineage";
import { migrateDistant } from "./distant";
import { migrateCarrion } from "./carrion";
import { migrateEggs } from "./eggs";
import { initTamers } from "./tamers";
import { ensureRosterLooks, generateLook, resolveLook } from "./appearance";
import { emptyRep } from "./reputation";
import { getWorld } from "./world";
import { migrateFactionKnowledge } from "./factions";
import { ensureKnowledge } from "./knowledge";
import { migrateWildXp, migratePersistence, SAVE_VERSION, loadChunks } from "./sim";
import type { GameState } from "./types";
import { hash2 } from "./rng";

/**
 * Save migration — the versioned pipeline every loaded save passes through,
 * extracted from the store so it can be exercised headlessly (mapcheck and
 * unit tests run the exact code the game runs).
 *
 * Architecture, unchanged from the store:
 *  - one chain of guarded steps, oldest version first;
 *  - every recent step is idempotent and re-runs on every load, so a save
 *    written by an older build upgrades in one pass and stays stable;
 *  - generated world data (settlements, roads, NPCs, associations) is never
 *    persisted — it is a pure function of `gs.seed` and is rebuilt on load.
 *
 * Phase 8 additions:
 *  - a malformed save (wrong shape, missing seed/player) is refused with a
 *    diagnostic instead of half-loading into a broken state;
 *  - a save from a NEWER game version is refused — silently downgrading it
 *    would invent missing state and then overwrite the real save.
 */

/** Minimal shape a save must have before any migration step may touch it. */
function looksLikeSave(gs: unknown): gs is GameState {
  if (typeof gs !== "object" || gs === null) return false;
  const g = gs as Record<string, unknown>;
  return typeof g.version === "number" && typeof g.seed === "number" && typeof g.seedText === "string" && typeof g.player === "object" && g.player !== null;
}

/**
 * Migrate a parsed save to the current version in place. Returns false when
 * the save is malformed or from an unsupported (newer) version — the caller
 * must not stage or overwrite anything in that case. Safe to call on an
 * already-current save: every idempotent step runs, nothing changes.
 */
export function migrateLoaded(gs: GameState): boolean {
  if (!looksLikeSave(gs)) {
    console.warn(`[emberwild] save rejected: not a game save (missing version, seed or player record)`);
    return false;
  }
  if (gs.version > SAVE_VERSION) {
    console.warn(`[emberwild] save rejected: version ${gs.version} is newer than this build (${SAVE_VERSION})`);
    return false;
  }
  if (gs.version <= 4) {
    if (gs.version === 3) ensureKnowledge(gs, true);
    // v3/v4 → v5: live combat — party field positions, orders, overlays
    gs.field = gs.field ?? {};
    gs.orders = gs.orders ?? {};
    gs.target = gs.target ?? null;
    gs.ground = gs.ground ?? {};
    gs.fighters = gs.fighters ?? {};
    initField(gs);
  }
  // v5 → v6: commanded skills and per-monster aggression
  gs.aggr = gs.aggr ?? {};
  gs.skillQ = gs.skillQ ?? {};
  // tracking marks (any version)
  gs.tracked = gs.tracked ?? null;
  gs.trackedHint = gs.trackedHint ?? 0;
  // v6 → v7: allele-pair genomes (adds the genetic size gene)
  if (gs.version <= 6) for (const m of [...gs.party, ...gs.pen]) migrateMonsterGenes(m);
  // v7 → v8: monsters gain a sex
  if (gs.version <= 7) for (const m of [...gs.party, ...gs.pen]) migrateMonsterSex(m);
  // v8 → v9: loaded chunks respawn, so lairs field their packs
  if (gs.version <= 8) gs.loadedChunks = [];
  // v9 → v10: faction knowledge records, home banner resolved
  if (gs.version <= 9) migrateFactionKnowledge(gs);
  // v11 biology: lineage metadata + explicit wild genotypes — idempotent, runs on every load
  migrateBiology(gs);
  // v12 reproduction: reproductive profiles — idempotent, runs on every load
  migrateRepro(gs);
  // v13 breeding: nests and reproductive developments — idempotent, runs on every load
  migrateBreeding(gs);
  // v14 territories: persistent ecological home ranges — idempotent, runs on every load
  migrateTerritories(gs);
  // v15 height: terraces, cliffs and cave layers — positions re-validated, idempotent, runs on every load
  if (migrateHeight(gs, getWorld(gs.seed))) initField(gs);
  // v16 growth & ecology: lifecycle stages backdated, ecology state created — idempotent, runs on every load
  migrateGrowth(gs);
  migrateEcology(gs);
  // v17 lineages: persistent ancestry records — idempotent, runs on every load
  migrateLineages(gs);
  // v18 distant worlds: abstract population state — idempotent, runs on every load
  migrateDistant(gs);
  // v19 food web: carrion state — idempotent, runs on every load
  migrateCarrion(gs);
  // v22 carried eggs: stolen eggs ride in the pack with their bloodline — idempotent, runs on every load
  migrateEggs(gs);
  // v20 wild experience: banked fight xp — idempotent, runs on every load
  migrateWildXp(gs);
  // v21 persistence: monsters the player has met stay real individuals — idempotent, runs on every load
  migratePersistence(gs);
  // v23 rival tamers: the seed-drawn roster, career events, rumor state and
  // reputation ledgers; v24 adds each rival's persistent look — idempotent, runs on every load
  migrateTamers(gs);
  // v25 player appearance: the player gains a modular look (rolled from the
  // world seed when absent, repaired when damaged) — idempotent, runs on every load
  migratePlayerLook(gs);
  gs.version = SAVE_VERSION;
  return true;
}

/**
 * v23: persistent rival tamers, reputation and rumors. Older saves gain the
 * seed-drawn roster and empty ledgers without touching any player progress;
 * v23 saves re-run the backfills harmlessly.
 */
export function migrateTamers(gs: GameState): void {
  if (!gs.tamers) initTamers(gs);
  gs.tamerSeq = gs.tamerSeq ?? Object.keys(gs.tamers ?? {}).length;
  gs.events = gs.events ?? [];
  gs.eventSeq = gs.eventSeq ?? 0;
  gs.rumorBoard = gs.rumorBoard ?? {};
  gs.rumorQ = gs.rumorQ ?? [];
  gs.rep = gs.rep ?? emptyRep();
  gs.repApplied = gs.repApplied ?? {};
  gs.metTamers = gs.metTamers ?? {};
  gs.grudges = gs.grudges ?? {};
  // v24 appearance: every rival gains a persistent modular look; damaged looks
  // are repaired, valid ones never change — idempotent
  if (gs.tamers) ensureRosterLooks(gs.seed, gs.tamers);
}

/**
 * v25: the player's modular look. Old saves never had one — roll it from the
 * world seed so the same save always gets the same appearance; existing looks
 * are repaired field by field, never redesigned. Idempotent.
 */
export function migratePlayerLook(gs: GameState): void {
  if (!gs.player) return;
  if (gs.player.look === undefined || gs.player.look === null) {
    gs.player.look = generateLook(hash2(gs.seed, 0x701a, 0x51d) >>> 0);
    return;
  }
  const { look, ok } = resolveLook(gs.player.look);
  if (!ok) gs.player.look = look;
}

/** Chunk reload after a successful migration (kept next to the pipeline for symmetry with the old loadSave). */
export function afterMigrate(gs: GameState): void {
  loadChunks(gs);
}
