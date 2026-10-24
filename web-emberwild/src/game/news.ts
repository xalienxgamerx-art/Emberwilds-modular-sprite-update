import { BIOMES, DAY_TICKS, SPECIES, SPECIES_LIST } from "./data";
import { getFactions } from "./factions";
import { repLabel, repOf } from "./reputation";
import { hash2 } from "./rng";
import { boardOf, eventOf, ageDays, nearestSettlement, setKey } from "./rumors";
import { roadNetworkOf } from "./roads";
import { isSettlement, settlementSeed, settlementTier } from "./settlement";
import type { Feature, Npc } from "./world";
import { getWorld } from "./world";
import type { GameState, RumorMemory, Territory, WildCreature, WorldEvent } from "./types";

/**
 * The local news layer — a small semantic query layer between the living
 * world and NPC dialogue. Residents and recruiters never embed world logic
 * into strings: they ask the queries below what is nearby and phrase the
 * answer. Any future NPC (travelers, chapter officers, caravans) can reuse
 * the same queries.
 *
 * Monster reports follow a strict information hierarchy, first source wins:
 *
 *   1. nearby active creatures   (what is actually out there now)
 *   2. nearby monster territories (claimed home ranges)
 *   3. nearby monster lairs       (landmarks on the map)
 *   4. regional monster ecology   (what the land supports)
 *   5. biome fallback             (the land itself)
 *
 * Every answer is spatially *vague* — compass bearings and rough reaches,
 * never coordinates. Exploration, the map and the territory system stay the
 * player's own tools.
 */

/** How far (chebyshev) a resident's knowledge of the land around town reaches. */
const EARSHOT = 56;
const SMALL_TALK = 18;
const FAR_TALK = 40;

const BEARINGS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** The compass bearing of a tile as folk would give it: "north-east of here". */
export function bearingOf(fromX: number, fromY: number, x: number, y: number): string {
  const ang = (Math.atan2(y - fromY, x - fromX) / (Math.PI * 2) + 1.125) % 1;
  return BEARINGS[Math.floor(ang * 8) % 8];
}

/** Vague reach, the way a local sizes distance: none of your map coordinates. */
function reach(d: number): string {
  return d <= SMALL_TALK ? "close" : d <= FAR_TALK ? "a walk out" : "far out";
}

/** A species name folk actually say. */
function speciesName(speciesId: string): string {
  return SPECIES[speciesId]?.name ?? SPECIES_LIST.find((s) => s.id === speciesId)?.name ?? "beast";
}

/* ------------------------------ query layer ------------------------------ */

export interface BeastSighting {
  kind: "creature" | "territory" | "lair" | "regional";
  speciesId: string | null;
  dir: string;
  /** Rough chebyshev distance, for the reach phrasing — never shown raw. */
  dist: number;
  /** True when the source is bad news: a stalker, a predator's claim, a lair. */
  danger: boolean;
}

/** Active wild bodies near a spot — live ecological truth, tier 1. */
export function nearbyCreatures(gs: GameState, x: number, y: number, radius = EARSHOT): BeastSighting[] {
  const out: BeastSighting[] = [];
  for (const c of Object.values(gs.creatures) as WildCreature[]) {
    const d = Math.max(Math.abs(c.x - x), Math.abs(c.y - y));
    if (d > radius || d === 0) continue;
    if (c.layer !== undefined && c.layer < 0) continue;
    out.push({ kind: "creature", speciesId: c.speciesId, dir: bearingOf(x, y, c.x, c.y), dist: d, danger: c.stalking || c.disposition === "aggressive" });
  }
  return out;
}

/** Founded territories near a spot — the persistent populations, tier 2. */
export function nearbyTerritories(gs: GameState, x: number, y: number, radius = EARSHOT): BeastSighting[] {
  const out: BeastSighting[] = [];
  for (const t of Object.values(gs.territories) as Territory[]) {
    if (t.layer !== undefined && t.layer < 0) continue;
    const d = Math.max(Math.abs(t.x - x), Math.abs(t.y - y));
    if (d > radius || d === 0) continue;
    out.push({ kind: "territory", speciesId: t.speciesId, dir: bearingOf(x, y, t.x, t.y), dist: d, danger: true });
  }
  return out;
}

/** Monster lairs near a spot — the map's fixed danger marks, tier 3. */
export function nearbyLairs(world: ReturnType<typeof getWorld>, x: number, y: number, radius = EARSHOT): BeastSighting[] {
  return world
    .featuresNear(x, y, radius)
    .filter((f) => f.kind === "lair")
    .map((f) => ({ kind: "lair" as const, speciesId: f.speciesId, dir: bearingOf(x, y, f.x, f.y), dist: Math.max(Math.abs(f.x - x), Math.abs(f.y - y)), danger: true }));
}

/** Other settlements near a spot. */
export function nearbySettlements(world: ReturnType<typeof getWorld>, x: number, y: number, radius = EARSHOT * 2): Feature[] {
  return world.featuresNear(x, y, radius).filter((f) => isSettlement(f));
}

/** Landmarks near a spot: shrines and ruins worth a mention. */
export function nearbyLandmarks(world: ReturnType<typeof getWorld>, x: number, y: number, radius = EARSHOT): Feature[] {
  return world.featuresNear(x, y, radius).filter((f) => f.kind === "shrine" || f.kind === "ruin");
}

/**
 * Roads and traffic near a spot — the honest word of the national network.
 * A resident knows which roads pass within earshot of town, which way they
 * set out, and how far the next paving stone of a place is — never anything
 * about what stands along the route they have not themselves seen. Returns
 * ready-to-say phrases, spatially vague by construction.
 */
export function nearbyRoadActivity(world: ReturnType<typeof getWorld>, x: number, y: number, radius = EARSHOT): string[] {
  const net = roadNetworkOf(world);
  const out: string[] = [];
  for (const r of net.roads) {
    if (r.status !== "built" || !r.route || !r.route.length) continue;
    const a = net.byId.get(r.a);
    const b = net.byId.get(r.b);
    if (!a || !b) continue;
    // does this road pass within earshot of here?
    let near = false;
    for (let i = 0; i < r.route.length; i += 4) {
      const p = r.route[i];
      if (Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) <= radius) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    // speak of the far end that is NOT here: the place the road leads to
    const here = Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) <= Math.max(Math.abs(b.x - x), Math.abs(b.y - y)) ? a : b;
    const dest = here === a ? b : a;
    const mid = r.route[Math.floor(r.route.length / 2)];
    const clsName = r.cls === "major" ? "highway" : r.cls === "regional" ? "wagon road" : "track";
    out.push(`The ${clsName} runs ${bearingOf(x, y, mid.x, mid.y)} of here — ${dest.tier === "city" ? "the city" : dest.tier === "town" ? "the town" : "the hamlet"} of ${world.tile(dest.x, dest.y).feature?.name ?? "out that way"}, ${reach(Math.max(Math.abs(dest.x - x), Math.abs(dest.y - y)))}.`);
  }
  return out;
}

/** The full monster picture for one spot, in report priority order. */
export function monsterReport(gs: GameState, x: number, y: number): BeastSighting[] {
  const world = getWorld(gs.seed);
  const live = nearbyCreatures(gs, x, y);
  if (live.length) return live;
  const terrs = nearbyTerritories(gs, x, y);
  if (terrs.length) return terrs;
  const lairs = nearbyLairs(world, x, y);
  if (lairs.length) return lairs;
  // regional ecology: a species this land genuinely supports, nothing closer
  const here = world.tile(x, y);
  const h = hash2(gs.seed ^ 0x6e05, x, y);
  const sp = world.pickSpecies(here.biome, h);
  if (sp) return [{ kind: "regional", speciesId: sp, dir: bearingOf(x, y, x + 12, y - 7), dist: FAR_TALK, danger: false }];
  return [];
}

/* ------------------------------ rumor dialogue ----------------------------- */

/** How a story of a given confidence is introduced — hearsay stays hearsay. */
function provenance(conf: number): string {
  return conf > 0.8 ? "It's the honest truth:" : conf > 0.5 ? "Travelers say" : "Some drunks swear";
}

/** An old story is told as an old story. */
function ageLead(gs: GameState, mem: RumorMemory): string {
  const days = ageDays(gs, mem);
  return days >= 6 ? "An old story, that one — " : days >= 2 ? "Word from a few days back — " : "";
}

/** Phrases one rumor the way a local would tell it — vague, sourced, honest about doubt. */
export function phraseRumor(gs: GameState, e: WorldEvent, mem: RumorMemory): string {
  const lead = ageLead(gs, mem);
  const src = provenance(mem.confidence);
  if (e.cat === "duel") {
    const win = e.won ? e.subjectName : e.otherName;
    const lose = e.won ? e.otherName : e.subjectName;
    return `${lead}${src} ${win} beat ${lose} in a tamer's duel, out ${bearingOf(Number(keyParts(e).sx), Number(keyParts(e).sy), e.x, e.y)} of here.`;
  }
  const name = e.alphaSpeciesId ? speciesName(e.alphaSpeciesId).toLowerCase() : "beast";
  if (e.cat === "alpha_kill" && e.won) {
    return `${lead}${src} ${e.subjectName} brought down the great ${name} ${bearingOf(Number(keyParts(e).sx), Number(keyParts(e).sy), e.x, e.y)} of here. A big beast, that one.`;
  }
  return `${lead}${src} ${e.subjectName} went after the great ${name} out ${bearingOf(Number(keyParts(e).sx), Number(keyParts(e).sy), e.x, e.y)} of here — and came back beaten.`;
}

function keyParts(e: WorldEvent): { sx: number; sy: number } {
  return { sx: e.x, sy: e.y };
}

/**
 * The rumors one settlement's board holds — what a local could have heard.
 * Rotation is deterministic per talk seed and slot, so the same resident
 * doesn't tell one story forever.
 */
export function rumorLines(gs: GameState, key: string, h: number, limit = 1): string[] {
  const mems = boardOf(gs, key);
  if (!mems.length) return [];
  const out: string[] = [];
  for (let i = 0; i < mems.length && out.length < limit; i++) {
    const mem = mems[(h + i * 7) % mems.length];
    const e = eventOf(gs, mem);
    if (!e) continue;
    out.push(phraseRumor(gs, e, mem));
  }
  return out;
}

/**
 * The player's own standing in a settlement, as a line a local might say —
 * only when the player's name actually means something here.
 */
function recognitionLine(gs: GameState, npc: Npc): string | null {
  const rep = repOf(gs, "player", "settlements", setKey(npc.x, npc.y));
  if (rep === null || (rep < 5 && rep > -5)) return null;
  const band = repLabel(rep);
  return rep > 0
    ? `You're ${band} in ${npc.settlement} — folk know your name and your beasts'.`
    : `They say you're ${band} in ${npc.settlement}. Folk watch their beasts when you pass.`;
}

/* -------------------------------- dialogue -------------------------------- */

const dayOf = (tick: number): number => Math.floor(tick / DAY_TICKS);

/** Deterministic talk seed: who is speaking, where, and on what day. */
function talkSeed(gs: GameState, npc: Npc, slot: number): number {
  return hash2(settlementSeed(gs.seed, { x: npc.x, y: npc.y }) ^ 0x4e35, dayOf(gs.tick) * 7 + slot, npc.name.length * 31 + npc.x + npc.y);
}

const DANGEROUS_BIOMES: Partial<Record<string, string>> = { gloomwood: "gloomwood", marsh: "marsh", mountain: "highlands", snow: "the deep snows", desert: "the sands", tundra: "the fells" };

/**
 * What a wandering resident says when stopped for a chat: one piece of real
 * local news (monsters first — that is what folk warn each other about),
 * then a line of small talk rooted in the same world state. Deterministic
 * per day: the same resident gives the same news all day.
 */
export function residentLines(gs: GameState, npc: Npc): string[] {
  const world = getWorld(gs.seed);
  const day = dayOf(gs.tick);
  const h = talkSeed(gs, npc, 0);
  const lines: string[] = [];

  // --- career rumors: what this settlement has actually heard, when it has ---
  const rumors = rumorLines(gs, setKey(npc.x, npc.y), h);
  if (rumors.length && h % 3 !== 0) {
    lines.push(rumors[0]);
  } else {
    pushMonsterNews(gs, world, npc, h, lines);
  }

  // --- being known: a name that means something here gets said ---
  const known = recognitionLine(gs, npc);
  if (known && h % 2 === 0) lines.push(known);

  // keep it to two lines a day — residents have other things to do
  return lines.slice(0, 2);
}

/** The old monster-news hierarchy, extracted so rumor news can preempt it. */
function pushMonsterNews(gs: GameState, world: ReturnType<typeof getWorld>, npc: Npc, h: number, lines: string[]): void {
  const beasts = monsterReport(gs, npc.x, npc.y);
  if (beasts.length) {
    const b = beasts[h % beasts.length];
    const name = b.speciesId ? speciesName(b.speciesId) : "beasts";
    if (b.kind === "creature" || b.kind === "territory") {
      lines.push(
        b.danger
          ? `There have been beasts prowling ${b.dir} of town — ${name}, folk think. Keep your own close at dusk.`
          : `Someone's ${name.toLowerCase()} has been seen ${b.dir} of here, ${reach(b.dist)}. Lost, most like.`,
      );
    } else if (b.kind === "lair") {
      lines.push(`Travelers say something large has been seen along the ${b.dir} side — they blame the ${name.toLowerCase()}. ${b.dist <= SMALL_TALK ? "Too close for my taste." : "Far, but far is not forever."}`);
    } else {
      lines.push(`The land ${b.dir} of here hums with ${name.toLowerCase()}s this season. Nothing a tamer like you'd fret over.`);
    }
  } else {
    const here = world.tile(npc.x, npc.y);
    lines.push(`Quiet, for once. Even the ${BIOMES[here.biome].noun.toLowerCase()} around ${npc.settlement} seems to be resting.`);
  }

  // --- nearby places, when there are any worth naming ---
  const places = [...nearbySettlements(world, npc.x, npc.y).filter((f) => f.x !== npc.x || f.y !== npc.y), ...nearbyLandmarks(world, npc.x, npc.y)];
  if (places.length) {
    const f = places[(h >>> 5) % places.length];
    const d = Math.max(Math.abs(f.x - npc.x), Math.abs(f.y - npc.y));
    const what = isSettlement(f) ? f.name : f.kind === "shrine" ? `the ${f.name} stones` : `the ruins at ${f.name}`;
    lines.push(`${isSettlement(f) ? "Folk from" : "There's"} ${what} — ${bearingOf(npc.x, npc.y, f.x, f.y)} of here, ${reach(d)}.`);
  }

  // --- the roads: cart traffic and where it goes, when a road passes nearby ---
  const roads = nearbyRoadActivity(world, npc.x, npc.y);
  if (roads.length) lines.push(roads[(h >>> 9) % roads.length]);

  // --- the political weather: whose banners these are ---
  const fac = getFactions(gs.seed);
  const nation = fac.nationAt(npc.x, npc.y);
  if (nation) lines.push(`These lands answer to the ${nation.title}, same as they have since my gran's gran.`);

  // --- dangerous country, when the land itself is the warning ---
  const probe = 12;
  const here = world.tile(npc.x + probe, npc.y);
  const rough = DANGEROUS_BIOMES[here.biome];
  if (rough) lines.push(`The ${rough} ${bearingOf(npc.x, npc.y, npc.x + probe, npc.y)} of here are dangerous lately. Folk went, folk came back shorter on sense.`);
}

/**
 * What a traveler on the road says: where the road goes from here, and one
 * piece of real news from the stretch they are walking (same monster
 * hierarchy as a resident — they pass the same country).
 */
export function travelerLines(gs: GameState, npc: Npc): string[] {
  const world = getWorld(gs.seed);
  const lines: string[] = [];
  const h = talkSeed(gs, npc, 0);
  if (npc.boundFor && npc.settlement) {
    lines.push(`Bound for ${npc.boundFor}, same as ever. Set out from ${npc.settlement} this morning — the road knows me better than my own kitchen.`);
  } else if (npc.boundFor) {
    lines.push(`Bound for ${npc.boundFor}. The road's long, but it's honest.`);
  }
  const beasts = monsterReport(gs, npc.x, npc.y);
  if (beasts.length) {
    const b = beasts[h % beasts.length];
    const name = b.speciesId ? speciesName(b.speciesId) : "beasts";
    lines.push(
      b.danger
        ? `Walk wary ${b.dir} of the road — something's been marking its ground out that way, ${name}, folk think.`
        : `Passed a ${name.toLowerCase()} ${b.dir} of the road, ${reach(b.dist)} back. Paid me no mind.`,
    );
  }
  // travelers are the network: they repeat what the settlements they pass know
  const near = nearestSettlementOf(gs, npc.x, npc.y);
  if (near) {
    const r = rumorLines(gs, near, h >>> 2, 1);
    if (r.length && h % 2 === 0) lines.push(r[0]);
  }
  if (!lines.length) lines.push(npc.line);
  return lines;
}

/**
 * What the association recruiter on the green says: the pitch, the way to the
 * chapter hall, and a notice from that association's board. A hamlet recruiter
 * never claims to be a chapter — they point at one.
 */
export function recruiterLines(gs: GameState, npc: Npc): string[] {
  const h = talkSeed(gs, npc, 1);
  const fac = getFactions(gs.seed);
  const nation = fac.nationAt(npc.x, npc.y);
  const assoc = nation && nation.associations.length ? nation.associations[(npc.assocSlot ?? 0) % nation.associations.length] : null;
  const lines: string[] = [];
  if (!assoc) {
    lines.push("The associations have charters in the greater towns, not here — but every tamer's name starts as a stranger's. Make one worth writing down.");
    return lines;
  }
  lines.push(`The ${assoc.name} trains tamers and keeps the trade honest. Any beast of spirit deserves a tamer of the same — membership is earned, not bought.`);
  const ch = assoc.chapter;
  const d = Math.max(Math.abs(ch.x - npc.x), Math.abs(ch.y - npc.y));
  lines.push(`Our chapter hall stands in ${ch.name}, ${bearingOf(npc.x, npc.y, ch.x, ch.y)} of here — ${reach(d)} walk for a fit tamer. Tell them ${npc.settlement} sent you.`);
  // the association's own channel: word its couriers carried to the chapter
  const chKey = setKey(ch.x, ch.y);
  const own = boardOf(gs, chKey)
    .map((m) => ({ m, e: eventOf(gs, m) }))
    .filter((x) => x.e && x.e.assocId === assoc.id);
  if (own.length) {
    const pick = own[h % own.length];
    lines.push(`The chapter's couriers have it straight: ${phraseRumor(gs, pick.e!, pick.m)}`);
  }
  // standing: an association that knows your name says so
  const arep = repOf(gs, "player", "assocs", assoc.id);
  if (arep !== null && Math.abs(arep) >= 5) lines.push(arep > 0 ? `The ${assoc.name} counts you ${repLabel(arep)} — your file is in good order.` : `The ${assoc.name} has you down as ${repLabel(arep)}. Files remember.`);
  const notice = fac.settlementNotices(ch).find((n) => n.assoc.id === assoc.id);
  if (notice) lines.push(`Fresh off the chapter board: “${notice.text}”`);
  return lines;
}

/** The settlement board a speaker could plausibly have heard (nearest green). */
function nearestSettlementOf(gs: GameState, x: number, y: number): string | null {
  const near = nearestSettlement(getWorld(gs.seed), x, y, 60);
  return near?.key ?? null;
}
