import type { TamerLook } from "./appearance";
export type Element = "neutral" | "fire" | "water" | "earth" | "air" | "nature" | "frost" | "shadow";
export type StatKey = "hp" | "atk" | "def" | "agi" | "wis";
export type Stats = Record<StatKey, number>;
/** The six heritable genes. `size` drives the monster's tile footprint. */
export type GeneKey = "vigor" | "might" | "guard" | "swift" | "wit" | "size";
/** Expressed gene values (derived from genomes; used by UI and legacy saves). */
export type Genes = Record<GeneKey, number>;
/** Two alleles per gene — the genetic source of truth. */
export interface GenePair {
  a: number;
  b: number;
}
export type Genome = Record<GeneKey, GenePair>;

/** One expressed-gene change caused by genetic drift, as structured data. */
export interface MutationRecord {
  gene: GeneKey;
  from: number;
  to: number;
  delta: number;
  dir: "up" | "down";
  /** Generation at which the mutation occurred. */
  gen: number;
}

export type BiomeId =
  | "deep" | "sea" | "lake" | "river" | "beach" | "meadow" | "forest" | "taiga" | "gloomwood"
  | "marsh" | "steppe" | "desert" | "tundra" | "snow" | "hills" | "mountain" | "peak";

export type FeatureId = "hamlet" | "town" | "city" | "ruin" | "shrine" | "lair";

export type ItemId =
  | "berries" | "nuts" | "roasted_nuts" | "fish" | "meat" | "herb" | "mushroom"
  | "cactus_fruit" | "honeycomb" | "ore" | "tonic" | "egg"
  | "carrot" | "potato" | "tomato" | "onion" | "garlic"
  | "draught" | "greater_tonic" | "antidote" | "firebane" | "brighteye" | "windstep"
  | "warybrew" | "ironbrew";

export type PersonalityId = "brave" | "timid" | "curious" | "lazy" | "gluttonous" | "loyal" | "fierce" | "gentle";
export type MutationId =
  | "thick_hide" | "twin_hearted" | "luminous" | "quickened" | "iron_jaw"
  | "old_soul" | "frail" | "hollow_eyed" | "ember_veins" | "star_marked";
export type TraitId =
  | "warm_blooded" | "slick" | "thorny" | "mossy_shell" | "night_eyes" | "flutter"
  | "stoneskin" | "frost_coat" | "regal" | "photosynth" | "sunborn";
export type StatusId = "burning" | "soaked" | "poisoned" | "slowed" | "rooted" | "stunned" | "blinded" | "shelled" | "wary" | "veiled";
export type Terrain =
  | "grass" | "tallgrass" | "flowers" | "water" | "mud" | "rock" | "tree" | "sand" | "snow" | "ash" | "gloom"
  | "wall" | "woodwall" | "floor" | "door" | "rubble";
export type WeatherId = "clear" | "cloudy" | "rain" | "storm" | "snow" | "fog" | "sandstorm";
export type Disposition = "curious" | "skittish" | "aggressive" | "calm";
export type OriginId = "wanderer" | "herbalist" | "ranger" | "scholar";
export type FearKind = "water" | "fire" | "heat" | "cold" | "dark" | "light";
export type Diet = "herbivore" | "carnivore" | "omnivore" | "lithovore";
export type Activity = "diurnal" | "nocturnal" | "crepuscular";
export type Family = "Beast" | "Slime" | "Bird" | "Bug" | "Spirit" | "Dragon" | "Brute";
export type Rarity = "common" | "uncommon" | "rare" | "legendary";
export type Sex = "male" | "female" | "asexual";

/** Reproductive anatomy: the three biological configurations. */
export type ReproMode = Sex;
/** Life-stage maturity: immature individuals cannot reproduce yet. */
export type Maturity = "immature" | "mature";
/** Where an individual sits in the reproduction cycle. */
export type ReproStatus = "available" | "reproducing" | "cooldown" | "infertile" | "immature";
/** How a compatible pair reproduces: sexed anatomy, or two asexual parents. */
export type ReproPairing = "sexual" | "asexual";
/** Rule environment of a mating attempt: wild pairs obey species boundaries, player pairs are unrestricted. */
export type MatingContext = "wild" | "player";
/** How a species develops after conception: an egg laid in a nest, or live gestation. */
export type DevelopmentType = "egg" | "gestation";
/** Lifecycle of one reproductive development. */
export type DevelopmentState = "developing" | "ready" | "completed" | "interrupted" | "failed";
/** Lifecycle of a nest. */
export type NestState = "active" | "abandoned" | "destroyed";

/**
 * Biological reproduction data for one individual. Mode derives from sex;
 * fertility, maturity, cooldown and status are independent biological state
 * that future systems (growth, health, environment, gestation) can modify.
 */
export interface ReproductiveProfile {
  mode: ReproMode;
  /** 0–100; above 0 the individual is currently fertile. */
  fertility: number;
  maturity: Maturity;
  status: ReproStatus;
  /** Sim tick when the breeding cooldown ends (≤ tick means no cooldown). */
  cooldownUntil: number;
  /** Pairing of the current or most recent reproduction. */
  pairing?: ReproPairing;
  /** Partner body id while a reproduction is underway. */
  engagedWith?: string;
  /** Sim tick when the current reproduction completes development. */
  developUntil?: number;
  /** The female's remembered nest (egg-layers reuse it for every clutch). */
  nestId?: string;
}

export interface Monster {
  uid: string;
  speciesId: string;
  nickname: string | null;
  level: number;
  xp: number;
  hp: number;
  genes: Genome;
  mutations: MutationId[];
  personality: PersonalityId;
  sex: Sex;
  skills: string[];
  satiety: number;
  bond: number;
  plus: number;
  origin: string;
  bornTick: number;
  parents: string[] | null;
  /** Display names captured at synthesis time (parents are consumed on synthesis). */
  parentNames?: string[];
  /** Biological ancestry: founders are generation 1, offspring max(parents) + 1. */
  generation?: number;
  /** Stable ancestry id, independent of display names; founders own `L:<uid>`. */
  lineageId?: string;
  /** Structured drift history: which expressed genes changed, when, and by how much. */
  mutHistory?: MutationRecord[];
  /** Biological reproduction state (backfilled from sex on load for legacy saves). */
  repro?: ReproductiveProfile;
  wins: number;
  /** The monster's own evolving Signature Move (permanent once designated). */
  sig?: SignatureState;
  /** Inherited signature techniques — normal moves, never self-evolving. */
  sigKnown?: SignatureState[];
  /** Placement cap on the growth footprint: the largest class that currently fits (growth.ts). */
  fpCap?: number;
}

export interface WildCreature {
  id: string;
  speciesId: string;
  level: number;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  hpFrac: number;
  satiety: number;
  disposition: Disposition;
  activity: string;
  personality: PersonalityId;
  geneSeed: number;
  /** Explicit genotype — the authoritative genetics (geneSeed only seeds legacy migration). */
  genes?: Genome;
  /** Founder generation (wild creatures are founders unless later systems say otherwise). */
  gen?: number;
  /** Stable lineage id carried into monsters on taming. */
  lineageId?: string;
  /** Biological reproduction state (backfilled from the creature's id on load for legacy saves). */
  repro?: ReproductiveProfile;
  /** The wild body's own evolving Signature Move (developed without player input). */
  sig?: SignatureState;
  /** Inherited signature techniques — normal moves, never self-evolving. */
  sigKnown?: SignatureState[];
  calmUntil: number;
  alpha: boolean;
  affection: number;
  stalking: boolean;
  /** Id of the lair alpha this minion is loyal to (absent for solo creatures). */
  pack?: string;
  /** Direct parent body ids (wild hatchlings; absent for spawned founders and legacy saves). */
  parents?: string[];
  /** Structured mutation history (wild hatchlings; monsters carry it always). */
  mutHistory?: MutationRecord[];
  /** Tick until which migration decisions are suppressed (anti-oscillation; Phase 9). */
  migrateUntil?: number;
  /** Birth tick (hatchlings only; absent = mature adult, the spawned/legacy default). */
  bornTick?: number;
  /** Placement cap on the growth footprint: the largest class that currently fits (growth.ts). */
  fpCap?: number;
  /** The ecological territory this creature recognizes as home (backfilled by migrateTerritories). */
  territoryId?: string;
  /** Banked fight experience (v20+): wild bodies level up as they win fights. */
  xp?: number;
  /** True once the player has genuinely encountered this body — chronicled monsters persist as real individuals forever. */
  known?: boolean;
  /** Vertical layer: absent = surface, -1 upper caves, -2 deep caves. */
  layer?: number;
  /** Tile this hungry body is walking to for a plant it smelled (transient; re-validated each use). */
  seek?: { x: number; y: number } | null;
  /** Attempt attempts since the body last closed distance on its current target (transient; trips a give-up cooldown). */
  stuck?: number;
  /** Tick until which long-range scent seeking is suppressed after repeated dead ends (transient). */
  seekBan?: number;
  /** Ticks until the body will trust carrion scent again (unreachable remains). */
  carrionBan?: number;
  /** Tick until which this body will not take more offered food (the 3h feeding cooldown). */
  feedUntil?: number;
  /** The mate this body is pursuing (transient intent; re-validated every use, stale ids are safe). */
  mateTarget?: string;
  /** Tick until which this body's mating call is on cooldown (deterministic stagger). */
  callUntil?: number;
}

export type LogKind = "info" | "event" | "combat" | "system" | "good" | "bad" | "weather";

export interface LogEntry {
  id: number;
  tick: number;
  text: string;
  kind: LogKind;
}

export interface Player {
  name: string;
  origin: OriginId;
  scarf: string;
  x: number;
  y: number;
  gold: number;
  homeX: number;
  homeY: number;
  homeName: string;
  fx: number;
  fy: number;
  /** Modular appearance (the rivals' system); pre-look saves gain one in migration. */
  look?: TamerLook;
  /** Vertical layer: absent = surface, -1 upper caves, -2 deep caves. The party always shares it. */
  layer?: number;
}

export interface GameStats {
  steps: number;
  battles: number;
  tamed: number;
  synthesized: number;
  foraged: number;
}

/** A landmark the player has explicitly found and can place on their maps. */
export interface Discovery {
  kind: FeatureId;
  name: string;
  x: number;
  y: number;
  tick: number;
}

/**
 * The player's knowledge of the world — deliberately separate from the world
 * itself. The procedural world is authoritative; this is only what the player
 * has seen, visited or been told about, and it persists across save/load.
 */
/** A nest the player has laid eyes on, kept on their maps forever. */
export interface NestMemory {
  x: number;
  y: number;
  speciesId: string;
  tick: number;
  /** Vertical layer the nest sits on (absent = surface). */
  layer?: number;
}

export interface WorldKnowledge {
  /** Explored 8×8-tile cells, key = (cellY << 9) | cellX. */
  explored: Record<number, 1>;
  /** Discovered landmarks, key = `f:x:y`. */
  discovered: Record<string, Discovery>;
  /** 160-tile region cells whose name the player has learned, key = `rx,ry`. */
  regionsSeen: Record<string, 1>;
  /** Nation ids whose banner the player has stood under, key = nation id. */
  nationsSeen: Record<string, 1>;
  /** Association ids the player has learned from notices, key = association id. */
  assocSeen: Record<string, 1>;
  /** Explored cave cells, key = `${layer}:${eCellKey}` (underground knowledge never leaks onto the surface map). */
  caves?: Record<string, 1>;
  /** The player's own traveled trail (breadcrumbs, capped). */
  route: [number, number][];
  /** Nests the player has seen, key = nest id — charted onto their maps forever. */
  nestsSeen?: Record<string, NestMemory>;
  /** Cave mouths the player has seen, key = `x,y` — charted onto their maps forever. */
  mouthsSeen?: Record<string, { x: number; y: number; tick: number }>;
}

export interface BStatus {
  id: StatusId;
  turns: number;
}

/**
 * A Signature Move's accumulated state — fully serializable; behavior is
 * resolved from (baseId, mods) at execution time, so saves replay exactly.
 */
export interface SignatureState {
  /** Castable slot id in the owner's skills array (base id, or `sig:<n>` for inherited copies). */
  uid: string;
  /** The original move this technique grew from. */
  baseId: string;
  /** Current procedurally generated name. */
  name: string;
  /** Accumulated modifier ids, in selection order. */
  mods: string[];
  /** Evolutions applied (generation of the technique). */
  gen: number;
  /** Human-readable evolution history, oldest first. */
  history: string[];
  /** Level of the next evolution milestone. */
  nextLevel: number;
  /** How this body came to own the technique. */
  origin: "chosen" | "wild" | "inherited";
}

/** Where a party monster stands on the live map and what it should do there. */
export type FieldOrder = "follow" | "attack" | "hold";

/** How readily a party monster fights on its own initiative. */
export type Aggression = "passive" | "neutral" | "aggressive";

/** A queued skill command: the monster paths into range, then unleashes it. */
export interface SkillOrder {
  skill: string;
  /** Wild creature id, or a party uid for ally/self skills. Empty for tile orders. */
  target: string;
  /** Ground coordinates for tile-targeted orders (mutually exclusive with target). */
  x?: number | null;
  y?: number | null;
}

/** Per-combatant combat state (statuses and skill cooldowns) on the live map. */
export interface FighterState {
  statuses: BStatus[];
  cooldowns: Record<string, number>;
}

/** Sparse terrain/fire overlay on a world tile, key = "x,y". */
export interface GroundTile {
  fire?: number;
  t?: Terrain;
}

/** The inherited outcome of a breeding, assembled at conception and materialized when development completes. */
export interface ChildBlueprint {
  speciesId: string;
  sex: Sex;
  /** 1 for player-bred offspring; wild births derive from the parents' levels. */
  level: number;
  genes: Genome;
  mutations: MutationId[];
  personality: PersonalityId;
  skills: string[];
  /** An inherited signature technique carried from a parent's evolved move. */
  sigKnown?: SignatureState[];
  plus: number;
  bond: number;
  generation: number;
  lineageId: string;
  mutHistory: MutationRecord[];
  /** Direct parents' body ids (absent for distant aggregate conceptions). */
  parents?: [string, string];
  /** Display names captured at synthesis time (parents are consumed on synthesis). */
  parentNames?: [string, string];
}

/** Persistent reproductive development — an egg in a nest, or a gestation. The offspring entity is created only at completion. */
export interface ReproductiveDevelopment {
  id: string;
  parentIds: [string, string];
  speciesId: string;
  pairing: ReproPairing;
  type: DevelopmentType;
  state: DevelopmentState;
  startTick: number;
  completeTick: number;
  /** The nest holding this egg, if any. */
  nestId?: string;
  /** "wild" offspring hatch into the world; "player" offspring join party/pen. */
  origin: MatingContext;
  /** The assembled genetic outcome, fixed at conception. */
  child?: ChildBlueprint;
  /** Id of the offspring once created (monster uid or wild creature id). */
  resultId?: string;
  /** Distant conceptions complete into their abstract population — never into a body. */
  distant?: boolean;
  /** The chunk-region a distant development belongs to. */
  dist?: { layer: number; cx: number; cy: number };
}

/** A persistent nest built by a female. Independent world state that Phase 6 territories and Phase 9 ecology can attach to. */
export interface Nest {
  id: string;
  speciesId: string;
  /** The owning female's body id — or `pop:<region key>` for nests tended by an abstract population. */
  ownerId: string;
  x: number;
  y: number;
  state: NestState;
  createdAt: number;
  lastUsedTick: number;
  /** Development records currently or previously held here. */
  developmentIds: string[];
  /** Phase 6 hook: the territory this nest falls within. */
  territoryId?: string;
  /** Vertical layer the nest was built on (absent = surface). */
  layer?: number;
}

/** Rolling reproductive vitals for one species (Phase 7 observability). */
export interface SpeciesVitals {
  births: number;
  deaths: number;
  juvenileDeaths: number;
}

/** Aggregate population of one species in one region cell — the distant-world (Phase 11) seed. */
export interface RegionPopulation {
  speciesId: string;
  /** Total known population (adults + juveniles). */
  pop: number;
  juveniles: number;
  births: number;
  deaths: number;
  tick: number;
}

/**
 * Persistent ecology state (Phase 7). Individual populations near the player
 * live in `creatures` and are censused on demand; this records event-driven
 * vitals and aggregate per-region populations that later phases (distant-world
 * simulation) can extend without individual entities.
 */
export interface EcologyState {
  /** Reproductive births and deaths per species, since the last daily reset. */
  vitals: Record<string, SpeciesVitals>;
  /** Aggregate populations per region cell, key = `r:<rx>,<ry>`. */
  regions: Record<string, RegionPopulation[]>;
  /** Last tick the ecological interval ran. */
  lastTick: number;
}

/**
 * A persistent lineage record (Phase 10): bounded ancestry bookkeeping keyed by
 * lineage id. Lineage identity describes ancestry and is deliberately separate
 * from species identity; records outlive the bodies that carried them.
 */
export interface LineageRecord {
  id: string;
  /** The founding member's species (informational only — lineages are not species). */
  speciesId: string;
  foundedTick: number;
  /** Highest generation registered in this lineage. */
  depth: number;
  /** Living members (event-fed, recomputed on load; approximate between loads). */
  living: number;
  /** Total members ever registered (monotonic). */
  historical: number;
  /** Best expressed gene values observed in the lineage (per gene). */
  peakGenes: Genes;
  /** A capped sample of notable mutations from the lineage's history. */
  notable: MutationRecord[];
  /** A capped sample of member ids (living members after each load). */
  members: string[];
}

/**
 * A persistent ecological home range. Territories are world state with stable
 * identity: they outlive the creatures that currently occupy them, so a
 * population can unload and reload without its home range vanishing.
 * Ownership migrates from the legacy alpha behavior — the dominant individual
 * is the territory holder; other members recognize the territory as home.
 */
export interface Territory {
  id: string;
  /** Species the territory was founded by (mixed populations arrive in a later phase). */
  speciesId: string;
  /** Center tile — the lair, den or founding spot. */
  x: number;
  y: number;
  /** Home-range radius in tiles (chebyshev), matching the map's tile architecture. */
  radius: number;
  /** 0–100 environmental quality derived from existing biome/forage data. */
  quality: number;
  /** The dominant individual's body id (the migrated alpha role), when held. */
  ownerId?: string;
  /** Nests located within this territory (ids — nests and territories stay decoupled). */
  nestIds: string[];
  /** True while ownership has lapsed with rivals about (foundation for later contest behavior). */
  contested?: boolean;
  createdAt: number;
  /** Vertical layer of the range (absent = surface; cave populations hold cave territories). */
  layer?: number;
}

/**
 * One abstract distant population (Phase 11): the aggregate standing of one
 * species in one chunk-region while no individual body simulates it. Mean
 * genes carry the population's accumulated selection state; the seed makes
 * abstract births, deaths and migration deterministic.
 */
export interface AbstractPop {
  speciesId: string;
  /** Individual members represented by this aggregate (adults + juveniles). */
  count: number;
  juveniles: number;
  /** Mean expressed genes across abstracted members. */
  genes: Genes;
  /** Mean condition (0–100). */
  satiety: number;
  /** Mean danger level of members (drives materialized levels). */
  level: number;
  /** Population-level ancestry: the first lineage observed among members. */
  lineageId: string | null;
  /** Deterministic seed for abstract ecological decisions. */
  seed: number;
}

/**
 * A distant chunk-region simulated abstractly (Phase 11). While the player is
 * away its wildlife lives here as aggregate populations that keep breeding,
 * dying, competing and migrating through the shared ecological rules.
 */
export interface DistantRegion {
  key: string;
  layer: number;
  cx: number;
  cy: number;
  pops: AbstractPop[];
  /** Last tick the abstract simulation stepped (elapsed-time processing). */
  lastTick: number;
  /** True once real bodies were folded into these populations. */
  abstracted: boolean;
}

/**
 * A fallen body's remains (Phase 12 food web): real map objects that scavengers
 * seek and eat, and that rot away after a fixed lifespan.
 */
export interface Carrion {
  id: string;
  speciesId: string;
  x: number;
  y: number;
  /** Vertical layer (absent = surface). */
  layer?: number;
  /** Tick the body fell. */
  born: number;
  /** Eating charges left — big bodies feed more mouths. */
  portions: number;
}

/**
 * What a persistent tamer is out in the world to do (tamers.ts). Goals are
 * evaluated from the tamer's own knowledge and team condition — never from
 * omniscient access to the map.
 */
export type TamerGoalKind =
  | "recruit" // seek the wilds for a monster worth taming
  | "develop" // train the current team near home ground
  | "resupply" // travel to a settlement to recover and restock
  | "alpha" // pursue an alpha the tamer has credible word of
  | "duel" // pursue a rival tamer
  | "chapter"; // visit an association chapter

/** A tamer's committed journey — persisted so it resumes after save/load. */
export interface TamerRoute {
  /** Destination tile: a settlement entrance, hunt ground, or rival's last known spot. */
  dx: number;
  dy: number;
  destName: string;
  goal: TamerGoalKind;
  /** Remaining route tiles from findPath, next step first. */
  path: [number, number][];
  plannedTick: number;
}

export interface TamerCareer {
  battles: number;
  wins: number;
  losses: number;
  alphaKills: number;
  tames: number;
}

/** What one tamer has actually learned — sightings, credible word, met rivals. */
export interface TamerKnowledge {
  /** Settlements visited or heard credible talk of, key = "x,y". */
  settlements: Record<string, { name: string; x: number; y: number; tick: number }>;
  /** Alpha word the tamer holds, key = creature id; positions may be stale. */
  alphas: Record<string, { x: number; y: number; speciesId: string; level: number; tick: number; secondhand: boolean }>;
  /** Rivals met or heard of, key = tamer id; position is last known. */
  rivals: Record<string, { name: string; x: number; y: number; tick: number; last: "win" | "loss" | null }>;
  /** Authoritative event ids this tamer has already absorbed (rumor dedup). */
  heard: Record<string, 1>;
}

/** A persistent rival tamer — a real world participant with a career (tamers.ts). */
export interface Tamer {
  /** Stable unique id, independent of name or position. */
  id: string;
  name: string;
  /** Home settlement key "x,y" and its display name. */
  homeKey: string;
  homeName: string;
  x: number;
  y: number;
  /** Vertical layer (tamers keep to the surface for now). */
  layer: number;
  /** Active team — real monsters under the same rules as the player's party. */
  team: Monster[];
  /** Reserve monsters (pen-equivalent), bounded. */
  reserve: Monster[];
  gold: number;
  scarf: string;
  /** Persistent modular appearance (appearance.ts) — cosmetic only, never read by gameplay. Optional for old saves; migration backfills it. */
  look?: TamerLook;
  goal: TamerGoalKind;
  route: TamerRoute | null;
  /** Creature id of the alpha this tamer is hunting, if any. */
  hunt: string | null;
  /** Rival tamer id this tamer is pursuing, if any. */
  duel: string | null;
  /** Tick until which the tamer lies low after a defeat. */
  recoverUntil: number;
  /** Next decision tick (staggered per tamer; bounded work per tick). */
  nextThink: number;
  career: TamerCareer;
  knowledge: TamerKnowledge;
  /** Team field positions during a live encounter, key = monster uid. */
  field: Record<string, { x: number; y: number }>;
}

export type EventCategory = "alpha_kill" | "alpha_loss" | "duel";

/**
 * What actually happened — authoritative, never rewritten by rumor (rumors.ts).
 * Events are bounded, append-only history with stable ids; reputation and
 * rumor records reference them rather than duplicating their payload.
 */
export interface WorldEvent {
  /** Stable id, also the idempotency key for every derived record. */
  id: string;
  cat: EventCategory;
  /** Tamer id or "player". */
  subject: string;
  subjectName: string;
  /** Opponent: alpha creature id, rival tamer id, or "player". */
  other: string;
  otherName: string;
  x: number;
  y: number;
  tick: number;
  /** 1–5 significance — scales reputation impact and propagation speed. */
  sig: number;
  won: boolean;
  /** Nation whose territory the event fell in (null = unclaimed wilds). */
  nationId: string | null;
  /** Nearest chapter association, if any (the association channel's key). */
  assocId: string | null;
  alphaSpeciesId: string | null;
  alphaLevel: number | null;
}

/** One holder's copy of an event — a rumor record with provenance and confidence. */
export interface RumorMemory {
  eventId: string;
  learnedTick: number;
  /** 0–1: 1 = eyewitness; decays with every hop. */
  confidence: number;
  /** Where this copy came from: settlement key, tamer id, or "assoc". */
  from: string;
  hops: number;
}

/** A scheduled rumor transfer: one event, one destination, one due tick. */
export interface RumorTransfer {
  eventId: string;
  toKey: string;
  dueTick: number;
  confidence: number;
  from: string;
  hops: number;
}

/** Sparse reputation entry: existence = known; v may sit at 0. */
export interface RepEntry {
  v: number;
  at: number;
}

/** Reputation ledgers for the player and every tamer, three independent scopes (reputation.ts). */
export interface ReputationState {
  /** Subject id → nation id → entry. */
  nations: Record<string, Record<string, RepEntry>>;
  /** Subject id → association id → entry. */
  assocs: Record<string, Record<string, RepEntry>>;
  /** Subject id → settlement key → entry. */
  settlements: Record<string, Record<string, RepEntry>>;
}

/** An egg stolen into the player's pack — living cargo that carries its bloodline. */
export interface CarriedEgg {
  id: string;
  speciesId: string;
  /** The assembled genetic outcome, fixed at conception — the same blueprint a bred baby is born from. */
  child: ChildBlueprint;
  /** Tick the egg was stolen. */
  stolenTick: number;
  /** Tick the egg is ready to hatch (species-dependent incubation). */
  hatchTick: number;
  /** True when taken from a population nursery — this egg was the abstract flock's future. */
  nursery?: boolean;
  /** Set the first time the egg announces readiness. */
  announced?: boolean;
  /** Set once the keep-or-release hatch prompt has been shown and put off. */
  prompted?: boolean;
}

export interface GameState {
  version: number;
  seedText: string;
  seed: number;
  tick: number;
  player: Player;
  party: Monster[];
  pen: Monster[];
  bag: Partial<Record<ItemId, number>>;
  creatures: Record<string, WildCreature>;
  loadedChunks: string[];
  removed: Record<string, number>;
  depleted: Record<string, number>;
  log: LogEntry[];
  logSeq: number;
  seen: Record<string, boolean>;
  tamed: Record<string, boolean>;
  regions: Record<string, string>;
  lastWeather: WeatherId;
  lastRegion: string;
  /** Nation id the player currently stands in ("" = unclaimed wilds). */
  lastNation: string;
  stats: GameStats;
  /** Party monster positions on the live map, key = monster uid. */
  field: Record<string, { x: number; y: number }>;
  /** Party standing orders, key = monster uid. */
  orders: Record<string, FieldOrder>;
  /** Per-monster aggression, key = monster uid; a missing key means "neutral". */
  aggr: Record<string, Aggression>;
  /** Queued skill commands, key = monster uid; resolved on the monster's next turn. */
  skillQ: Record<string, SkillOrder>;
  /** The creature the party is currently targeting (wild creature id). */
  target: string | null;
  /** The wild creature the player is tracking (log hints + purple outline). */
  tracked: string | null;
  /** Tick of the last tracking log hint (throttles the stream). */
  trackedHint: number;
  /** Sparse fire/terrain overlays on the live map, key = "x,y". */
  ground: Record<string, GroundTile>;
  /** Combat state per combatant: party uids and wild creature ids. */
  fighters: Record<string, FighterState>;
  uidSeq: number;
  /** Persistent nests built by females, key = nest id. */
  nests: Record<string, Nest>;
  /** Reproductive developments (eggs, gestations), key = development id. */
  developments: Record<string, ReproductiveDevelopment>;
  /** Id counter for nests and development records. */
  broodSeq: number;
  /** Persistent ecological territories, key = territory id. */
  territories: Record<string, Territory>;
  /** Id counter for territories. */
  territorySeq: number;
  /** Population ecology state (Phase 7; backfilled by migrateEcology on load). */
  ecology?: EcologyState;
  /** Persistent lineage records, key = lineage id (Phase 10; backfilled by migrateLineages). */
  lineages?: Record<string, LineageRecord>;
  /** Bounded parent → child ids index for lineage queries (Phase 10). */
  childIndex?: Record<string, string[]>;
  /** Abstract distant populations, key = `d:<layer>:<cx>,<cy>` (Phase 11; backfilled by migrateDistant). */
  distant?: Record<string, DistantRegion>;
  /** Fallen remains that scavengers eat and time rots, key = carrion id (backfilled by migrateCarrion). */
  carrion?: Record<string, Carrion>;
  /** Id counter for carrion. */
  carrionSeq?: number;
  /** Stolen eggs riding in the pack, in carry order (backfilled by migrateEggs). */
  eggs?: CarriedEgg[];
  /** Persistent rival tamers, key = tamer id (backfilled by migrateTamers). */
  tamers?: Record<string, Tamer>;
  /** Id counter for tamers. */
  tamerSeq?: number;
  /** Authoritative career events, oldest first (bounded). */
  events?: WorldEvent[];
  /** Id counter for events. */
  eventSeq?: number;
  /** Rumor memories held per settlement, key = "x,y" (bounded per settlement). */
  rumorBoard?: Record<string, RumorMemory[]>;
  /** Scheduled rumor transfers still on the road. */
  rumorQ?: RumorTransfer[];
  /** Reputation ledgers (backfilled by migrateTamers). */
  rep?: ReputationState;
  /** Idempotency guard: reputation applied per event per community, key = `eventId:settlementKey`. */
  repApplied?: Record<string, 1>;
  /** Rival tamers the player has actually met, key = tamer id. */
  metTamers?: Record<string, { name: string; tick: number }>;
  /** Open grudges between allegiances (tamer ids or "player"), key = sorted pair. */
  grudges?: Record<string, 1>;
  knowledge: WorldKnowledge;
}
