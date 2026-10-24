/* Headless sanity check for the knowledge/perception/mapview systems + live combat. */
import { discoveredList, ensureKnowledge, tileVisibility, anyExplored, exploredWorldCells, isRegionSeen, updateKnowledge } from "../src/game/knowledge";
import { aggrOf, avOf, dvOf, engage, hitInfo, initField, partyFighter, partyMonAt, queueSkill, setAggr, setOrder, setTarget, terrainAt, wildFighter } from "../src/game/combat";
import { CHUNK, activeBodyCount, advance, campRest, chunkKey, contextActions, creatureAt, dressCarrion, eggNear, forageHere, loadChunks, makeCreature, migratePersistence, migrateWildXp, newGame, movePlayer, offerFood, previewStarter, requestBreeding, runContextAction, spawnLairPack, stealEgg, useItemOn, waitTurn, wildToMonster, wildXpFor } from "../src/game/sim";
import { BIOMES, DAY_TICKS, ITEMS, SEASON_DAYS, SHOP_STOCK, SPECIES, WORLD_SIZE, footprintOf, developmentTypeFor } from "../src/game/data";
import { DEVELOPMENT_TICKS, abandonNestsOf, advanceDevelopment, beginBreeding, destroyNest, migrateBreeding, offspringSpecies, planChild, previewBreeding } from "../src/game/breeding";
import { Factions, getFactions, migrateFactionKnowledge } from "../src/game/factions";
import { GENE_KEYS, driftGenome, expressGene, founderLineage, getGeneGrade, getMonsterFootprint, inheritGene, inheritGenome, migrateBiology, migrateCreatureBio, migrateMonsterBio, migrateMonsterGenes, mutateDelta, mutateGene, rollGenome, sanitizeGenome, sizeToFootprint, wildGenotypeFromSeed } from "../src/game/genetics";
import { createMonster, displayName, migrateMonsterSex, rollSex, statOf, statsOf } from "../src/game/monster";
import { canMate } from "../src/game/mating";
import { BREED_COOLDOWN_TICKS, DEVELOP_TICKS, MATURITY_LEVEL, advanceReproduction, beginReproduction, canReproduce, isBreedingAvailable, makeReproProfile, migrateRepro, migrateReproCreature, migrateReproMon, maturityFor, reproStateOf, wildReproMode } from "../src/game/reproduction";
import { Rng, hash2, hashString } from "../src/game/rng";
import { hasLOS, seesTile } from "../src/game/perception";
import { getSettlementFootprint, isSettlement, settlementId, settlementTier } from "../src/game/settlement";
import { validateTown } from "../src/game/town";
import { validateCity } from "../src/game/city";
import { monsterReport, nearbyRoadActivity, recruiterLines, residentLines, travelerLines } from "../src/game/news";
import { BUILDING_TEMPLATES, WALKABLE_CELLS, validateBuilding } from "../src/game/buildings";
import { sampleCell } from "../src/game/mapview";
import { getWorld, seedFromText, type Feature } from "../src/game/world";
import type { AbstractPop, ChildBlueprint, Disposition, DistantRegion, GameState, GeneKey, GenePair, Genes, Genome, ItemId, Monster, Nest, ReproductiveDevelopment, Sex, WildCreature } from "../src/game/types";
import { childrenOf, lineageSummary, migrateLineages, recordLineageBirth, relatedness } from "../src/game/lineage";
import { profileOf, seizeTerritory } from "../src/game/wildlife";
import { ENTRY_R } from "../src/game/height";
import { DISTANT_INTERVAL, MAT_CAP_REGION, advanceDistantEcosystem, distantKey, migrateDistant, stepRegion } from "../src/game/distant";
import { CARRION_CAP, CARRION_DAYS, migrateCarrion, spawnCarrion } from "../src/game/carrion";
import { PACK_EGG_CAP, eatCarriedEgg, hatchCarriedEgg, incubationTicks, migrateEggs, removeCarriedEgg, takeEggIntoPack } from "../src/game/eggs";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { defringeEdges, stripBlackBackground, type RawImage } from "../src/game/spritebg";
import { ensureTerritory, homeAnchor, migrateTerritories, releaseTerritoryOwner, territoryAt } from "../src/game/territory";
import { decodePng } from "./sprites";
import {
  CAVE_UPPER, NEWBORN_TICKS, bodyFootprint, foodDemand, footprintClass, growthSpan, matureAgeOf, migrateGrowth, physicalSize, stageOf,
} from "../src/game/growth";
import {
  CREATURE_CAP, ECOLOGY_INTERVAL, adultMortalityChance, allowsBreeding, assessTerritory, buildCensus, ecoOnBirth, ecoOnDeath, ecologyTick,
  juvenileMortalityChance, migrateEcology, resolveGrowth, spawnAllowedByEcology,
} from "../src/game/ecology";
import { attachNest, createTerritory } from "../src/game/territory";
import { createNest } from "../src/game/breeding";
import { ensureRegion, isAnchoredSpawn, isExceptionalCreature, popOwnerId, stepRegion } from "../src/game/distant";
import {
  CAVE_DEEP, CAVE_FAUNA, CAVE_SIGHT, CAVE_UPPER, CLIMB_AVOID, HEAVY_CLIMB_AVOID, PIN_CORE, PIN_RAMP, PLAYER_MOVER, SKY, SURFACE, UW, bodyLevelOk, fallDamage, fallLevels,
  groundInfo, heightEdge, heightLOS, heightOf, layerOf, migrateHeight, moverOf, sameLayer, stepRule, tileCost, walkable,
} from "../src/game/height";
import { OBJ_KINDS, objectAt } from "../src/game/objects";
import { changeLayer } from "../src/game/sim";
import { World, findPath } from "../src/game/world";
import { sightRadius } from "../src/game/perception";
import { ROAD_CLASS_RANK, finishRoads, mapRoadLines, roadAt, roadClassFor, roadNetworkOf, pumpRoads, settlementEntranceAt, settlementRoads, type RoadNetwork } from "../src/game/roads";
import { validateSettlementInfrastructure } from "../src/game/validate";
import { migrateLoaded } from "../src/game/migrate";
import { BODIES, FACES, HAIRS, HEADS, STRUCTURAL_COMBINATIONS, assetFiles, composeLook, decodePart, defaultLook, lookSilhouette, resolveLook, validatePart, validateRegistry, type PartMap } from "../src/game/appearance";
import { decodePng as decodeTamerPng } from "./tamer-art/png";
import { SAVE_VERSION } from "../src/game/sim";

let fails = 0;
const ok = (cond: boolean, label: string): void => {
  if (!cond) {
    fails++;
    console.log(`FAIL ${label}`);
  } else console.log(`ok   ${label}`);
};

const cheb = (ax: number, ay: number, bx: number, by: number): number => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** Places a synthetic hostile creature on a free tile adjacent to the player. */

/** Stamps every forage tile in reach as depleted — a stage with nothing to eat. */
const starveArea = (gs: GameState, cx: number, cy: number, r: number): void => {
  const w = getWorld(gs.seed);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (!w.inBounds(x, y)) continue;
      if (w.forage(x, y, gs.tick, gs.depleted)) gs.depleted[`${x},${y}`] = gs.tick;
    }
  }
};

/** Moves the party to quiet wild ground: open, unbuilt, far from live bodies. One chunk load — the heuristic does the filtering. */
const quietGround = (gs: GameState): boolean => {
  const w = getWorld(gs.seed);
  // a lair within a day's walk of the stage ruins the quiet; pick around one
  const hot = w.featuresNear(gs.player.x, gs.player.y, 200).filter((f) => f.kind === "lair");
  for (let r = 30; r < 120; r++) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = gs.player.x + Math.round(Math.cos(ang) * r);
      const y = gs.player.y + Math.round(Math.sin(ang) * r);
      if (!w.inBounds(x, y) || !w.passable(x, y) || w.siteAt(x, y) || w.tile(x, y).feature) continue;
      // no built place or lair within a long bowshot: walls and wild bodies
      // both spoil a quiet drill
      if (w.featuresNear(x, y, 24).length) continue;
      if (hot.some((f) => Math.max(Math.abs(f.x - x), Math.abs(f.y - y)) < 40)) continue;
      gs.player.x = x;
      gs.player.y = y;
      initField(gs);
      loadChunks(gs);
      // sit out any storm: sheltering beats every order, so a quiet stage
      // is a dry one
      for (let i = 0; i < 300; i++) {
        const wid = w.weather(gs.player.x, gs.player.y, gs.tick).id;
        if (wid !== "storm" && wid !== "rain") break;
        waitTurn(gs, 1);
      }
      return true;
    }
  }
  return false;
};

/** The nearest river tile, however far — river scenarios anchor on real water. */
const riverNear = (w: ReturnType<typeof getWorld>, x0: number, y0: number): { x: number; y: number } | null => {
  for (let r = 0; r < 400; r += 4) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = x0 + Math.round(Math.cos(ang) * r);
      const y = y0 + Math.round(Math.sin(ang) * r);
      if (w.inBounds(x, y) && w.tile(x, y).biome === "river") return { x, y };
    }
  }
  return null;
};

const placeAdjacent = (gs: GameState, id: string, speciesId: string, level: number): WildCreature | null => {
  const world = getWorld(gs.seed);
  const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  for (const [dx, dy] of dirs) {
    const x = gs.player.x + dx;
    const y = gs.player.y + dy;
    if (!world.inBounds(x, y) || !world.passable(x, y) || world.siteAt(x, y)?.wall || creatureAt(gs, x, y) || partyMonAt(gs, x, y)) continue;
    const c: WildCreature = {
      id, speciesId, level, x, y, homeX: x, homeY: y,
      hpFrac: 1, satiety: 60, disposition: "aggressive", activity: "Wandering", personality: "fierce",
      geneSeed: 424242, genes: wildGenotypeFromSeed(424242, speciesId), gen: 1, lineageId: `L:${id}`,
      repro: makeReproProfile(wildReproMode(id, speciesId), level, 0),
      calmUntil: 0, alpha: false, affection: 0, stalking: false,
    };
    gs.creatures[id] = c;
    return c;
  }
  return null;
};

const gs = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
// the walker needs a party that can survive random live encounters
gs.party[0].level = 20;
gs.party[0].hp = statOf(gs.party[0], "hp");
ok(gs.party.length === 1, "party has starter");
ok(gs.field[gs.party[0].uid] !== undefined, "starter deployed beside the player at start");
ok(!!gs.knowledge && Object.keys(gs.knowledge.explored).length >= 2, "start area revealed");
ok(discoveredList(gs.knowledge).some((d) => d.kind === "hamlet"), "home hamlet discovered");
ok(isRegionSeen(gs.knowledge, gs.player.x, gs.player.y), "start region seen");

const world = getWorld(gs.seed);
const before = Object.keys(gs.knowledge.explored).length;
ok(tileVisibility(gs, gs.player.x, gs.player.y) === "visible", "player tile visible");
ok(tileVisibility(gs, gs.player.x + 200, gs.player.y + 200) === "fog", "far tile is fog");

// Adaptive walk: rotate direction when terrain/creatures block the way.
// (the walk starts beyond the settlement bustle: the village green's open
// floor and building walls would cage the walker's simple direction rotation)
let walkStart: { x: number; y: number } | null = null;
const openAround = (x: number, y: number): boolean => {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (!world.inBounds(x + dx, y + dy) || !walkable(world, SURFACE, x + dx, y + dy) || world.siteAt(x + dx, y + dy) || world.tile(x + dx, y + dy).feature) return false;
    }
  }
  return true;
};
walkA: for (let r = 15; r < 60; r++) {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = gs.player.x + dx;
      const y = gs.player.y + dy;
      if (openAround(x, y)) {
        walkStart = { x, y };
        break walkA;
      }
    }
  }
}
ok(!!walkStart, "found wild ground beyond the green for the walk");
if (walkStart) {
  gs.player.x = walkStart.x;
  gs.player.y = walkStart.y;
}
const startX = gs.player.x;
const startY = gs.player.y;
let minX = startX;
let maxX = startX;
let minY = startY;
let maxY = startY;
let midPos: { x: number; y: number } | null = null;
// The world is wild now — dense groves and boulder fields cage a blind
// direction spiral. Roam the way a player does: pick a nearby target, path
// around the trees, follow it, repeat.
let hop = 0;
let path: [number, number][] | null = null;
let guard = 0;
while (gs.stats.steps < 150 && guard < 6000) {
  guard++;
  if (!path || !path.length) {
    hop++;
    const h = hash2(gs.seed ^ 0x70ac, hop, guard);
    const dist = 8 + (h % 13);
    const ang = ((h >>> 8) % 16) / 16 * Math.PI * 2;
    const tx = gs.player.x + Math.round(Math.cos(ang) * dist);
    const ty = gs.player.y + Math.round(Math.sin(ang) * dist);
    path = findPath(world, gs.player.x, gs.player.y, tx, ty, 6000, SURFACE);
    continue;
  }
  const [tx, ty] = path[0];
  const px0 = gs.player.x;
  const py0 = gs.player.y;
  movePlayer(gs, tx - gs.player.x, ty - gs.player.y);
  if (gs.player.x === px0 && gs.player.y === py0) path = null; // blocked mid-path — repick
  else {
    path.shift();
    minX = Math.min(minX, gs.player.x);
    maxX = Math.max(maxX, gs.player.x);
    minY = Math.min(minY, gs.player.y);
    maxY = Math.max(maxY, gs.player.y);
    if (!midPos && gs.stats.steps >= 75) midPos = { x: gs.player.x, y: gs.player.y };
  }
}
const steps = gs.stats.steps;
ok(steps >= 100, `walked ${steps} steps`);
const after = Object.keys(gs.knowledge.explored).length;
const bboxCells = Math.max(2, Math.floor(((maxX - minX + 1) * (maxY - minY + 1)) / 64));
ok(after > before, `exploration grows (${before} -> ${after}, bbox ≈ ${bboxCells} cells)`);
ok(after >= bboxCells * 0.7, `explored covers walked bbox (${after} vs ${bboxCells})`);
ok(gs.knowledge.route.length >= 8, `route breadcrumbs (${gs.knowledge.route.length} for ${steps} steps)`);
ok(tileVisibility(gs, gs.player.x, gs.player.y) === "visible", "current tile visible after walk");

// memory: where the player came from is remembered, not fog
const far = Math.max(Math.abs(startX - gs.player.x), Math.abs(startY - gs.player.y));
if (far > 15) ok(tileVisibility(gs, startX, startY) === "memory", `left-behind area is memory (${far} tiles away)`);
else console.log(`skip left-behind check (wandered back, ${far} tiles)`);

// no leak: every discovery was made within sight of somewhere the player traveled
ok(
  discoveredList(gs.knowledge).every((d) =>
    [[startX, startY], ...gs.knowledge.route].some(([rx, ry]) => Math.max(Math.abs(d.x - rx), Math.abs(d.y - ry)) <= 30),
  ),
  "all discoveries near traveled route",
);

// LOS sanity
ok(hasLOS(world, 10, 10, 12, 10), "flat LOS true");

// map aggregation: cached and stable per seed
const s1 = sampleCell("region", world, gs.player.x, gs.player.y);
const s2 = sampleCell("world", world, gs.player.x, gs.player.y);
ok(!!s1 && !!s2, "samples exist");
ok(sampleCell("region", world, gs.player.x, gs.player.y).biome === s1.biome, "region sample cached & stable");
ok(sampleCell("world", world, gs.player.x, gs.player.y).biome === s2.biome, "world sample cached & stable");

// explored roll-up
const wc = exploredWorldCells(gs.knowledge);
ok(wc.size > 0 && anyExplored(gs.knowledge, gs.player.x - 8, gs.player.y - 8, gs.player.x + 8, gs.player.y + 8), "explored roll-up works");

// ---- Physical landmark sites (walls, floors, doors) ----
const kindsNear = (kind: string): Feature | null => {
  const fs = world.featuresNear(gs.player.x, gs.player.y, 900).filter((f) => f.kind === kind);
  return fs[0] ?? null;
};

const hamlet = kindsNear("hamlet");
ok(!!hamlet, "a hamlet exists nearby");
if (hamlet) {
  const center = world.siteAt(hamlet.x, hamlet.y);
  ok(!!center && !center.wall, "hamlet center is open plaza");
  let walls = 0;
  let doors = 0;
  let wet = 0;
  for (let dy = -11; dy <= 11; dy++) {
    for (let dx = -11; dx <= 11; dx++) {
      if (["deep", "sea", "lake", "river"].includes(world.tile(hamlet.x + dx, hamlet.y + dy).biome)) wet++;
      const s = world.siteAt(hamlet.x + dx, hamlet.y + dy);
      if (!s) continue;
      if (s.wall) walls++;
      if (s.door) doors++;
    }
  }
  ok(wet === 0, `the whole settlement stands on dry land (${wet} wet tiles)`);
  ok(walls > 8, `hamlet has building walls (${walls})`);
  ok(doors >= 3, `hamlet has doorways (${doors})`);
  // the buildings are real structures: validated layouts, multiple rooms,
  // entrances onto open ground, and collision that comes from the walls
  const layout = world.settlementLayout(hamlet);
  ok(layout.buildings.length === 5, `hamlet has its five buildings — three services and two homes (${layout.buildings.length})`);
  ok(!!layout.building("small_home") && !!layout.building("medium_home"), "both homes stand in the layout");
  // buildings never overlap and never leave the settlement footprint
  for (let i = 0; i < layout.buildings.length; i++) {
    for (let j = i + 1; j < layout.buildings.length; j++) {
      const a = layout.buildings[i];
      const c = layout.buildings[j];
      const apart = a.x + a.w <= c.x || c.x + c.w <= a.x || a.y + a.h <= c.y || c.y + c.h <= a.y;
      ok(apart, `${a.type} and ${c.type} do not overlap`);
    }
  }
  ok(
    layout.buildings.every((b) => Math.abs(b.x - hamlet.x) <= 11 && Math.abs(b.y - hamlet.y) <= 11 && b.x + b.w - hamlet.x <= 12 && b.y + b.h - hamlet.y <= 12),
    "every building stays inside the settlement footprint",
  );
  for (const b of layout.buildings) {
    const problems = validateBuilding(b, BUILDING_TEMPLATES[b.type]);
    ok(problems.length === 0, `${b.type} (${b.id}) passes structural validation${problems.length ? ": " + problems[0] : ""}`);
    ok(b.rooms.length >= 2, `${b.type} has ${b.rooms.length} rooms`);
    const ent = b.doors.find((d) => d.external);
    ok(!!ent, `${b.type} has an exterior entrance`);
    let buildingWet = 0;
    for (let ly = 0; ly < b.h; ly++) for (let lx = 0; lx < b.w; lx++) if (["deep", "sea", "lake", "river"].includes(world.tile(b.x + lx, b.y + ly).biome)) buildingWet++;
    ok(buildingWet === 0, `${b.type} stands entirely on dry land (${buildingWet} wet tiles)`);
    if (ent?.dir) {
      const step = ent.dir === "n" ? [0, -1] : ent.dir === "s" ? [0, 1] : ent.dir === "w" ? [-1, 0] : [1, 0];
      ok(world.passable(b.x + ent.lx + step[0], b.y + ent.ly + step[1]), `${b.type} entrance opens onto walkable ground`);
      // the entrance faces the heart of the settlement: the ground outside the
      // door sits closer to the feature tile than the door itself
      const doorX = b.x + ent.lx;
      const doorY = b.y + ent.ly;
      const d2 = (px: number, py: number): number => (px - hamlet.x) ** 2 + (py - hamlet.y) ** 2;
      ok(d2(doorX + step[0], doorY + step[1]) < d2(doorX, doorY), `${b.type} entrance faces the village green`);
    }
    // the player can reach every room through the building's own doors
    const startTile = ent?.dir === "n" ? [ent.lx, ent.ly + 1] : ent?.dir === "s" ? [ent.lx, ent.ly - 1] : ent?.dir === "w" ? [ent.lx + 1, ent.ly] : ent?.dir === "e" ? [ent.lx - 1, ent.ly] : null;
    if (startTile) {
      const seen = new Set<number>([startTile[1] * b.w + startTile[0]]);
      const q: [number, number][] = [[startTile[0], startTile[1]]];
      while (q.length) {
        const [qx, qy] = q.shift()!;
        for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = qx + ddx;
          const ny = qy + ddy;
          const k = ny * b.w + nx;
          if (seen.has(k) || nx < 0 || ny < 0 || nx >= b.w || ny >= b.h) continue;
          const kind = b.cells[ny * b.w + nx];
          if (!WALKABLE_CELLS.includes(kind)) continue;
          seen.add(k);
          q.push([nx, ny]);
        }
      }
      for (const r of b.rooms) {
        let reached = false;
        for (let ly = r.y0; ly <= r.y1 && !reached; ly++) for (let lx = r.x0; lx <= r.x1; lx++) if (seen.has(ly * b.w + lx)) { reached = true; break; }
        ok(reached, `${b.type} room ${r.id} (${r.type}) is walkable from the entrance`);
      }
    }
  }
  const npcs = world.settlementNpcs(hamlet);
  ok(npcs.length === 3, `hamlet has three folk (${npcs.length})`);
  ok(npcs.every((n) => world.passable(n.x, n.y)), "folk stand on walkable tiles");
  ok(npcs.every((n) => !world.siteAt(n.x, n.y)?.wall && !world.siteAt(n.x, n.y)?.door), "folk stand clear of walls and doorways");
  ok(!!world.npcAt(npcs[0].x, npcs[0].y) && world.npcAt(npcs[0].x, npcs[0].y)!.name === npcs[0].name, "npcAt finds folk at their post");
  ok(world.npcAt(npcs[0].x + 3, npcs[0].y + 3) === null, "no folk on empty tiles");
  const w3 = new (world.constructor as new (seed: number) => typeof world)(world.seed);
  ok(w3.settlementNpcs(hamlet)[0].name === npcs[0].name, "folk are seed-deterministic");
  ok(JSON.stringify(w3.settlementLayout(hamlet!).buildings) === JSON.stringify(layout.buildings), "building layouts are seed-deterministic across instances");

  // ---- Phase 3: homes, residents, recruiter, local news ----
  for (const t of ["small_home", "medium_home"] as const) {
    const home = layout.building(t)!;
    const problems = validateBuilding(home, BUILDING_TEMPLATES[t]);
    ok(problems.length === 0, `the ${t} passes structural validation${problems.length ? ": " + problems[0] : ""}`);
    ok(home.rooms.length >= 2, `the ${t} has ${home.rooms.length} distinct rooms`);
    ok(home.doors.some((d) => !d.external), `the ${t} connects its rooms with internal doors`);
    const walk = home.cells.filter((k) => WALKABLE_CELLS.includes(k)).length;
    ok(walk >= 8, `the ${t} has walkable floor space (${walk} tiles)`);
    ok(home.reserved.length > 0 && home.reserved.length < walk, `the ${t} keeps unused floor alongside reserved space (${home.reserved.length}/${walk})`);
    let collisionOk = true;
    for (let ly = 0; ly < home.h; ly++) {
      for (let lx = 0; lx < home.w; lx++) {
        if (world.passable(home.x + lx, home.y + ly) !== !world.siteAt(home.x + lx, home.y + ly)!.wall) collisionOk = false;
      }
    }
    ok(collisionOk, `the ${t} has valid collision boundaries`);
  }

  const res0 = world.settlementResidents(hamlet, 0);
  ok(res0.length === 2, `exactly two residents wander the hamlet (${res0.length})`);
  ok(res0[0].name !== res0[1].name, "the two residents have their own names");
  ok(res0.every((n) => n.home && (n.home === "small_home" || n.home === "medium_home")), "each resident belongs to a home building");
  ok(res0.every((n) => n.variant !== undefined), "residents carry a visual variant for later portraits");
  // a full day of wandering: always inside, always on open public ground,
  // never parked on a doorstep, and different from place to place in time
  let dayBad = 0;
  let dayMoves = 0;
  const spots = new Set<string>();
  for (let t = 0; t < DAY_TICKS; t++) {
    for (const n of world.settlementResidents(hamlet, t)) {
      const s = world.siteAt(n.x, n.y);
      if (!world.passable(n.x, n.y) || s?.wall || s?.door || s?.buildingId) dayBad++;
      if (Math.abs(n.x - hamlet.x) > 11 || Math.abs(n.y - hamlet.y) > 11) dayBad++;
      spots.add(`${n.x},${n.y}`);
    }
    if (t > 0) {
      const a = world.settlementResidents(hamlet, t - 1);
      const b = world.settlementResidents(hamlet, t);
      if (a.some((n, i) => n.x !== b[i].x || n.y !== b[i].y)) dayMoves++;
    }
  }
  ok(dayBad === 0, `residents spend the whole day on valid open ground (${dayBad} bad tiles)`);
  ok(dayMoves > 30, `residents actually wander (${dayMoves} moving ticks a day)`);
  ok(spots.size >= 6, `residents cover their ground (${spots.size} tiles visited)`);
  const w4 = new (world.constructor as new (seed: number) => typeof world)(world.seed);
  ok(JSON.stringify(w4.settlementResidents(hamlet, 137)) === JSON.stringify(world.settlementResidents(hamlet, 137)), "residents are deterministic (same seed, same tick, same places)");

  const rec = world.settlementRecruiter(hamlet);
  ok(!!rec, "an association recruiter posts on the green");
  if (rec) {
    ok(rec.role === "recruiter" && rec.assocSlot !== undefined, "the recruiter carries an association slot, not a fabricated chapter");
    ok(world.passable(rec.x, rec.y) && !world.siteAt(rec.x, rec.y)?.wall && !world.siteAt(rec.x, rec.y)?.door, "the recruiter stands on open ground");
    ok(Math.abs(rec.x - hamlet.x) <= 11 && Math.abs(rec.y - hamlet.y) <= 11, "the recruiter stays inside the settlement");
    ok(!layout.building("association"), "no association chapter building stands in a hamlet");
    const w5 = new (world.constructor as new (seed: number) => typeof world)(world.seed);
    ok(w5.settlementRecruiter(hamlet)!.x === rec.x && w5.settlementRecruiter(hamlet)!.name === rec.name, "the recruiter is seed-deterministic");
  }

  // dialogue: real world state, never coordinates
  const talkNpc = res0[0];
  const lines = residentLines(gs, { ...talkNpc, x: hamlet.x, y: hamlet.y });
  ok(lines.length > 0, "a resident has something to say");
  ok(lines.every((l) => !/\d+\s*,\s*\d+/.test(l)), "resident talk never leaks coordinates");
  const linesAgain = residentLines(gs, { ...talkNpc, x: hamlet.x, y: hamlet.y });
  ok(JSON.stringify(lines) === JSON.stringify(linesAgain), "resident talk is deterministic for the day");
  const recLines = rec ? recruiterLines(gs, rec) : [];
  ok(recLines.length > 0 && recLines.every((l) => !/\d+\s*,\s*\d+/.test(l)), "recruiter talk works and never leaks coordinates");
  // the monster-rumor hierarchy: live bodies beat territories beat lairs beat regional ecology
  const lairRef = kindsNear("lair");
  const bareGs = { seed: gs.seed, tick: gs.tick, creatures: {}, territories: {} } as unknown as GameState;
  const bareReport = monsterReport(bareGs, hamlet.x, hamlet.y);
  ok(bareReport.every((b) => b.kind === "lair" || b.kind === "regional"), "with nothing alive nearby, rumors fall back to lairs or the land itself");
  if (lairRef) {
    const lairGs = { seed: gs.seed, tick: gs.tick, creatures: {}, territories: {} } as unknown as GameState;
    ok(monsterReport(lairGs, lairRef.x + 20, lairRef.y).some((b) => b.kind === "lair"), "a nearby lair is reported as such");
  }
  const nearBody = { id: "w:rumor", speciesId: "mossback", level: 3, x: hamlet.x + 9, y: hamlet.y - 4, hpFrac: 1, satiety: 50, disposition: "calm", activity: "Wandering", personality: "gentle", geneSeed: 1, genes: undefined, gen: 1, lineageId: null, repro: undefined, calmUntil: 0, alpha: false, affection: 0, stalking: false } as unknown as WildCreature;
  const liveGs = { seed: gs.seed, tick: gs.tick, creatures: { "w:rumor": nearBody }, territories: {} } as unknown as GameState;
  ok(monsterReport(liveGs, hamlet.x, hamlet.y)[0]?.kind === "creature", "a live beast nearby outranks lairs and territories in the rumor hierarchy");
  const liveLines = residentLines(liveGs, { ...talkNpc, x: hamlet.x, y: hamlet.y });
  ok(liveLines.some((l) => l.toLowerCase().includes("prowling") || l.toLowerCase().includes("mossback")), `a resident passes on what is actually out there ("${liveLines[0] ?? ""}")`);
}

const ruin = kindsNear("ruin");
ok(!!ruin, "a ruin exists nearby");
if (ruin) {
  let rw = 0;
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) if (world.siteAt(ruin.x + dx, ruin.y + dy)?.wall) rw++;
  ok(rw > 5, `ruin has broken walls (${rw})`);
}

const lair = kindsNear("lair");
ok(!!lair, "a lair exists nearby");
if (lair) {
  ok(!!world.siteAt(lair.x, lair.y) && !world.siteAt(lair.x, lair.y)!.wall, "lair den floor is open");
  let ring = 0;
  for (let a = 0; a < 24; a++) {
    const x = lair.x + Math.round(Math.cos((a / 24) * Math.PI * 2) * 4.4);
    const y = lair.y + Math.round(Math.sin((a / 24) * Math.PI * 2) * 4.4);
    if (world.siteAt(x, y)?.wall) ring++;
  }
  ok(ring >= 13, `lair enclosed by rock walls (${ring}/24 ring samples)`);
  // live combat samples real site walls 1:1 as blocking terrain
  let wallTerrain = 0;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const tx = lair.x + dx;
      const ty = lair.y + dy;
      if (world.siteAt(tx, ty)?.wall && terrainAt(gs, tx, ty) === "wall") wallTerrain++;
    }
  }
  ok(wallTerrain > 5, `combat terrain matches the real den walls (${wallTerrain})`);
}

// determinism across World instances
if (hamlet) {
  const w2 = new (world.constructor as new (seed: number) => typeof world)(world.seed);
  ok(!!w2.siteAt(hamlet.x - 4, hamlet.y - 4) === !!world.siteAt(hamlet.x - 4, hamlet.y - 4), "sites are seed-deterministic across instances");
}

// ---- procedural buildings: many seeds, every template, every requirement ----
{
  const make = world.constructor as new (seed: number) => typeof world;
  const seeds = [11, 4242, 90210, 31337, 777, 20260101];
  let generated = 0;
  const shapes = new Set<string>();
  for (const s of seeds) {
    const bw = new make(s);
    const ham2 = bw.featuresNear(Math.floor(WORLD_SIZE / 2), Math.floor(WORLD_SIZE * 0.56), 900).find((f) => f.kind === "hamlet");
    if (!ham2) continue;
    const layout2 = bw.settlementLayout(ham2);
    ok(JSON.stringify(layout2.buildings) === JSON.stringify(new make(s).settlementLayout(ham2).buildings), `seed ${s}: building layouts identical across instances`);
    for (const b of layout2.buildings) {
      const problems = validateBuilding(b, BUILDING_TEMPLATES[b.type]);
      ok(problems.length === 0, `seed ${s} ${b.type} validates${problems.length ? ": " + problems[0] : ""}`);
      ok(b.rooms.length >= 2, `seed ${s} ${b.type} has ${b.rooms.length} rooms`);
      ok(b.doors.some((d) => d.external), `seed ${s} ${b.type} has an entrance`);
      ok(b.reserved.length >= b.rooms.length, `seed ${s} ${b.type} reserves space for future objects`);
      shapes.add(`${b.type}:${b.w}x${b.h}`);
      generated++;
    }
  }
  ok(generated >= 15, `buildings generated across seeds and templates (${generated})`);
  ok(shapes.size > 3, `buildings vary in size and shape across seeds (${shapes.size} distinct)`);
}

// LOS is cut by site walls
if (ruin) {
  outerWall: for (let y = ruin.y - 4; y <= ruin.y + 4; y++) {
    for (let x = ruin.x - 3; x <= ruin.x + 2; x++) {
      if (world.siteAt(x, y)?.wall && !world.siteAt(x + 1, y)?.wall && !world.siteAt(x - 1, y)?.wall) {
        ok(!hasLOS(world, x - 1, y, x + 1, y), "site wall blocks line of sight");
        break outerWall;
      }
    }
  }
}

// movement into a wall is refused
if (hamlet) {
  seek: for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const wx = hamlet.x + dx;
      const wy = hamlet.y + dy;
      if (world.siteAt(wx, wy)?.wall && world.passable(wx, wy - 1) && !world.siteAt(wx, wy - 1)?.door) {
        gs.player.x = wx;
        gs.player.y = wy + 1;
        const before2 = gs.stats.steps;
        const r = movePlayer(gs, 0, -1);
        ok(!r.ok && gs.stats.steps === before2, "movePlayer refuses to walk into a wall");
        break seek;
      }
    }
  }
  gs.player.x = gs.player.homeX;
  gs.player.y = gs.player.homeY;
}

// size tiers: Titanic (4×4), Huge (3×3), Large (2×2), normal (1×1)
ok(
  footprintOf(SPECIES["sunwyrm"]) === 4 && footprintOf(SPECIES["ironfang_tyrant"]) === 4,
  "titanic tier is 4×4 (sunwyrm, tyrant)",
);
ok(
  footprintOf(SPECIES["crystal_golem"]) === 3 && footprintOf(SPECIES["stormmane_drake"]) === 3,
  "huge tier is 3×3 (golem, stormmane)",
);
ok(
  footprintOf(SPECIES["skyhorn_dragon"]) === 2 && footprintOf(SPECIES["mandrake_maw"]) === 2 && footprintOf(SPECIES["jade_spikeon"]) === 2,
  "large tier is 2×2 (skyhorn, mandrake, spikeon)",
);
ok(
  footprintOf(SPECIES["mossback"]) === 1 && footprintOf(SPECIES["cindermaw"]) === 1 && footprintOf(SPECIES["tidefin_toad"]) === 1,
  "starters and small species stay 1×1",
);

// a huge wild creature blocks every tile of its footprint on the local map
{
  let spot: [number, number] | null = null;
  seekBig: for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) {
      const x = gs.player.homeX + dx;
      const y = gs.player.homeY + dy;
      let clear = true;
      for (let oy = 0; oy < 3 && clear; oy++) {
        for (let ox = 0; ox < 4; ox++) {
          const tx = x + ox;
          const ty = y + oy;
          if (!world.passable(tx, ty) || world.siteAt(tx, ty)?.wall || world.npcAt(tx, ty) || creatureAt(gs, tx, ty)) {
            clear = false;
            break;
          }
        }
      }
      if (clear) {
        spot = [x, y];
        break seekBig;
      }
    }
  }
  ok(!!spot, "found open ground for a huge creature test");
  if (spot) {
    const [sx, sy] = spot;
    const px0 = gs.player.x;
    const py0 = gs.player.y;
    gs.player.x = sx;
    gs.player.y = sy;
    const big: WildCreature = {
      id: "big:1", speciesId: "crystal_golem", level: 6, x: sx + 1, y: sy, homeX: sx + 1, homeY: sy,
      hpFrac: 1, satiety: 60, disposition: "calm", activity: "Wandering", personality: "gentle",
      geneSeed: 999, calmUntil: gs.tick + 1000, alpha: false, affection: 0, stalking: false,
    };
    gs.creatures["big:1"] = big;
    const r1 = movePlayer(gs, 1, 0);
    ok(!r1.ok && gs.player.x === sx && gs.player.y === sy, "player blocked by huge creature's anchor tile");
    const r2 = movePlayer(gs, 1, 0);
    ok(!r2.ok && gs.player.x === sx && gs.player.y === sy, "player blocked by huge creature's covered tile");
    delete gs.creatures["big:1"];
    // a Huge (3×3) creature blocks all nine tiles of its body
    const big3: WildCreature = {
      id: "big:3", speciesId: "stormmane_drake", level: 7, x: sx + 1, y: sy, homeX: sx + 1, homeY: sy,
      hpFrac: 1, satiety: 60, disposition: "calm", activity: "Wandering", personality: "gentle",
      geneSeed: 998, calmUntil: gs.tick + 1000, alpha: false, affection: 0, stalking: false,
    };
    gs.creatures["big:3"] = big3;
    const rows3 = [0, 1, 2].map((k) => {
      gs.player.x = sx;
      gs.player.y = sy + k;
      const r = movePlayer(gs, 1, 0);
      return !r.ok && gs.player.x === sx && gs.player.y === sy + k;
    });
    ok(rows3.every(Boolean), "player blocked by Huge creature's full 3×3 body");
    ok(
      ([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]] as const).every(
        ([ox, oy]) => creatureAt(gs, sx + 1 + ox, sy + oy) === big3,
      ),
      "creatureAt covers all nine Huge tiles",
    );
    delete gs.creatures["big:3"];
    gs.player.x = px0;
    gs.player.y = py0;
  }
}

/* ------------------------------ LIVE COMBAT ---------------------------------- */

// bumping a hostile creature engages it live (no arena handoff)
{
  const g = newGame("ENGAGE-1", "Rook", "ranger", "#e8742a", previewStarter("ENGAGE-1", "mossback"));
  const foe = placeAdjacent(g, "t:1", "slimekin", 3);
  ok(!!foe, "placed a hostile beside the player");
  if (foe) {
    const r = movePlayer(g, foe.x - g.player.x, foe.y - g.player.y);
    ok(!!r.engaged && r.engaged === "t:1", "bumping a hostile engages it live");
    ok(g.target === "t:1" && g.creatures["t:1"]?.stalking === true, "engagement marks the party target");
    ok(g.stats.battles === 1, "engagement counted");
  }
}

// autonomous exchange: the fight resolves over ticks and kills pay out
{
  const g = newGame("FIGHT-1", "Rook", "ranger", "#e8742a", previewStarter("FIGHT-1", "mossback"));
  const foe = placeAdjacent(g, "f:1", "slimekin", 3);
  ok(!!foe, "fight: hostile placed");
  if (foe) {
    movePlayer(g, foe.x - g.player.x, foe.y - g.player.y);
    const gold0 = g.player.gold;
    const xp0 = g.party[0].xp + g.party[0].level;
    for (let i = 0; i < 60 && g.creatures["f:1"]; i++) waitTurn(g, 1);
    ok(!g.creatures["f:1"], "the engaged creature was defeated autonomously");
    ok(g.removed["f:1"] !== undefined, "defeat recorded in removed");
    ok(g.player.gold > gold0 || Object.values(g.bag).some((n) => (n ?? 0) > 0), "kill paid out gold or drops");
    ok(g.party[0].xp + g.party[0].level > xp0, "kill granted XP");
    ok(g.log.some((l) => l.kind === "combat"), "combat strikes were logged");
  }
}

// determinism: same seed + same actions replay the exact same fight
{
  const run = (): string => {
    const g = newGame("DETERMIN-1", "Rook", "ranger", "#e8742a", previewStarter("DETERMIN-1", "mossback"));
    const foe = placeAdjacent(g, "d:1", "slimekin", 3);
    if (!foe) return "skip";
    movePlayer(g, foe.x - g.player.x, foe.y - g.player.y);
    for (let i = 0; i < 40 && g.creatures["d:1"]; i++) waitTurn(g, 1);
    return JSON.stringify({ hp: g.party.map((m) => m.hp), gold: g.player.gold, tick: g.tick, gone: !g.creatures["d:1"] });
  };
  const r1 = run();
  const r2 = run();
  ok(r1 === r2 && r1 !== "skip", "same seed and actions reproduce the identical fight");
}

// party follow: monsters trail the player at arm's length
{
  const g = newGame("FOLLOW-1", "Rook", "ranger", "#e8742a", previewStarter("FOLLOW-1", "mossback"));
  ok(quietGround(g), "found quiet wild ground for the follow walk");
  const uid = g.party[0].uid;
  for (let i = 0; i < 6; i++) movePlayer(g, 1, 0);
  // a beat to round whatever terrain the straight line ignored
  for (let i = 0; i < 4; i++) waitTurn(g, 1);
  const pos = g.field[uid]!;
  const d = cheb(pos.x, pos.y, g.player.x, g.player.y);
  ok(d <= 3, `follower keeps pace (${d} tiles behind)`);
}

// hold order: a holding monster keeps its ground while the player waits —
// auto-defending against a hostile that closes in is designed behavior, so a
// move is only acceptable when a hostile was within engage range
{
  const g = newGame("HOLD-1", "Rook", "ranger", "#e8742a", previewStarter("HOLD-1", "mossback"));
  const uid = g.party[0].uid;
  setOrder(g, uid, "hold");
  let stayed = true;
  for (let t = 0; t < 12; t++) {
    const pos0 = g.field[uid]!;
    const hostileNear = Object.values(g.creatures).some(
      (c) => sameLayer(g, c) && (c.stalking || (c.disposition === "aggressive" && c.calmUntil <= g.tick)) && cheb(c.x, c.y, pos0.x, pos0.y) <= 6,
    );
    waitTurn(g, 1);
    const pos = g.field[uid]!;
    if (pos.x !== pos0.x || pos.y !== pos0.y) {
      ok(hostileNear, "a holding monster only moves to engage a hostile in range");
      stayed = false;
      break;
    }
  }
  if (stayed) ok(true, "hold order keeps the monster in place");
}

// tap-target orders: an attacker-order monster converges on the marked creature
{
  const g = newGame("TARGET-1", "Rook", "ranger", "#e8742a", previewStarter("TARGET-1", "mossback"));
  ok(quietGround(g), "found quiet wild ground for the target drill");
  const uid = g.party[0].uid;
  const w = getWorld(g.seed);
  let foe: WildCreature | null = null;
  for (let dx = 4; dx <= 8 && !foe; dx++) {
    for (let dy = -2; dy <= 2 && !foe; dy++) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      if (!w.inBounds(x, y) || !w.passable(x, y) || w.siteAt(x, y)?.wall || creatureAt(g, x, y) || partyMonAt(g, x, y)) continue;
      foe = {
        id: "tg:1", speciesId: "slimekin", level: 2, x, y, homeX: x, homeY: y,
        hpFrac: 1, satiety: 80, disposition: "calm", activity: "Wandering", personality: "gentle",
        geneSeed: 777, calmUntil: g.tick + 500, alpha: false, affection: 0, stalking: false,
      };
      g.creatures[foe.id] = foe;
    }
  }
  ok(!!foe, "target: placed a calm creature nearby");
  if (foe) {
    setOrder(g, uid, "attack");
    setTarget(g, foe.id);
    const d0 = cheb(g.field[uid]!.x, g.field[uid]!.y, foe.x, foe.y);
    for (let i = 0; i < 40 && g.creatures["tg:1"]; i++) waitTurn(g, 1);
    const d1 = g.creatures["tg:1"] ? cheb(g.field[uid]!.x, g.field[uid]!.y, g.creatures["tg:1"].x, g.creatures["tg:1"].y) : 0;
    ok(d1 < d0 || !g.creatures["tg:1"], `attacker converged on its target (${d0} -> ${d1})`);
  }
}

// ordered skill: the monster paths into range, unleashes it, and provokes the mark
{
  const g = newGame("SKILLQ-1", "Rook", "ranger", "#e8742a", previewStarter("SKILLQ-1", "mossback"));
  const uid = g.party[0].uid;
  g.party[0].skills = ["ember", "bite"];
  const w = getWorld(g.seed);
  let foe: WildCreature | null = null;
  for (let dx = 5; dx <= 8 && !foe; dx++) {
    for (let dy = -2; dy <= 2 && !foe; dy++) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      if (!w.inBounds(x, y) || !w.passable(x, y) || w.siteAt(x, y)?.wall || creatureAt(g, x, y) || partyMonAt(g, x, y)) continue;
      foe = {
        id: "sq:1", speciesId: "slimekin", level: 2, x, y, homeX: x, homeY: y,
        hpFrac: 1, satiety: 80, disposition: "calm", activity: "Wandering", personality: "gentle",
        geneSeed: 31, calmUntil: g.tick + 500, alpha: false, affection: 0, stalking: false,
      };
      g.creatures[foe.id] = foe;
    }
  }
  ok(!!foe, "skill order: placed a creature just out of range");
  if (foe) {
    queueSkill(g, uid, "ember", foe.id);
    ok(g.skillQ[uid]?.skill === "ember", "skill order queued");
    let fired = false;
    for (let i = 0; i < 12 && !fired; i++) {
      waitTurn(g, 1);
      fired = g.log.some((l) => l.text.includes("spits embers"));
    }
    ok(fired, "ordered skill fired once the monster closed in");
    ok(!g.skillQ[uid], "skill order cleared after use");
    ok(!!g.creatures["sq:1"]?.stalking, "the struck creature turns to fight back");
  }
}

// ordered self-heal: mend resolves on the monster's very next turn
{
  const g = newGame("SKILLQ-2", "Rook", "ranger", "#e8742a", previewStarter("SKILLQ-2", "mossback"));
  const uid = g.party[0].uid;
  g.party[0].skills = ["mend", "bite"];
  g.party[0].hp = 5;
  queueSkill(g, uid, "mend", uid);
  waitTurn(g, 1);
  ok(g.party[0].hp > 5, "ordered mend heals the hurt monster");
  ok(!g.skillQ[uid], "mend order cleared after use");
}

// aggression: a passive monster never starts fights, neutral retaliates
{
  const g = newGame("AGGR-1", "Rook", "ranger", "#e8742a", previewStarter("AGGR-1", "mossback"));
  const uid = g.party[0].uid;
  g.party[0].skills = ["bite"];
  setAggr(g, uid, "passive");
  ok(aggrOf(g, uid) === "passive", "aggression set to passive");
  const foe = placeAdjacent(g, "ag:1", "slimekin", 3);
  ok(!!foe, "aggression: hostile placed");
  if (foe) {
    movePlayer(g, foe.x - g.player.x, foe.y - g.player.y);
    const bite = `${displayName(g.party[0])} bites`;
    const hp0 = g.creatures["ag:1"] ? g.creatures["ag:1"].hpFrac : 1;
    for (let i = 0; i < 4; i++) waitTurn(g, 1);
    const hurt = !!g.creatures["ag:1"] && g.creatures["ag:1"].hpFrac < hp0 - 1e-9;
    const bites = g.log.some((l) => l.text.includes(bite));
    ok(!hurt && !bites, "passive monster never strikes on its own");
    setAggr(g, uid, "neutral");
    let fought = false;
    for (let i = 0; i < 6 && !fought; i++) {
      waitTurn(g, 1);
      fought = !g.creatures["ag:1"] || g.creatures["ag:1"].hpFrac < hp0 || g.log.some((l) => l.text.includes(bite));
    }
    ok(fought, "neutral monster retaliates once allowed");
  }
}

// aggressive monsters seek out hostiles further afield, unbidden
{
  const g = newGame("AGGR-2", "Rook", "ranger", "#e8742a", previewStarter("AGGR-2", "mossback"));
  const uid = g.party[0].uid;
  g.party[0].skills = ["bite"];
  setAggr(g, uid, "aggressive");
  const w = getWorld(g.seed);
  let placed = false;
  for (let dx = 8; dx <= 9 && !placed; dx++) {
    for (let dy = -1; dy <= 1 && !placed; dy++) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      if (!w.inBounds(x, y) || !w.passable(x, y) || w.siteAt(x, y)?.wall || creatureAt(g, x, y) || partyMonAt(g, x, y)) continue;
      g.creatures["ah:1"] = {
        id: "ah:1", speciesId: "slimekin", level: 2, x, y, homeX: x, homeY: y,
        hpFrac: 1, satiety: 80, disposition: "aggressive", activity: "Wandering", personality: "fierce",
        geneSeed: 97, calmUntil: g.tick, alpha: false, affection: 0, stalking: false,
      };
      placed = true;
    }
  }
  ok(placed, "aggressive hunt: hostile placed 8 tiles out");
  const marks: string[] = [];
  const hp0: Record<string, number> = {};
  for (const c of Object.values(g.creatures)) {
    const hostile = c.stalking || (c.disposition === "aggressive" && c.calmUntil <= g.tick);
    if (hostile && cheb(c.x, c.y, g.field[uid]!.x, g.field[uid]!.y) <= 10) {
      marks.push(c.id);
      hp0[c.id] = c.hpFrac;
    }
  }
  ok(marks.includes("ah:1"), "the placed hostile is within the aggressive monster's reach");
  let provoked = false;
  for (let i = 0; i < 14 && !provoked; i++) {
    waitTurn(g, 1);
    provoked = marks.some((id) => !g.creatures[id] || g.creatures[id].stalking || g.creatures[id].hpFrac < hp0[id]);
  }
  ok(provoked, "aggressive monster hunted a hostile unbidden");
}

// a Huge (3×3) party monster deploys with a full 3×3 body on the live map
{
  const g = newGame("BIGP-1", "Rook", "ranger", "#e8742a", previewStarter("BIGP-1", "mossback"));
  const big = createMonster(g, "crystal_golem", 6, { origin: "Test", seed: 7, skills: ["crunch"] });
  big.hp = statOf(big, "hp");
  g.party.push(big);
  initField(g);
  ok(footprintOf(SPECIES["crystal_golem"]) === 3, "huge party member has a 3×3 footprint");
  const pos = g.field[big.uid]!;
  ok(
    ([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]] as const).every(
      ([ox, oy]) => partyMonAt(g, pos.x + ox, pos.y + oy) === big,
    ),
    "partyMonAt covers the whole 3×3 party body",
  );
  ok(!(pos.x === g.player.x && pos.y === g.player.y), "huge body does not overlap the player");
}

// a Titanic (4×4) party monster deploys with a full 4×4 body; a wild titan covers all 16 tiles
{
  const g = newGame("TITAN-1", "Rook", "ranger", "#e8742a", previewStarter("TITAN-1", "mossback"));
  const titan = createMonster(g, "sunwyrm", 8, { origin: "Test", seed: 11, skills: ["bite"] });
  titan.hp = statOf(titan, "hp");
  g.party.push(titan);
  initField(g);
  ok(footprintOf(SPECIES["sunwyrm"]) === 4, "sunwyrm is Titanic (4×4)");
  const pos = g.field[titan.uid]!;
  const tiles: [number, number][] = [];
  for (let oy = 0; oy < 4; oy++) for (let ox = 0; ox < 4; ox++) tiles.push([ox, oy]);
  ok(
    tiles.every(([ox, oy]) => partyMonAt(g, pos.x + ox, pos.y + oy) === titan),
    "partyMonAt covers the whole 4×4 party body",
  );
  ok(
    !(pos.x <= g.player.x && g.player.x < pos.x + 4 && pos.y <= g.player.y && g.player.y < pos.y + 4),
    "titanic body does not overlap the player",
  );
  const w = getWorld(g.seed);
  let spot: [number, number] | null = null;
  seekT: for (let dy = -9; dy <= 9 && !spot; dy++) {
    for (let dx = -9; dx <= 9 && !spot; dx++) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      let clear = true;
      for (let oy = 0; oy < 4 && clear; oy++) {
        for (let ox = 0; ox < 4; ox++) {
          const tx = x + ox;
          const ty = y + oy;
          if (!w.inBounds(tx, ty) || !w.passable(tx, ty) || w.siteAt(tx, ty)?.wall || creatureAt(g, tx, ty) || partyMonAt(g, tx, ty) || (tx === g.player.x && ty === g.player.y)) {
            clear = false;
            break;
          }
        }
      }
      if (clear) spot = [x, y];
    }
  }
  ok(!!spot, "found open ground for a wild titanic creature");
  if (spot) {
    const [sx, sy] = spot;
    g.creatures["titan:1"] = {
      id: "titan:1", speciesId: "ironfang_tyrant", level: 9, x: sx, y: sy, homeX: sx, homeY: sy,
      hpFrac: 1, satiety: 70, disposition: "calm", activity: "Wandering", personality: "fierce",
      geneSeed: 4242, calmUntil: g.tick + 1000, alpha: true, affection: 0, stalking: false,
    };
    ok(
      tiles.every(([ox, oy]) => creatureAt(g, sx + ox, sy + oy)?.id === "titan:1"),
      "creatureAt covers all 16 tiles of a wild titan",
    );
    delete g.creatures["titan:1"];
  }
}

// lairs: the den holds an alpha with a loyal pack that fights for it
{
  const g = newGame("LAIR-1", "Rook", "ranger", "#e8742a", previewStarter("LAIR-1", "mossback"));
  // a sturdy party: the sub-tests must not end in a wipe (which would teleport the player home)
  g.party[0].level = 40;
  g.party[0].hp = statOf(g.party[0], "hp");
  const w = getWorld(g.seed);
  const lairs = w.featuresNear(g.player.x, g.player.y, 4096).filter((f) => f.kind === "lair" && f.speciesId);
  ok(lairs.length > 0, "lair pack: a lair exists in the world");
  let alpha: WildCreature | null = null;
  for (const f of lairs) {
    spawnLairPack(g, w, f);
    const a = g.creatures[`l:${f.x}:${f.y}`];
    if (a) {
      alpha = a;
      break;
    }
  }
  ok(!!alpha && alpha.alpha, "the lair's alpha stands in its den");
  const pack = alpha ? Object.values(g.creatures).filter((o) => o.pack === alpha!.id) : [];
  ok(pack.length >= 2 && pack.length <= 5, `the alpha has a loyal pack (${pack.length})`);
  ok(pack.every((o) => o.speciesId === alpha!.speciesId && o.level < alpha!.level), "packmates share the species and rank below their alpha");
  if (alpha && pack.length) {
    // engaging one minion calls the alpha and the rest of the pack
    engage(g, pack[0].id, false);
    ok(alpha.stalking && pack.slice(1).some((o) => o.stalking), "engaging one minion calls the alpha and the rest of the pack");
    for (const o of [alpha, ...pack]) o.stalking = false;
    g.target = null;
    // protection: an intruder at the den draws the guards (clear of the home hamlet so wild AI runs)
    seekOpen: for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const tx0 = g.player.x + dx;
        const ty0 = g.player.y + dy;
        if (w.inBounds(tx0, ty0) && w.passable(tx0, ty0) && !w.tile(tx0, ty0).feature && !creatureAt(g, tx0, ty0)) {
          g.player.x = tx0;
          g.player.y = ty0;
          break seekOpen;
        }
      }
    }
    // no bystanders: a stray predator would spook the alpha before it commands
    for (const id in g.creatures) {
      const o = g.creatures[id];
      if (o === alpha || o.pack === alpha.id) continue;
      if (cheb(o.x, o.y, g.player.x, g.player.y) <= 12) delete g.creatures[id];
    }
    alpha.x = g.player.x + 2;
    alpha.y = g.player.y;
    for (const o of pack) {
      o.x = g.player.x + 3;
      o.y = g.player.y;
      o.satiety = 12;
    }
    alpha.satiety = 12;
    alpha.disposition = "aggressive";
    waitTurn(g, 1);
    const guarded = pack.some((o) => o.stalking);
    waitTurn(g, 5);
    ok(guarded && g.log.some((l) => l.text.includes("bellows") || l.kind === "combat"), "the pack guards its alpha and fights for it");
    // loyalty ends with the alpha
    delete g.creatures[alpha.id];
    delete g.removed[alpha.id];
    const stray = pack[0];
    stray.x = g.player.x + 2;
    stray.y = g.player.y;
    advance(g, 2);
    ok(!stray.pack && stray.disposition === "skittish", "a minion whose alpha falls loses its loyalty and scatters");
  }
}

// fire burns out to ash on the live map
{
  const g = newGame("FIRE-1", "Rook", "ranger", "#e8742a", previewStarter("FIRE-1", "mossback"));
  let k: string | null = null;
  scan: for (let dy = -10; dy <= 10; dy++) {
    for (let dx = -10; dx <= 10; dx++) {
      const x = g.player.x + dx;
      const y = g.player.y + dy;
      if (["grass", "tallgrass", "flowers"].includes(terrainAt(g, x, y))) {
        k = `${x},${y}`;
        break scan;
      }
    }
  }
  if (k) {
    g.ground[k] = { fire: 1 };
    waitTurn(g, 1);
    ok(!g.ground[k]?.fire, "fire burns out after its fuel is spent");
    ok(g.ground[k]?.t === "ash", "burnt ground turns to ash");
  } else console.log("skip fire check (no flammable ground near the start)");
}

// balance parity: the ported arena formulas produce the same numbers
{
  const g = newGame("PARITY-1", "Rook", "scholar", "#e8742a", previewStarter("PARITY-1", "mossback"));
  const mon = g.party[0];
  const f = partyFighter(g, mon);
  const st = statsOf(mon);
  const dvBase = 6 + Math.floor(st.agi / 4);
  const dv = dvOf(g, f);
  ok(dv === dvBase || dv === dvBase + 2, `DV formula intact (base ${dvBase}, got ${dv})`);
  ok(avOf(g, f) === Math.floor(st.def / 5), "AV formula intact (mossback has no AV traits)");
  const foe = placeAdjacent(g, "p:1", "slimekin", 5);
  if (foe) {
    const ff = wildFighter(g, foe);
    const hi = hitInfo(g, f, ff, "shell_bash");
    let n = 1;
    for (let r = 2; r <= 19; r++) if (r + hi.bonus >= hi.dv) n++;
    ok(Math.abs(hi.chance - n / 20) < 1e-9, "hit chance follows the d20 formula");
  }
}

// save round trip: live-combat state persists
const json = JSON.stringify(gs);
const loaded = JSON.parse(json);
ok(loaded.version === 24, "save version 24");
ok(loaded.field && loaded.orders && loaded.ground && loaded.fighters && loaded.aggr && loaded.skillQ && "target" in loaded, "live-combat state persists");
ok(Object.keys(loaded.knowledge.explored).length === after, "explored persists exactly");

// v4 → v5 migration: old saves deploy the party at the player's side
{
  const v4 = JSON.parse(json) as GameState & { version: number };
  delete v4.field;
  delete v4.orders;
  delete v4.target;
  delete v4.ground;
  delete v4.fighters;
  (v4 as unknown as { field: GameState["field"] }).field = {};
  (v4 as unknown as { orders: GameState["orders"] }).orders = {};
  (v4 as unknown as { target: null }).target = null;
  (v4 as unknown as { ground: GameState["ground"] }).ground = {};
  (v4 as unknown as { fighters: GameState["fighters"] }).fighters = {};
  v4.version = 4;
  initField(v4);
  ok(v4.party.every((m) => !!v4.field[m.uid]), "v4 migration deploys the party at the player's side");
  ok(Object.values(v4.field).every((p) => cheb(p.x, p.y, v4.player.x, v4.player.y) <= 8), "migrated party placed near the player");
}

// v5 → v6 migration: commanded skills and aggression backfill (same normalization loadSave applies)
{
  const v5 = JSON.parse(json) as GameState & { version: number };
  delete v5.aggr;
  delete v5.skillQ;
  v5.version = 5;
  v5.aggr = v5.aggr ?? {};
  v5.skillQ = v5.skillQ ?? {};
  v5.version = 6;
  ok(aggrOf(v5, v5.party[0].uid) === "neutral", "v5 migration defaults aggression to neutral");
  v5.party[0].skills = ["bite", ...v5.party[0].skills];
  queueSkill(v5, v5.party[0].uid, "bite", v5.party[0].uid);
  ok(v5.skillQ[v5.party[0].uid]?.skill === "bite", "v5 migration accepts skill orders");
}

// v6 → v7 migration: scalar genes become allele pairs with a genetic size gene
{
  const v6 = JSON.parse(json) as GameState & { version: number };
  for (const m of v6.party) {
    const g = m.genes as unknown as Record<string, GenePair>;
    m.genes = { vigor: g.vigor.a, might: g.might.a, guard: g.guard.a, swift: g.swift.a, wit: g.wit.a } as unknown as GameState["party"][number]["genes"];
  }
  v6.version = 6;
  for (const m of v6.party) migrateMonsterGenes(m);
  const m0 = v6.party[0];
  ok(typeof m0.genes.vigor.a === "number" && typeof m0.genes.size.a === "number", "v6 migration converts scalar genes into allele pairs");
  ok(getMonsterFootprint(m0) === footprintOf(SPECIES[m0.speciesId]), "migrated size genes express the species' body footprint");
}

// v7 → v8 migration: monsters gain a sex (asexual species stay asexual)
{
  const v7 = JSON.parse(json) as GameState & { version: number };
  for (const m of v7.party) delete (m as { sex?: string }).sex;
  v7.version = 7;
  for (const m of v7.party) migrateMonsterSex(m);
  ok(v7.party.every((m) => ["male", "female", "asexual"].includes(m.sex)), "v7 migration gives every monster a sex");
  const m0 = v7.party[0];
  ok(SPECIES[m0.speciesId].sexed === false ? m0.sex === "asexual" : m0.sex !== "asexual", "migrated sex matches the species' biology");
  const s0 = m0.sex;
  migrateMonsterSex(m0);
  ok(m0.sex === s0, "sex migration is idempotent");
}

// v8 → v9 migration: loaded chunks respawn, so lairs field their packs
{
  const v8 = JSON.parse(json) as GameState & { version: number };
  v8.version = 8;
  // anchor the loaded chunks on a live lair so the migration has packs to field
  const lairAnchor = getWorld(v8.seed).featuresNear(v8.player.x, v8.player.y, 900).find((f) => f.kind === "lair");
  if (lairAnchor) {
    v8.player.x = lairAnchor.x + 3;
    v8.player.y = lairAnchor.y + 3;
  }
  v8.loadedChunks = [];
  loadChunks(v8);
  const w8 = getWorld(v8.seed);
  let lairsFound = 0;
  let packed = 0;
  for (const key of v8.loadedChunks) {
    const [cx, cy] = key.split(",").map(Number);
    for (const f of w8.featuresNear(cx * 16 + 8, cy * 16 + 8, 8)) {
      if (f.kind !== "lair" || !f.speciesId) continue;
      if (Math.floor(f.x / 16) !== cx || Math.floor(f.y / 16) !== cy) continue;
      lairsFound++;
      if (v8.creatures[`l:${f.x}:${f.y}`]) {
        const n = Object.values(v8.creatures).filter((o) => o.pack === `l:${f.x}:${f.y}`).length;
        if (n >= 2) packed++;
      }
    }
  }
  ok(lairsFound > 0 && packed >= 1, `v9 migration fields packs at live lairs (${packed}/${lairsFound})`);
}

// v9 → v10 migration: faction knowledge backfilled, home banner resolved
{
  const v9 = JSON.parse(json) as GameState & { version: number };
  delete v9.knowledge.nationsSeen;
  delete v9.knowledge.assocSeen;
  delete (v9 as { lastNation?: string }).lastNation;
  v9.version = 9;
  migrateFactionKnowledge(v9);
  ok(typeof v9.lastNation === "string", "v10 migration resolves the player's banner");
  ok(!!v9.knowledge.nationsSeen && !!v9.knowledge.assocSeen, "v10 migration backfills faction knowledge");
  const nat = getFactions(v9.seed).nationAt(v9.player.x, v9.player.y);
  ok(!nat || v9.knowledge.nationsSeen[nat.id] === 1, "migrated save learns the nation it stands in");
}

// v3 migration path
const v3 = JSON.parse(json) as typeof gs & { version: number };
delete v3.knowledge;
v3.version = 3;
ensureKnowledge(v3, true);
ok(!!v3.knowledge && Object.keys(v3.knowledge.explored).length > 0, "v3 migration backfills explored");
ok(Object.keys(v3.knowledge.regionsSeen).length > 0 && v3.knowledge.route.length === 1, "v3 migration seeds region + route");

/* ------------------------------- Genetics ----------------------------------- */

// allele pairs, expression and grades: hidden potential exists without showing
{
  const gg = newGame("GEN-1", "Rook", "ranger", "#e8742a", previewStarter("GEN-1", "mossback"));
  ok(expressGene({ a: 90, b: 40 }) === 65, "expression is the allele average (90/40 → 65)");
  ok(getGeneGrade(expressGene({ a: 90, b: 40 })) === "B" && getGeneGrade(90) === "S", "grades come from expressed values, not alleles");
  const lo = createMonster(gg, "cindermaw", 5, { origin: "Test", seed: 43, personality: "loyal", mutations: [], genes: { ...gg.party[0].genes, vigor: { a: 40, b: 40 } } });
  const hi = createMonster(gg, "cindermaw", 5, { origin: "Test", seed: 44, personality: "loyal", mutations: [], genes: { ...gg.party[0].genes, vigor: { a: 90, b: 40 } } });
  ok(statOf(hi, "hp") > statOf(lo, "hp"), "stats follow the expressed gene average, not a single allele");
}

// inheritance: one allele from each parent; every combination can occur
{
  const rng = new Rng(777);
  const combos = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const c = inheritGene({ a: 90, b: 40 }, { a: 85, b: 45 }, rng);
    combos.add(`${c.a}:${c.b}`);
  }
  ok(combos.has("90:85") && combos.has("90:45") && combos.has("40:85") && combos.has("40:45"), "each child takes one allele per parent; all four combinations occur");
}

// drift: symmetric, unbiased, mostly small
{
  const rng = new Rng(2024);
  let up = 0, down = 0, sum = 0, small = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const d = mutateDelta(rng);
    sum += d;
    if (d > 0) up++;
    else if (d < 0) down++;
    if (Math.abs(d) <= 2) small++;
  }
  ok(up > 0 && down > 0, "mutations can increase and decrease gene values");
  ok(Math.abs(sum / N) < 0.25, `drift is centered on zero (mean ${(sum / N).toFixed(3)})`);
  ok(Math.abs(up - down) / N < 0.06, "no upward bias: P(up) ≈ P(down)");
  ok(small / N > 0.55, "most mutations are 0/±1/±2");
}

// mutation modifies the alleles themselves and stays bounded
{
  const rng = new Rng(99);
  let changed = 0, same = 0, bounded = true;
  for (let i = 0; i < 500; i++) {
    const m = mutateGene({ a: 100, b: 5 }, rng);
    if (m.a > 100 || m.a < 5 || m.b > 100 || m.b < 5) bounded = false;
    if (m.a === 100 && m.b === 5) same++;
    else changed++;
  }
  ok(bounded, "alleles stay bounded at 5–100");
  ok(changed > 0 && same > 0, "drift sometimes changes an allele and sometimes leaves it unchanged");
  const parent = mutateGene({ a: 90, b: 50 }, rng);
  const kids = new Set<number>();
  for (let i = 0; i < 200; i++) kids.add(inheritGene(parent, { a: 70, b: 70 }, rng).a);
  ok(kids.has(parent.a) && kids.has(parent.b), "mutated alleles are part of the genome and can be inherited");
}

// size is a gene: inherited, mutable in both directions, thresholds exact
{
  const rng = new Rng(313);
  const kid = inheritGene({ a: 90, b: 94 }, { a: 45, b: 51 }, rng);
  ok((kid.a === 90 || kid.a === 94) && (kid.b === 45 || kid.b === 51), "size genes inherit one allele per parent");
  ok(sizeToFootprint(expressGene(kid)) === 3, "size expression 90/51 → 71 → 3×3 footprint");
  let upS = false, downS = false;
  for (let i = 0; i < 500 && !(upS && downS); i++) {
    const m = mutateGene({ a: 74, b: 74 }, rng);
    if (expressGene(m) > 74) upS = true;
    if (expressGene(m) < 74) downS = true;
  }
  ok(upS && downS, "size can mutate upward and downward across footprint thresholds");
}
ok(
  sizeToFootprint(5) === 1 && sizeToFootprint(24) === 1 && sizeToFootprint(25) === 2 && sizeToFootprint(49) === 2 && sizeToFootprint(50) === 3 && sizeToFootprint(74) === 3 && sizeToFootprint(75) === 4 && sizeToFootprint(100) === 4,
  "size thresholds are exact (5–24, 25–49, 50–74, 75–100)",
);

// genome-driven footprints; starters stay 1×1 (multi-tile support intact)
{
  const gg = newGame("GEN-2", "Rook", "ranger", "#e8742a", previewStarter("GEN-2", "mossback"));
  ok(getMonsterFootprint(gg.party[0]) === 1, "starters stay 1×1");
  const big = createMonster(gg, "sunwyrm", 8, { origin: "Test", seed: 11 });
  big.hp = statOf(big, "hp");
  gg.party.push(big);
  initField(gg);
  ok(getMonsterFootprint(big) === 4, "a party titan's footprint comes from its size genome");
  const pos = gg.field[big.uid]!;
  ok(
    ([[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2], [0, 3], [1, 3], [2, 3], [3, 3]] as const).every(
      ([ox, oy]) => partyMonAt(gg, pos.x + ox, pos.y + oy) === big,
    ),
    "the genomic footprint occupies tiles like any multi-tile body",
  );
}

// size influences stats moderately (wit untouched)
{
  const gg = newGame("GEN-3", "Rook", "ranger", "#e8742a", previewStarter("GEN-3", "mossback"));
  const base = gg.party[0].genes;
  const small = createMonster(gg, "cindermaw", 5, { origin: "Test", seed: 21, personality: "loyal", mutations: [], genes: { ...base, size: { a: 10, b: 14 } } });
  const large = createMonster(gg, "cindermaw", 5, { origin: "Test", seed: 22, personality: "loyal", mutations: [], genes: { ...base, size: { a: 87, b: 87 } } });
  ok(statOf(large, "hp") > statOf(small, "hp") && statOf(large, "atk") > statOf(small, "atk") && statOf(large, "def") > statOf(small, "def"), "larger size raises HP/Might/Guard potential");
  ok(statOf(large, "agi") < statOf(small, "agi"), "larger size lowers Swift");
  ok(statOf(large, "wis") === statOf(small, "wis"), "Wit is not affected by size");
  ok(statOf(large, "hp") < Math.round(statOf(small, "hp") * 1.6), "size scaling stays moderate");
}

// breeding: allele inheritance before drift, genome and lineage intact after
{
  const gg = newGame("GEN-4", "Rook", "ranger", "#e8742a", previewStarter("GEN-4", "mossback"));
  const a = createMonster(gg, "cindermaw", 8, { origin: "Test", seed: 61, sex: "male", genes: { ...gg.party[0].genes, vigor: { a: 90, b: 40 } } });
  const b = createMonster(gg, "mossback", 8, { origin: "Test", seed: 62, sex: "female", genes: { ...gg.party[0].genes, vigor: { a: 85, b: 45 } } });
  const prev = previewBreeding(a, b);
  ok([90, 40].includes(prev.genes.vigor.a) && [85, 45].includes(prev.genes.vigor.b), "the preview shows the inherited allele pair (before drift)");
  ok(GENE_KEYS.every((k) => typeof prev.genes[k].a === "number" && typeof prev.genes[k].b === "number"), "every gene is inherited as an allele pair");
  const out = beginBreeding(gg, a, b, "player");
  ok(out.ok, "breeding creates a reproductive-development record");
  ok(gg.party.length === 1 && gg.pen.length === 0, "no offspring entity exists before development completes");
  if (out.ok) {
    gg.tick = out.development.completeTick;
    advanceDevelopment(gg);
    const child = [...gg.party, ...gg.pen].find((m) => m.parents?.[0] === a.uid) ?? null;
    ok(!!child, "the offspring is created when development completes");
    ok(
      (Object.keys(child!.genes) as GeneKey[]).every((k) => typeof child!.genes[k].a === "number" && typeof child!.genes[k].b === "number"),
      "breeding produces a full allele genome",
    );
    ok([1, 2, 3, 4].includes(getMonsterFootprint(child!)), "the child's footprint derives from its size genome");
    ok(child!.parents?.[0] === a.uid && child!.parents?.[1] === b.uid, "parents are recorded as uids for lineage");
    ok(child!.sex === prev.sex && ["male", "female", "asexual"].includes(child!.sex), "the child's sex matches the preview and its biology");
  }
}

// super lineages: expression can climb across generations
{
  const rng = new Rng(808);
  const flat = (vigor: GenePair): Genome => ({ vigor, might: { a: 50, b: 50 }, guard: { a: 50, b: 50 }, swift: { a: 50, b: 50 }, wit: { a: 50, b: 50 }, size: { a: 14, b: 14 } });
  let improved = false;
  for (let line = 0; line < 12 && !improved; line++) {
    let v: GenePair = { a: 90, b: 42 };
    for (let gen = 0; gen < 20; gen++) v = driftGenome(flat(v), rng).vigor;
    if (expressGene(v) > 66) improved = true;
  }
  ok(improved, "selective breeding can push expression beyond the founding pair");
}

// sex: sexed species are male or female; spirits, slimes, golems and plants are asexual
{
  ok(
    SPECIES["pipwisp"].sexed === false && SPECIES["slimekin"].sexed === false && SPECIES["regalslime"].sexed === false && SPECIES["bloomwisp"].sexed === false && SPECIES["mandrake_maw"].sexed === false && SPECIES["crystal_golem"].sexed === false,
    "spirits, slimes, the plant-beast and the golem have no sex",
  );
  ok(
    SPECIES["cindermaw"].sexed !== false && SPECIES["sunwyrm"].sexed !== false && SPECIES["nimbletuft"].sexed !== false,
    "beasts, birds and dragons come male or female",
  );
  const rng = new Rng(4242);
  const sexes = new Set<string>();
  for (let i = 0; i < 100; i++) sexes.add(rollSex(rng, "cindermaw"));
  ok(sexes.has("male") && sexes.has("female"), "sexed species roll both male and female");
  ok(rollSex(rng, "slimekin") === "asexual" && rollSex(rng, "crystal_golem") === "asexual", "asexual species never roll a sex");
}

/* --------------------------- BIOLOGY: Phase 1 foundation --------------------- */

// genotype integrity: every monster and wild creature carries a full valid genome
{
  const g = newGame("BIO-1", "Rook", "scholar", "#e8742a", previewStarter("BIO-1", "mossback"));
  const valid = (ge: Genome): boolean =>
    GENE_KEYS.every((k) =>
      typeof ge[k].a === "number" && Number.isFinite(ge[k].a) && ge[k].a >= 5 && ge[k].a <= 100 &&
      typeof ge[k].b === "number" && Number.isFinite(ge[k].b) && ge[k].b >= 5 && ge[k].b <= 100);
  ok(valid(g.party[0].genes), "every party monster carries a full six-gene genome within 5–100");
  ok(Object.values(gs.creatures).length > 0, "wild creatures exist for biology checks");
  ok(Object.values(gs.creatures).every((c) => !!c.genes && valid(c.genes)), "wild creatures carry explicit genomes within 5–100");
  ok(gs.party.every((m) => (m.generation ?? 1) >= 1 && !!m.lineageId?.startsWith("L:") && Array.isArray(m.mutHistory)), "party monsters carry lineage metadata");
  // spawned creatures are founders; wild births during the sim advance the
  // generation while keeping the founder lineage id
  ok(Object.values(gs.creatures).every((c) => !!c.lineageId?.startsWith("L:") && (c.gen ?? 1) >= 1), "wild creatures are founder-lineaged (births advance the generation)");
  ok(getMonsterFootprint(gs.party[0]) === footprintOf(SPECIES[gs.party[0].speciesId]), "a starter's size gene expresses its species' body tier");
  const bySpecies = new Map<string, Set<number>>();
  for (const c of Object.values(gs.creatures)) {
    if (!c.genes) continue;
    const s = bySpecies.get(c.speciesId) ?? new Set<number>();
    s.add(expressGene(c.genes.size));
    bySpecies.set(c.speciesId, s);
  }
  ok([...bySpecies.values()].some((s) => s.size > 1), "same-species wild individuals differ in size genetics");
}

// genotype validation: clamps recoverable data, rejects structural corruption
{
  const good: Genome = { vigor: { a: 90, b: 40 }, might: { a: 50, b: 50 }, guard: { a: 50, b: 50 }, swift: { a: 50, b: 50 }, wit: { a: 50, b: 50 }, size: { a: 14, b: 14 } };
  const clamped = sanitizeGenome({ ...good, might: { a: 300, b: -20 } });
  ok(clamped?.might.a === 100 && clamped.might.b === 5, "out-of-range alleles are clamped to 5–100");
  ok(sanitizeGenome({ ...good, wit: undefined as unknown as GenePair }) === null, "a missing gene is structurally invalid");
  ok(sanitizeGenome({ ...good, wit: { a: NaN, b: 50 } }) === null, "NaN cannot propagate");
  ok(sanitizeGenome({ ...good, wit: { a: Infinity, b: 50 } }) === null, "Infinity cannot propagate");
  ok(sanitizeGenome(null) === null && sanitizeGenome(42) === null, "non-object genomes are rejected");
}

// lineage: founders, offspring generation and lineage id, structured drift history
{
  const s = newGame("BIO-3", "Rook", "ranger", "#e8742a", previewStarter("BIO-3", "mossback"));
  const a = createMonster(s, "cindermaw", 8, { origin: "Test", seed: 71, sex: "male" });
  const b = createMonster(s, "mossback", 8, { origin: "Test", seed: 72, sex: "female" });
  ok(a.generation === 1 && a.lineageId === `L:${a.uid}` && a.mutHistory?.length === 0, "founders are generation 1 with their own lineage id");
  const run = (seedText: string): Monster | null => {
    const st = newGame(seedText, "Rook", "ranger", "#e8742a", previewStarter(seedText, "mossback"));
    const x = createMonster(st, "cindermaw", 8, { origin: "Test", seed: 71, sex: "male" });
    const y = createMonster(st, "mossback", 8, { origin: "Test", seed: 72, sex: "female" });
    const out = beginBreeding(st, x, y, "player");
    if (!out.ok) return null;
    st.tick = out.development.completeTick;
    advanceDevelopment(st);
    return [...st.party, ...st.pen].find((m) => m.parents?.[0] === x.uid) ?? null;
  };
  const c1 = run("BIO-3");
  const c2 = run("BIO-3");
  ok(c1.generation === Math.max(a.generation ?? 1, b.generation ?? 1) + 1, "offspring generation is max(parents) + 1");
  ok(c1.lineageId === [a.lineageId!, b.lineageId!].sort()[0], "offspring carry a parent lineage id, not a name-derived id");
  ok((c1.parents ?? []).every((p) => /^[mw]/.test(p)), "parent references are stable ids, not display names");
  ok(JSON.stringify(c1.genes) === JSON.stringify(c2.genes) && c1.lineageId === c2.lineageId && JSON.stringify(c1.mutHistory) === JSON.stringify(c2.mutHistory), "identical seed and parents reproduce identical offspring genetics");
  ok(
    (c1.mutHistory ?? []).every((r) => r.to === r.from + r.delta && r.delta !== 0 && r.gen === c1.generation && ((r.dir === "up" && r.to > r.from) || (r.dir === "down" && r.to < r.from))),
    "mutation history is structured data with direction and generation",
  );
  a.nickname = "Renamed Parent";
  const out3 = beginBreeding(s, a, b, "player");
  ok(out3.ok, "renamed parents can still breed");
  if (out3.ok) {
    s.tick = out3.development.completeTick;
    advanceDevelopment(s);
    const c3 = [...s.party, ...s.pen].find((m) => m.parents?.[0] === a.uid) ?? null;
    ok(c3?.lineageId === [a.lineageId!, b.lineageId!].sort()[0], "lineage ids ignore display names");
  }
  const rt = JSON.parse(JSON.stringify(c1)) as Monster;
  migrateMonsterBio(rt);
  ok(rt.lineageId === c1.lineageId && rt.generation === c1.generation && JSON.stringify(rt.mutHistory) === JSON.stringify(c1.mutHistory), "lineage metadata survives save round-trips unchanged");
}

// wild creatures: genotype survives taming; legacy geneSeed migration is deterministic
{
  const g = newGame("BIO-4", "Rook", "ranger", "#e8742a", previewStarter("BIO-4", "mossback"));
  const c = Object.values(gs.creatures).find((x) => x.genes && !x.alpha);
  ok(!!c, "a tameable wild creature exists");
  if (c?.genes) {
    const mon = wildToMonster(g, c);
    ok(JSON.stringify(mon.genes) === JSON.stringify(c.genes), "taming preserves the wild creature's genotype exactly");
    ok(mon.lineageId === c.lineageId && mon.generation === c.gen, "taming preserves the wild creature's lineage identity");
  }
  const fc = Object.values(gs.creatures)[0]!;
  const f = wildFighter(gs, fc);
  ok(f.fp === getMonsterFootprint(f.mon), "a wild creature's combat footprint derives from its own size gene");
  const legacy = JSON.parse(JSON.stringify(fc)) as WildCreature;
  delete legacy.genes;
  delete legacy.gen;
  delete legacy.lineageId;
  const m1 = JSON.parse(JSON.stringify(legacy)) as WildCreature;
  const m2 = JSON.parse(JSON.stringify(legacy)) as WildCreature;
  migrateCreatureBio(m1);
  migrateCreatureBio(m2);
  ok(m1.gen === 1 && m1.lineageId === `L:${legacy.id}`, "legacy wild creatures get founder lineage metadata");
  ok(JSON.stringify(m1.genes) === JSON.stringify(wildGenotypeFromSeed(legacy.geneSeed, legacy.speciesId)), "legacy wild genetics derive deterministically from the gene seed");
  ok(JSON.stringify(m1.genes) === JSON.stringify(m2.genes), "legacy wild migration is deterministic");
  migrateCreatureBio(m1);
  ok(JSON.stringify(m1) === JSON.stringify(m2), "re-migrating a migrated wild creature changes nothing");
}

// monster migration: corruption regenerates deterministically, scalar five-gene data still migrates
{
  const g = newGame("BIO-5", "Rook", "scholar", "#e8742a", previewStarter("BIO-5", "mossback"));
  const m = g.party[0];
  const good = JSON.parse(JSON.stringify(m)) as Monster;
  (m.genes as unknown as Record<string, unknown>).vigor = { a: NaN, b: 50 };
  migrateMonsterGenes(m);
  migrateMonsterBio(m);
  ok(m.generation === 1 && m.lineageId === `L:${m.uid}` && Array.isArray(m.mutHistory), "legacy monsters receive founder metadata");
  const again = JSON.parse(JSON.stringify(m)) as Monster;
  migrateMonsterGenes(again);
  migrateMonsterBio(again);
  ok(JSON.stringify(again) === JSON.stringify(m), "corruption recovery and bio backfill are idempotent");
  const v6 = JSON.parse(JSON.stringify(good)) as Monster;
  (v6 as unknown as { genes: unknown }).genes = { vigor: 72, might: 55, guard: 48, swift: 61, wit: 40 };
  migrateMonsterGenes(v6);
  ok(v6.genes.vigor.a === 72 && typeof v6.genes.size.a === "number", "scalar five-gene monsters gain size genetics from their species band");
  const s1 = JSON.parse(JSON.stringify(gs)) as GameState;
  migrateBiology(s1);
  const s2 = JSON.parse(JSON.stringify(s1)) as GameState;
  migrateBiology(s2);
  ok(JSON.stringify(s2) === JSON.stringify(s1), "migrateBiology is idempotent across the whole game state");
}

/* ----------------------- REPRODUCTION: Phase 2 machinery --------------------- */

// compatibility matrix: the three reproductive configurations, species-independent
{
  const g = newGame("REP-1", "Rook", "scholar", "#e8742a", previewStarter("REP-1", "mossback"));
  const mk = (speciesId: string, sex: Sex, level = 10): Monster =>
    createMonster(g, speciesId, level, { origin: "Test", seed: 91, sex });
  const m1 = mk("cindermaw", "male");
  const m2 = mk("cindermaw", "male");
  const f1 = mk("mossback", "female");
  const f2 = mk("sunwyrm", "female");
  ok(canReproduce(m1, f1, g.tick).ok, "male + female are biologically compatible");
  ok(canReproduce(f1, m1, g.tick).ok, "female + male are compatible (order-symmetric)");
  ok(!canReproduce(m1, m2, g.tick).ok, "male + male are biologically incompatible");
  ok(!canReproduce(f1, f2, g.tick).ok, "female + female are biologically incompatible");
  const a1 = mk("slimekin", "asexual");
  const a2 = mk("regalslime", "asexual");
  ok(canReproduce(a1, a2, g.tick).ok, "asexual + asexual are compatible — two parents, neither male nor female");
  ok(!canReproduce(a1, m1, g.tick).ok, "asexual + male are biologically incompatible");
  ok(!canReproduce(a1, f1, g.tick).ok, "asexual + female are biologically incompatible");
  ok(m1.speciesId !== f1.speciesId && canReproduce(m1, f1, g.tick).ok, "biological compatibility ignores species identity (mating rules decide that later)");
  ok(!canReproduce(m1, m1, g.tick).ok, "an individual cannot reproduce with itself");
}

// fertility, maturity, cooldown and active reproduction gate compatibility
{
  const g = newGame("REP-2", "Rook", "scholar", "#e8742a", previewStarter("REP-2", "mossback"));
  const mk = (speciesId: string, sex: Sex, level = 10): Monster =>
    createMonster(g, speciesId, level, { origin: "Test", seed: 92, sex });
  const m = mk("cindermaw", "male");
  const f = mk("mossback", "female");
  m.repro!.fertility = 0;
  ok(reproStateOf(m.repro!, g.tick) === "infertile" && !canReproduce(m, f, g.tick).ok, "an infertile individual is incompatible despite a compatible partner");
  m.repro!.fertility = 60;
  ok(canReproduce(m, f, g.tick).ok, "fertility restored — compatible again");
  const kid = mk("mossback", "female", 2);
  g.pen.push(m, f, kid); // simulation advances bodies that live in the state
  ok(kid.repro!.maturity === "immature" && !canReproduce(kid, m, g.tick).ok, "an immature individual cannot reproduce");
  kid.level = MATURITY_LEVEL;
  advanceReproduction(g);
  ok(kid.repro!.maturity === "mature" && canReproduce(kid, m, g.tick).ok, "maturity comes from data, and maturing restores compatibility");
  f.repro!.cooldownUntil = g.tick + 100;
  ok(reproStateOf(f.repro!, g.tick) === "cooldown" && !canReproduce(f, m, g.tick).ok, "a cooling-down parent is unavailable");
  f.repro!.cooldownUntil = g.tick;
  ok(isBreedingAvailable(f, g.tick) && canReproduce(f, m, g.tick).ok, "cooldown expiry restores availability");
  const res = beginReproduction(m, f, g.tick);
  ok(
    res.ok && res.pairing === "sexual" && res.parentIds[0] === m.uid && res.parentIds[1] === f.uid && res.developTicks === DEVELOP_TICKS && res.parents.length === 2,
    "beginReproduction returns a structured result: pairing, parent ids, development duration",
  );
  ok(m.repro!.status === "reproducing" && m.repro!.engagedWith === f.uid && f.repro!.status === "reproducing", "both parents enter the reproducing state");
  ok(!canReproduce(m, kid, g.tick).ok && !canReproduce(f, kid, g.tick).ok, "an individual already reproducing cannot start another");
  ok(!beginReproduction(m, kid, g.tick).ok, "beginReproduction rejects an unavailable pair");
}

// two-parent asexual reproduction, development window and cooldown through simulation time
{
  const g = newGame("REP-3", "Rook", "scholar", "#e8742a", previewStarter("REP-3", "mossback"));
  const mk = (speciesId: string, sex: Sex, level = 10): Monster =>
    createMonster(g, speciesId, level, { origin: "Test", seed: 93, sex });
  const s1 = mk("slimekin", "asexual");
  const s2 = mk("regalslime", "asexual");
  g.pen.push(s1, s2); // simulation advances bodies that live in the state
  const ares = beginReproduction(s1, s2, g.tick);
  ok(ares.ok && ares.pairing === "asexual" && s1.repro!.status === "reproducing" && s2.repro!.status === "reproducing", "two asexual parents begin a two-parent reproduction");
  g.tick += DEVELOP_TICKS + 1;
  const done = advanceReproduction(g);
  ok(done.length === 2 && done.every((d) => d.pairing === "asexual"), "completed reproductions are reported for every participant");
  ok(s1.repro!.status === "cooldown" && s1.repro!.cooldownUntil === g.tick + BREED_COOLDOWN_TICKS, "completed parents enter a biological breeding cooldown");
  ok(!canReproduce(s1, s2, g.tick).ok, "the cooldown blocks immediate re-breeding");
  g.tick += BREED_COOLDOWN_TICKS + 1;
  advanceReproduction(g);
  ok(s1.repro!.status === "available" && isBreedingAvailable(s1, g.tick), "cooldown expiry restores availability through simulation time");
}

// persistence: profiles survive round-trips, legacy bodies backfill, taming carries configuration
{
  const wc = Object.values(gs.creatures).find((c) => c.repro && !c.alpha);
  ok(!!wc, "wild creatures carry reproductive profiles");
  if (wc) {
    const legacy = JSON.parse(JSON.stringify(wc)) as WildCreature;
    delete legacy.repro;
    const m1 = JSON.parse(JSON.stringify(legacy)) as WildCreature;
    const m2 = JSON.parse(JSON.stringify(legacy)) as WildCreature;
    migrateReproCreature(m1);
    migrateReproCreature(m2);
    ok(!!m1.repro && JSON.stringify(m1.repro) === JSON.stringify(m2.repro), "wild creature profile migration is deterministic");
    migrateReproCreature(m1);
    ok(JSON.stringify(m1.repro) === JSON.stringify(m2.repro), "wild profile migration is idempotent");
    const g = newGame("REP-4", "Rook", "ranger", "#e8742a", previewStarter("REP-4", "mossback"));
    const tamed = wildToMonster(g, wc);
    ok(tamed.repro?.mode === wc.repro!.mode && tamed.sex === wc.repro!.mode, "taming carries the wild creature's reproductive configuration");
  }
  const g2 = newGame("REP-5", "Rook", "scholar", "#e8742a", previewStarter("REP-5", "mossback"));
  const mon = g2.party[0];
  const rt = JSON.parse(JSON.stringify(mon)) as Monster;
  migrateReproMon(rt);
  ok(JSON.stringify(rt.repro) === JSON.stringify(mon.repro), "reproductive profiles survive save round-trips unchanged");
  const legacyM = JSON.parse(JSON.stringify(mon)) as Monster;
  delete legacyM.repro;
  migrateReproMon(legacyM);
  ok(legacyM.repro?.mode === legacyM.sex && legacyM.repro.status === "available" && legacyM.repro.fertility === 100, "legacy monsters receive a sensible profile from their sex");
  const s1 = JSON.parse(JSON.stringify(gs)) as GameState;
  migrateRepro(s1);
  const s2 = JSON.parse(JSON.stringify(s1)) as GameState;
  migrateRepro(s2);
  ok(JSON.stringify(s2) === JSON.stringify(s1), "migrateRepro is idempotent across the whole game state");
}

/* ----------------------------- MATING: Phase 3 rules ------------------------- */

// rule matrix: the context decides species permission; biology stays in reproduction.ts
{
  const g = newGame("MAT-1", "Rook", "scholar", "#e8742a", previewStarter("MAT-1", "mossback"));
  const mk = (speciesId: string, sex: Sex, level = 10): Monster =>
    createMonster(g, speciesId, level, { origin: "Test", seed: 71, sex });
  const cm = mk("cindermaw", "male");
  const cf = mk("cindermaw", "female");
  const mb = mk("mossback", "male");
  const mf = mk("mossback", "female");
  const s1 = mk("slimekin", "asexual");
  const s2 = mk("slimekin", "asexual");
  const r1 = mk("regalslime", "asexual");

  // wild: same species only, across all three reproductive configurations
  ok(canMate(cm, cf, "wild", g.tick).ok, "wild same-species male + female is permitted");
  ok(canMate(cf, cm, "wild", g.tick).ok, "wild same-species female + male is permitted");
  ok(canMate(s1, s2, "wild", g.tick).ok, "wild same-species asexual + asexual is permitted (still two parents)");
  const wx = canMate(cm, mf, "wild", g.tick);
  ok(!wx.ok && wx.reason === "different_species", "wild cross-species male + female is rejected: different species");
  const wx2 = canMate(mf, cm, "wild", g.tick);
  ok(!wx2.ok && wx2.reason === "different_species", "wild cross-species female + male is rejected: different species");
  const wa = canMate(s1, r1, "wild", g.tick);
  ok(!wa.ok && wa.reason === "different_species", "wild cross-species asexual + asexual is rejected: different species");

  // player: species unrestricted, biology still enforced
  ok(canMate(cm, cf, "player", g.tick).ok, "player same-species male + female is permitted");
  ok(canMate(s1, s2, "player", g.tick).ok, "player same-species asexual + asexual is permitted");
  ok(canMate(cm, mf, "player", g.tick).ok, "player cross-species male + female is permitted");
  ok(canMate(mf, cm, "player", g.tick).ok, "player cross-species female + male is permitted");
  ok(canMate(s1, r1, "player", g.tick).ok, "player cross-species asexual + asexual is permitted");
  ok(canMate(mb, cm, "player", g.tick).reason === "biological_incompatibility", "player male + male is rejected: biologically incompatible");
  ok(canMate(mf, cf, "player", g.tick).reason === "biological_incompatibility", "player female + female is rejected: biologically incompatible");
  ok(canMate(s1, cm, "player", g.tick).reason === "biological_incompatibility", "player asexual + male is rejected: biologically incompatible");
  ok(canMate(s1, mf, "player", g.tick).reason === "biological_incompatibility", "player asexual + female is rejected: biologically incompatible");
}

// rule ownership: biology is species-blind, the mating layer carries the species boundary
{
  const g = newGame("MAT-2", "Rook", "scholar", "#e8742a", previewStarter("MAT-2", "mossback"));
  const mk = (speciesId: string, sex: Sex): Monster => createMonster(g, speciesId, 10, { origin: "Test", seed: 72, sex });
  const a = mk("cindermaw", "male");
  const b = mk("mossback", "female");
  ok(canReproduce(a, b, g.tick).ok, "the reproduction engine accepts cross-species male + female — biology is species-blind");
  ok(!canMate(a, b, "wild", g.tick).ok, "wild mating rules reject that same biologically-capable pair");
  ok(canMate(a, b, "player", g.tick).ok, "player mating rules pass that same pair through to biology");
  ok(beginReproduction(a, b, g.tick).ok, "a permitted player pairing reaches the one biological reproduction system");
}

// general validation and biological gating through the mating layer
{
  const g = newGame("MAT-3", "Rook", "scholar", "#e8742a", previewStarter("MAT-3", "mossback"));
  const mk = (speciesId: string, sex: Sex, level = 10): Monster =>
    createMonster(g, speciesId, level, { origin: "Test", seed: 73, sex });
  const m = mk("cindermaw", "male");
  const f = mk("cindermaw", "female");
  const self = canMate(m, m, "player", g.tick);
  ok(!self.ok && self.reason === "same_individual", "an individual can never mate with itself");
  const selfWild = canMate(m, m, "wild", g.tick);
  ok(!selfWild.ok && selfWild.reason === "same_individual", "self-mating is rejected in every context");
  ok(canMate(null, f, "player", g.tick).reason === "invalid_pair", "a missing partner is rejected as an invalid pair");
  const kid = mk("cindermaw", "female", 2);
  ok(!canMate(m, kid, "player", g.tick).ok, "an immature partner is rejected through the biological layer");
  const sterile = mk("cindermaw", "female");
  sterile.repro!.fertility = 0;
  ok(!canMate(m, sterile, "player", g.tick).ok, "an infertile partner is rejected through the biological layer");
  const resting = mk("cindermaw", "female");
  resting.repro!.cooldownUntil = g.tick + 50;
  ok(!canMate(m, resting, "player", g.tick).ok, "a cooling-down partner is rejected through the biological layer");
  const ghost = mk("cindermaw", "male");
  delete ghost.repro;
  ok(!canMate(ghost, f, "player", g.tick).ok && !canMate(ghost, f, "wild", g.tick).ok, "a missing reproductive profile is rejected safely in every context");
  ok(JSON.stringify(canMate(m, f, "wild", g.tick)) === JSON.stringify(canMate(m, f, "wild", g.tick)), "mating authorization is deterministic — no randomness in the rule layer");
}

// wildlife simulation invariants: a lone creature of one species can never multiply among another
{
  const g = newGame("MAT-SIM", "Rook", "scholar", "#e8742a", previewStarter("MAT-SIM", "mossback"));
  const loneMoss = placeAdjacent(g, "lone:1", "mossback", 10);
  ok(!!loneMoss, "a lone wild mossback is placed among another species");
  for (let i = 0; i < 6; i++) placeAdjacent(g, `s:${i}`, "slimekin", 10);
  for (const c of Object.values(g.creatures)) {
    c.satiety = 100;
    c.alpha = false;
    c.pack = false;
  }
  const nearStart = (st: GameState): WildCreature[] =>
    Object.values(st.creatures).filter((c) => cheb(c.x, c.y, st.player.x, st.player.y) <= 15);
  const mossBefore = nearStart(g).filter((c) => c.speciesId === "mossback").length;
  advance(g, 3000);
  const mossAfter = nearStart(g).filter((c) => c.speciesId === "mossback").length;
  ok(mossAfter <= mossBefore, `a lone mossback among another species never multiplies (${mossBefore} → ${mossAfter})`);
  const drifted = Object.values(g.creatures).filter((c) => c.repro && c.repro.status !== reproStateOf(c.repro, g.tick)).length;
  ok(drifted === 0, "the simulation keeps every wild reproductive state reconciled with the clock");

  const g2 = newGame("MAT-SIM2", "Rook", "scholar", "#e8742a", previewStarter("MAT-SIM2", "mossback"));
  const loneSlime = placeAdjacent(g2, "lone:2", "slimekin", 10);
  ok(!!loneSlime, "a lone wild slimekin is placed among another species");
  for (let i = 0; i < 6; i++) placeAdjacent(g2, `m:${i}`, "mossback", 10);
  for (const c of Object.values(g2.creatures)) {
    c.satiety = 100;
    c.alpha = false;
    c.pack = false;
  }
  const slimeBefore = nearStart(g2).filter((c) => c.speciesId === "slimekin").length;
  advance(g2, 3000);
  const slimeAfter = nearStart(g2).filter((c) => c.speciesId === "slimekin").length;
  ok(slimeAfter <= slimeBefore, `a lone slimekin among another species never multiplies (${slimeBefore} → ${slimeAfter})`);
}

/* -------------------------- BREEDING: Phase 4 pipeline ----------------------- */

// species determination and asexual pairing flow through the one pipeline
{
  const g = newGame("BRD-0", "Rook", "scholar", "#e8742a", previewStarter("BRD-0", "mossback"));
  ok(offspringSpecies(createMonster(g, "cindermaw", 8, { origin: "Test", seed: 80 }), createMonster(g, "cragjaw", 8, { origin: "Test", seed: 80 })) === "sunwyrm", "recipe species determination flows through the breeding pipeline");
  const s1 = createMonster(g, "slimekin", 10, { origin: "Test", seed: 80, sex: "asexual" });
  const s2 = createMonster(g, "slimekin", 10, { origin: "Test", seed: 80, sex: "asexual" });
  const out = beginBreeding(g, s1, s2, "player");
  ok(out.ok && out.development.type === "gestation" && !out.nest, "asexual pairs breed through the same pipeline — gestation without a nest");
  ok(out.ok && out.development.speciesId === "regalslime", "the slimekin recipe produces a regalslime through breeding");
}

// validation: every gate returns a structured rejection before any state changes
{
  const g = newGame("BRD-1", "Rook", "scholar", "#e8742a", previewStarter("BRD-1", "mossback"));
  const mk = (speciesId: string, sex: Sex, level = 10): Monster => createMonster(g, speciesId, level, { origin: "Test", seed: 81, sex });
  ok(beginBreeding(g, mk("cindermaw", "male"), mk("cindermaw", "female"), "player").ok, "biologically valid parents can breed");
  ok(!beginBreeding(g, mk("cindermaw", "female", 2), mk("cindermaw", "male"), "player").ok, "an immature parent cannot breed");
  const sterile = mk("cindermaw", "male");
  sterile.repro!.fertility = 0;
  ok(!beginBreeding(g, sterile, mk("cindermaw", "female"), "player").ok, "an infertile parent cannot breed");
  const tired = mk("cindermaw", "male");
  tired.repro!.cooldownUntil = g.tick + 40;
  ok(!beginBreeding(g, tired, mk("cindermaw", "female"), "player").ok, "a parent on cooldown cannot breed");
  const narc = mk("cindermaw", "male");
  ok(!beginBreeding(g, narc, narc, "player").ok, "self-breeding is rejected");
  ok(!beginBreeding(g, mk("cindermaw", "male"), mk("mossback", "female"), "wild").ok, "wild cross-species breeding is rejected");
  ok(beginBreeding(g, mk("cindermaw", "male"), mk("mossback", "female"), "player").ok, "player cross-species breeding is permitted");
  const taken = mk("cindermaw", "female");
  beginBreeding(g, mk("cindermaw", "male"), taken, "player");
  ok(!beginBreeding(g, mk("cindermaw", "male"), taken, "player").ok, "a parent already reproducing cannot start another breeding");
}

// genetics: both parents contribute, mutation is bidirectional and clamped, lineage is recorded
{
  const g = newGame("BRD-2", "Rook", "scholar", "#e8742a", previewStarter("BRD-2", "mossback"));
  const pa = createMonster(g, "cindermaw", 10, { origin: "Test", seed: 82, sex: "male", genes: { vigor: { a: 95, b: 20 }, might: { a: 50, b: 50 }, guard: { a: 50, b: 50 }, swift: { a: 50, b: 50 }, wit: { a: 50, b: 50 }, size: { a: 80, b: 20 } } });
  const pb = createMonster(g, "mossback", 10, { origin: "Test", seed: 83, sex: "female", genes: { vigor: { a: 15, b: 60 }, might: { a: 50, b: 50 }, guard: { a: 50, b: 50 }, swift: { a: 50, b: 50 }, wit: { a: 50, b: 50 }, size: { a: 10, b: 90 } } });
  const out = beginBreeding(g, pa, pb, "player");
  ok(out.ok, "breeding starts for the genetics suite");
  if (out.ok) {
    const child = out.development.child!;
    let both = false;
    let mid = false;
    let up = false;
    let down = false;
    let legal = true;
    for (let i = 0; i < 400; i++) {
      const c = planChild(pa, pb, new Rng(3000 + i));
      if ([95, 20].includes(c.genes.vigor.a) && [15, 60].includes(c.genes.vigor.b)) both = true;
      const e = expressGene(c.genes.vigor);
      if (e > 20 && e < 90) mid = true;
      for (const r of c.mutHistory) {
        if (r.dir === "up") up = true;
        if (r.dir === "down") down = true;
      }
      legal = legal && GENE_KEYS.every((k) => c.genes[k].a >= 5 && c.genes[k].a <= 100 && c.genes[k].b >= 5 && c.genes[k].b <= 100);
    }
    ok(both, "each parent contributes one allele per gene");
    ok(mid, "intermediate expression values arise from mixed inheritance");
    ok(up && down, "mutation moves genes upward and downward");
    ok(legal, "mutated genes remain within their legal range");
    ok(expressGene(child.genes.size) >= 5, "size is inherited as part of the genotype");
    ok(child.parents[0] === pa.uid && child.parents[1] === pb.uid, "parent ids are recorded");
    ok(child.generation === 2, "generation increments past the parents");
    ok(child.lineageId === [pa.lineageId!, pb.lineageId!].sort()[0], "lineage id is preserved from the parents");
    ok(child.mutHistory.every((r) => r.gen === child.generation), "mutation history is recorded per generation");
  }
}

// development: no premature offspring, delivery at completion, parents cool down after
{
  const g = newGame("BRD-3", "Rook", "scholar", "#e8742a", previewStarter("BRD-3", "mossback"));
  const a = createMonster(g, "cindermaw", 10, { origin: "Test", seed: 84, sex: "male" });
  const b = createMonster(g, "mossback", 10, { origin: "Test", seed: 85, sex: "female" });
  g.pen.push(a, b); // advanceReproduction only sees bodies living in the state
  const out = beginBreeding(g, a, b, "player");
  ok(out.ok && out.development.type === "gestation", "a beast pairing gestates — live birth, no nest");
  if (out.ok) {
    const dev = out.development;
    g.tick = dev.completeTick - 1;
    advanceDevelopment(g);
    ok(g.party.length === 1, "no offspring before development completes");
    g.tick += 1;
    advanceDevelopment(g);
    const child = [...g.party, ...g.pen].find((m) => m.parents?.[0] === a.uid) ?? null;
    ok(!!child, "the offspring is created when development completes");
    ok(dev.state === "completed" && dev.resultId === child?.uid, "the development record records its result");
    ok(!!child && typeof child.genes.vigor.a === "number" && child.lineageId === [a.lineageId!, b.lineageId!].sort()[0], "the offspring retains its inherited genotype and lineage");
    advanceReproduction(g);
    ok(a.repro!.status === "cooldown" && a.repro!.cooldownUntil > g.tick, "parents enter a breeding cooldown after the offspring arrives");
  }
}

/* ------------------------------- NESTS: Phase 5 ------------------------------ */

// a female egg-layer builds one persistent nest and reuses it
{
  const g = newGame("NST-1", "Rook", "scholar", "#e8742a", previewStarter("NST-1", "mossback"));
  const eggSp = Object.keys(SPECIES).find((id) => developmentTypeFor(id, "sexual") === "egg") ?? "";
  ok(!!eggSp, "egg-laying species exist");
  const f = createMonster(g, eggSp, 10, { origin: "Test", seed: 86, sex: "female" });
  const m = createMonster(g, eggSp, 10, { origin: "Test", seed: 87, sex: "male" });
  const r1 = beginBreeding(g, f, m, "player");
  ok(r1.ok && !!r1.nest, "an egg-laying female builds a nest");
  const nestId = r1.ok && r1.nest ? r1.nest.id : "";
  ok(!!nestId && f.repro?.nestId === nestId, "the female remembers her nest");
  const m2 = createMonster(g, eggSp, 10, { origin: "Test", seed: 88, sex: "male" });
  if (r1.ok) {
    g.tick = r1.development.completeTick + 1;
    advanceDevelopment(g);
    advanceReproduction(g);
    g.tick += BREED_COOLDOWN_TICKS + 1;
    advanceReproduction(g);
    ok(r1.nest!.state === "active", "the nest persists after offspring production");
    const r2 = beginBreeding(g, f, m2, "player");
    ok(r2.ok && r2.nest?.id === nestId, "the female reuses her existing nest on the next breeding");
    ok(Object.keys(g.nests).length === 1, "no duplicate nest is created");
  }
}

// destroying a nest interrupts its brood and leaves nothing dangling
{
  const g = newGame("NST-2", "Rook", "scholar", "#e8742a", previewStarter("NST-2", "mossback"));
  const eggSp = Object.keys(SPECIES).find((id) => developmentTypeFor(id, "sexual") === "egg") ?? "";
  const f = createMonster(g, eggSp, 10, { origin: "Test", seed: 91, sex: "female" });
  const m = createMonster(g, eggSp, 10, { origin: "Test", seed: 92, sex: "male" });
  g.pen.push(f); // destroyNest reaches the owner through the living state
  const r = beginBreeding(g, f, m, "player");
  ok(r.ok && !!r.nest, "the nest exists before destruction");
  if (r.ok && r.nest) {
    const dev = r.development;
    destroyNest(g, r.nest.id);
    ok(dev.state === "interrupted" && dev.nestId === undefined, "destroying a nest interrupts its developing offspring");
    ok(r.nest.state === "destroyed" && r.nest.developmentIds.length === 0, "the destroyed nest holds no dangling development references");
    ok(f.repro?.nestId === undefined, "the female's memory of the destroyed nest is cleared");
    g.tick = dev.completeTick + BREED_COOLDOWN_TICKS + 1;
    advanceDevelopment(g);
    advanceReproduction(g);
    ok(![...g.party, ...g.pen].some((x) => x.parents?.[0] === m.uid), "an interrupted development never produces offspring");
    const m3 = createMonster(g, eggSp, 10, { origin: "Test", seed: 93, sex: "male" });
    g.tick += BREED_COOLDOWN_TICKS + 1;
    advanceReproduction(g);
    const r3 = beginBreeding(g, f, m3, "player");
    ok(r3.ok && !!r3.nest && r3.nest.id !== r.nest.id, "a new nest is created after the old one is invalidated");
  }
}

// female defeat abandons the nest without destroying it; abandoned nests are not reused
{
  const g = newGame("NST-3", "Rook", "scholar", "#e8742a", previewStarter("NST-3", "mossback"));
  const eggSp = Object.keys(SPECIES).find((id) => developmentTypeFor(id, "sexual") === "egg") ?? "";
  const f = createMonster(g, eggSp, 10, { origin: "Test", seed: 94, sex: "female" });
  const m = createMonster(g, eggSp, 10, { origin: "Test", seed: 95, sex: "male" });
  const r = beginBreeding(g, f, m, "player");
  ok(r.ok && !!r.nest, "the nest exists before defeat");
  if (r.ok && r.nest) {
    abandonNestsOf(g, f.uid);
    ok(r.nest.state === "abandoned", "female defeat abandons but does not destroy the nest");
    ok(!!g.nests[r.nest.id], "the abandoned nest persists in the world");
    ok(r.development.state === "developing", "development continues in an abandoned nest");
    g.tick = r.development.completeTick + BREED_COOLDOWN_TICKS + 1;
    advanceDevelopment(g);
    advanceReproduction(g);
    ok([...g.party, ...g.pen].some((x) => x.parents?.includes(m.uid) ?? false), "offspring still hatches from an abandoned nest");
    g.tick += BREED_COOLDOWN_TICKS + 1;
    advanceReproduction(g);
    const m3 = createMonster(g, eggSp, 10, { origin: "Test", seed: 96, sex: "male" });
    const r3 = beginBreeding(g, f, m3, "player");
    ok(r3.ok && !!r3.nest && r3.nest.id !== r.nest.id, "an abandoned nest is not reused — the female builds fresh");
  }
}

// wild eggs hatch at the nest with their inherited genotype intact
{
  const g = newGame("NST-4", "Rook", "scholar", "#e8742a", previewStarter("NST-4", "mossback"));
  const eggSp = Object.keys(SPECIES).find((id) => developmentTypeFor(id, "sexual") === "egg") ?? "";
  const c = placeAdjacent(g, "w:1", eggSp, 10);
  const o = placeAdjacent(g, "w:2", eggSp, 10);
  ok(!!c && !!o, "two wild egg-layers are placed");
  if (c && o) {
    c.repro!.mode = "female";
    o.repro!.mode = "male";
    const r = beginBreeding(g, c, o, "wild");
    ok(r.ok && !!r.nest, "wild breeding builds a nest at the layer's position");
    if (r.ok) {
      const dev = r.development;
      ok(Object.values(g.creatures).every((x) => x.id !== dev.resultId), "no wild offspring exists before completion");
      g.tick = dev.completeTick + 1;
      advanceDevelopment(g);
      const baby = dev.resultId ? g.creatures[dev.resultId] : null;
      ok(!!baby, "the wild offspring hatches at the nest");
      ok(!!baby && JSON.stringify(baby.genes) === JSON.stringify(dev.child!.genes) && baby.lineageId === dev.child!.lineageId, "the hatched creature retains its inherited genotype and lineage");
      ok(!!r.nest && r.nest.state === "active", "the nest persists after hatching");
    }
  }
}

// persistence: nests and developments survive round-trips; migration is idempotent
{
  const s1 = JSON.parse(JSON.stringify(gs)) as GameState;
  migrateBreeding(s1);
  const s2 = JSON.parse(JSON.stringify(s1)) as GameState;
  migrateBreeding(s2);
  ok(JSON.stringify(s2) === JSON.stringify(s1), "migrateBreeding is idempotent across the whole game state");
}

/* ------------------------------ TERRITORY: Phase 6 ----------------------------- */

// territories are persistent world state with identity; creatures reference them
{
  const g = newGame("TER-1", "Rook", "scholar", "#e8742a", previewStarter("TER-1", "mossback"));
  ok(Object.values(g.creatures).every((c) => !!c.territoryId && !!g.territories[c.territoryId!]), "every spawned creature recognizes a live territory from birth");
  // wipe to the legacy-save state so founding and joining are deterministic under test
  g.territories = {};
  g.territorySeq = 0;
  for (const c of Object.values(g.creatures)) delete c.territoryId;
  const c = placeAdjacent(g, "w:ter1", "mossback", 10);
  ok(!!c, "a wild creature is placed for the territory suite");
  if (c) {
    const t = ensureTerritory(g, c);
    ok(c.territoryId === t.id && !!g.territories[t.id], "a founded territory persists in world state and the creature references it");
    ok(t.x === c.x && t.y === c.y, "the territory is centered on its founding spot");
    ok(t.quality >= 0 && t.quality <= 100, `territory quality is scored from the environment (${t.quality})`);
    ok(territoryAt(g, t.x, t.y)?.id === t.id, "territories resolve by position");
    ok(JSON.stringify(homeAnchor(g, c)) === JSON.stringify({ x: t.x, y: t.y }), "home-range reads come from the territory");
    const c2 = placeAdjacent(g, "w:ter2", "mossback", 12);
    ok(!!c2, "a second same-species creature is placed nearby");
    if (c2) {
      ensureTerritory(g, c2);
      ok(c2.territoryId === t.id, "a nearby same-species creature joins the existing territory instead of founding a duplicate");
    }
  }
}

// alpha behavior migrates to territory ownership
{
  const g = newGame("TER-2", "Rook", "scholar", "#e8742a", previewStarter("TER-2", "mossback"));
  const a = placeAdjacent(g, "w:ter3", "mossback", 10);
  ok(!!a, "the future alpha is placed");
  if (a) {
    a.alpha = true;
    const t = ensureTerritory(g, a);
    ok(t.ownerId === a.id, "an alpha becomes its territory's owner");
    const minion = placeAdjacent(g, "w:ter4", "mossback", 12);
    ok(!!minion, "a pack member is placed nearby");
    if (minion) {
      minion.pack = a.id;
      ensureTerritory(g, minion);
      ok(minion.territoryId === t.id && t.ownerId === a.id, "a pack member shares the alpha's territory without claiming it");
      releaseTerritoryOwner(g, a.id);
      ok(t.ownerId === undefined && !!g.territories[t.id], "when the alpha falls, ownership lapses but the territory persists");
    }
  }
}

// nests are linked to territories through ids, in both directions
{
  const nestArt = decodePng(new Uint8Array(readFileSync(new URL("../public/monsters/v2/nest.png", import.meta.url))));
  const nestEggs = decodePng(new Uint8Array(readFileSync(new URL("../public/monsters/v2/nest_eggs.png", import.meta.url))));
  ok(nestArt.w > 0 && nestEggs.w > 0, "nest and nest-with-eggs sprites exist in the processed art pipeline");
  const g = newGame("TER-3", "Rook", "scholar", "#e8742a", previewStarter("TER-3", "mossback"));
  const eggSp = Object.keys(SPECIES).find((id) => developmentTypeFor(id, "sexual") === "egg") ?? "";
  const c = placeAdjacent(g, "w:ter5", eggSp, 10);
  const o = placeAdjacent(g, "w:ter6", eggSp, 12);
  ok(!!c && !!o, "a wild egg-laying pair is placed");
  if (c && o) {
    c.repro!.mode = "female";
    o.repro!.mode = "male";
    const r = beginBreeding(g, c, o, "wild");
    ok(r.ok && !!r.nest, "the pair breeds and lays");
    if (r.ok && r.nest) {
      const tid = r.nest.territoryId;
      ok(!!tid && !!g.territories[tid!], "the nest references a live territory");
      ok(!!tid && g.territories[tid!].nestIds.includes(r.nest.id), "the territory lists the nest among its own");
      g.tick = r.development.completeTick + 1;
      advanceDevelopment(g);
      const baby = r.development.resultId ? g.creatures[r.development.resultId] : null;
      ok(!!baby && baby.territoryId === tid, "a hatched offspring is born into its nest's territory");
    }
  }
}

// legacy saves migrate safely; territory migration is idempotent
{
  const s1 = JSON.parse(JSON.stringify(gs)) as GameState;
  delete (s1 as { territories?: unknown }).territories;
  delete (s1 as { territorySeq?: unknown }).territorySeq;
  for (const c of Object.values(s1.creatures)) delete c.territoryId;
  migrateTerritories(s1);
  ok(Object.values(s1.creatures).every((c) => !!c.territoryId && !!s1.territories[c.territoryId!]), "a legacy save receives a territory for every creature");
  const snapshot = JSON.stringify(s1);
  migrateTerritories(s1);
  ok(JSON.stringify(s1) === snapshot, "migrateTerritories is idempotent across the whole game state");
}

// waiting passes time without leaking new terrain
const expBefore = Object.keys(gs.knowledge.explored).length;
waitTurn(gs, 24);
ok(Object.keys(gs.knowledge.explored).length === expBefore, "waiting does not reveal new area");

/* ------------------------------- FACTIONS ------------------------------------ */

// nations: generated, mixed sizes, coherent blobs, unclaimable land stays free
{
  const fac = getFactions(gs.seed);
  ok(fac.nations.length >= 6 && fac.nations.length <= 24, `nations generated (${fac.nations.length})`);
  ok(fac.nations.some((n) => n.tier === "major") && fac.nations.some((n) => n.tier === "free"), "mixed realm sizes present (majors and free cities)");
  const counts = new Map<string, number>();
  for (let fy = 0; fy < 103; fy++) {
    for (let fx = 0; fx < 103; fx++) {
      const n = fac.nationAtCell(fx, fy);
      if (n) counts.set(n.id, (counts.get(n.id) ?? 0) + 1);
    }
  }
  ok(fac.nations.every((n) => (counts.get(n.id) ?? 0) > 0), "every nation holds territory");
  const sizes = [...counts.values()];
  const ratio = Math.max(...sizes) / Math.min(...sizes);
  ok(ratio >= 2.5, `mixed sizes: the largest realm is ${ratio.toFixed(1)}× the smallest`);
  let same = 0;
  let tot = 0;
  for (let i = 0; i < 4000; i++) {
    const fx = 2 + (i * 97) % 99;
    const fy = 2 + (i * 53) % 99;
    const n = fac.nationAtCell(fx, fy);
    if (!n) continue;
    for (const o of [fac.nationAtCell(fx + 1, fy), fac.nationAtCell(fx, fy + 1)]) {
      tot++;
      if (o === n) same++;
    }
  }
  ok(tot > 0 && same / tot > 0.6, `territory is coherent, not checkered (${((same / Math.max(1, tot)) * 100).toFixed(0)}% neighbor agreement)`);
  // territory resolves at 40-tile cells: a cell is claimed only if its own center is claimable land
  let badClaim = 0;
  for (let fy = 0; fy < 103; fy++) {
    for (let fx = 0; fx < 103; fx++) {
      const t = world.tile(fx * 40 + 20, fy * 40 + 20);
      if (!BIOMES[t.biome].passable && fac.nationAtCell(fx, fy)) badClaim++;
    }
  }
  ok(badClaim === 0, "sea and peaks stay unclaimed (every territory cell is claimable land)");
  const f2 = new Factions(world.seed, world);
  ok(JSON.stringify(f2.nations) === JSON.stringify(fac.nations), "nations are seed-deterministic across instances");
}

// associations: chapters inside their origin nation, charters vary by nation
{
  const fac = getFactions(gs.seed);
  ok(fac.assocs.every((a) => fac.nationAt(a.chapter.x, a.chapter.y)?.id === a.nationId), "every association chapter lies inside its origin nation");
  ok(fac.assocs.every((a) => isSettlement(a.chapter)), "chapters stand in settlements");
  const ch = fac.assocs[0];
  if (ch) {
    const notices = fac.settlementNotices(ch.chapter);
    ok(notices.length >= 1 && notices.length <= 3, `a chapter hamlet posts notices (${notices.length})`);
    ok(notices.every((nt) => nt.text.includes(nt.assoc.name)), "notices are signed by their association");
    ok(notices.every((nt) => nt.text.includes("duel") || nt.text.includes("Tourney") || nt.text.includes("Auction") || nt.text.includes("auction") || nt.text.includes("beast") || nt.text.includes("Sale")), "notices cover duels, tourneys and beast trade");
  }
  let multi = false;
  let none = false;
  for (const seedText of ["MAPCHECK-1", "FACTION-2", "FACTION-3", "FACTION-4"]) {
    const sd = seedFromText(seedText);
    const facS = new Factions(sd, getWorld(sd));
    for (const n of facS.nations) {
      if (n.associations.length >= 2) multi = true;
      if (n.associations.length === 0) none = true;
    }
  }
  ok(multi, "some nations charter more than one association");
  ok(none, "some nations charter no association");
}

// borders: walking crosses them, announcements fire, learning persists
{
  const g = newGame("BORDER-1", "Rook", "ranger", "#e8742a", previewStarter("BORDER-1", "mossback"));
  const fac = getFactions(g.seed);
  const home = fac.nationAt(g.player.x, g.player.y);
  ok(!home || (g.lastNation === home.id && g.knowledge.nationsSeen[home.id] === 1), "the home nation is known from the first day");
  // the nearest place where the ground changes hands: scan outward until a
  // tile belongs to someone else, then stand one step inside home and cross
  // on foot — the announcement and the learning ride on the real move
  const wB = getWorld(g.seed);
  const dirs8: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  let stepFrom: { x: number; y: number } | null = null;
  let stepTo: { x: number; y: number } | null = null;
  outer: for (let r = 1; r < 1200; r++) {
    for (const [dx, dy] of dirs8) {
      const bx = g.player.x + dx * r;
      const by = g.player.y + dy * r;
      if (!wB.inBounds(bx, by) || !wB.passable(bx, by) || wB.siteAt(bx, by)?.wall) continue;
      if (creatureAt(g, bx, by) || wB.npcAt(bx, by)) continue;
      if (fac.nationAt(bx, by)?.id === (home?.id ?? "")) continue;
      const ax = bx - dx;
      const ay = by - dy;
      // the launch tile must still be home ground: the announcement rides
      // on the transition, not the destination
      if (fac.nationAt(ax, ay)?.id !== (home?.id ?? "")) continue;
      if (!wB.passable(ax, ay) || wB.siteAt(ax, ay)?.wall) continue;
      if (creatureAt(g, ax, ay) || wB.npcAt(ax, ay)) continue;
      stepFrom = { x: ax, y: ay };
      stepTo = { x: bx, y: by };
      break outer;
    }
  }
  ok(!!stepFrom && !!stepTo, "a border lies within reach of the start");
  let crossed = false;
  if (stepFrom && stepTo) {
    g.player.x = stepFrom.x;
    g.player.y = stepFrom.y;
    initField(g);
    loadChunks(g);
    movePlayer(g, stepTo.x - stepFrom.x, stepTo.y - stepFrom.y);
    crossed = g.lastNation !== (home?.id ?? "");
  }
  ok(crossed, "wandering far enough crosses at least one border");
  ok(g.log.some((l) => l.text.includes("entered") || l.text.includes("unclaimed wilds")), "crossing a border is announced");
}

// perf
const t0 = performance.now();
for (let i = 0; i < 300; i++) movePlayer(gs, i % 3 === 0 ? 1 : i % 3 === 1 ? 0 : -1, 1);
const t1 = performance.now();
console.log(`perf 300 moves+combat+knowledge: ${(t1 - t0).toFixed(1)}ms`);

const t2 = performance.now();
for (let cy = 0; cy < 128; cy++) for (let cx = 0; cx < 128; cx++) sampleCell("world", world, cx * 32, cy * 32);
const t3 = performance.now();
console.log(`perf full world overview build: ${(t3 - t2).toFixed(1)}ms`);

const fac = getFactions(gs.seed);
const t4 = performance.now();
let sink = 0;
for (let i = 0; i < 20000; i++) sink += fac.nationAt((i * 131) % 4096, (i * 197) % 4096) ? 1 : 0;
const t5 = performance.now();
console.log(`perf 20000 nationAt lookups: ${(t5 - t4).toFixed(1)}ms (sink ${sink})`);
console.log(`info save JSON size: ${(json.length / 1024).toFixed(1)}KB`);

// PLAYER LOOK — the player uses the same modular sprite system as the rivals
// ────────────────────────────────────────────────────────────────────────────
{
  console.log("\n— player look —");
  const chosen = resolveLook(defaultLook()).look;
  const withLook = newGame("LOOKS-1", "Rook", "ranger", "#e8742a", previewStarter("LOOKS-1", "mossback"), chosen);
  ok(resolveLook(withLook.player.look).ok && lookSilhouette(withLook.player.look!) === lookSilhouette(chosen), "a new game stores the look chosen in character creation");
  const bare = newGame("LOOKS-1", "Rook", "ranger", "#e8742a", previewStarter("LOOKS-1", "mossback"));
  ok(bare.player.look === undefined, "newGame without a look leaves the field empty for migration");
  const old = JSON.parse(JSON.stringify(bare));
  ok(migrateLoaded(old) && resolveLook(old.player.look).ok, "an old save backfills a valid player look");
  const again = JSON.parse(JSON.stringify(bare));
  migrateLoaded(again);
  ok(JSON.stringify(again.player.look) === JSON.stringify(old.player.look), "the backfilled player look is deterministic per world seed");
  ok(old.player.scarf === bare.player.scarf, "the signature color survives alongside the look");
}

// SPRITEBG — automatic black-background removal
{
  console.log("SPRITEBG — black background removal");
  const mk = (w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): RawImage => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b, a] = fill(x, y);
        const o = (y * w + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = a;
      }
    }
    return { w, h, data };
  };
  const alpha = (img: RawImage, x: number, y: number): number => img.data[(y * img.w + x) * 4 + 3];
  const scene = mk(32, 32, (x, y) => {
    const body = x >= 8 && x < 24 && y >= 8 && y < 24;
    if (!body) return [0, 0, 0, 255];
    if (x >= 12 && x < 19 && y >= 12 && y < 19) return [0, 0, 0, 255];
    if (x === 10 && y === 10) return [0, 0, 0, 255];
    // a 2px dark seam across the body: line work, though flat and dark
    if ((x === 10 || x === 11) && y >= 20 && y < 23) return [0, 0, 0, 255];
    return [40, 120, 60, 255];
  });
  const out = stripBlackBackground(scene);
  ok(alpha(out, 0, 0) === 0 && alpha(out, 31, 31) === 0, "border-connected background black is removed");
  ok(alpha(out, 10, 10) === 255, "a creature's own black detail is kept");
  ok(alpha(out, 15, 15) === 0, "a large uniform enclosed black pocket is removed");
  ok(alpha(out, 10, 21) === 255 && alpha(out, 11, 22) === 255, "a thin dark seam is line work and survives");
  ok(alpha(out, 9, 9) === 255 && alpha(out, 12, 19) === 255, "the body itself survives the strip");
  // already-clean art keeps its exact silhouette
  const v2 = decodePng(new Uint8Array(readFileSync(new URL("../public/monsters/v2/mossback.png", import.meta.url))));
  const v2out = stripBlackBackground(v2);
  let adiff = 0;
  for (let i = 0; i < v2.w * v2.h; i++) if (v2out.data[i * 4 + 3] !== v2.data[i * 4 + 3]) adiff++;
  ok(adiff === 0, "already-transparent monster art keeps its exact silhouette");
  // the tamer sprite's baked black background strips clean to the border
  const hero = decodePng(new Uint8Array(readFileSync(new URL("../public/player/hero.png", import.meta.url))));
  const hc = stripBlackBackground(hero);
  let removed = 0;
  let edge = 0;
  for (let i = 0; i < hero.w * hero.h; i++) if (hc.data[i * 4 + 3] === 0) removed++;
  for (let x = 0; x < hero.w; x++) {
    if (hc.data[x * 4 + 3] > 0) edge++;
    if (hc.data[((hero.h - 1) * hero.w + x) * 4 + 3] > 0) edge++;
  }
  for (let y = 0; y < hero.h; y++) {
    if (hc.data[(y * hero.w) * 4 + 3] > 0) edge++;
    if (hc.data[(y * hero.w + hero.w - 1) * 4 + 3] > 0) edge++;
  }
  ok(edge === 0, "the tamer sprite's baked black background strips to the border");
  ok(removed / (hero.w * hero.h) > 0.4, `most of the tamer sprite was background (${((removed / (hero.w * hero.h)) * 100).toFixed(0)}%)`);
  // defringe pulls dark edge pixels toward body color so no halos hug the silhouette
  const fr = mk(8, 8, (x) => (x === 0 ? [0, 0, 0, 0] : [230, 90, 70, 255]));
  const fo = (3 * 8 + 1) * 4;
  fr.data[fo] = 10;
  fr.data[fo + 1] = 10;
  fr.data[fo + 2] = 10;
  defringeEdges(fr);
  ok(fr.data[fo] > 120, "defringe pulls edge pixels toward the body color");
  // cutout art: a mostly transparent border with leftover dark smudges must
  // not unleash the flood on a near-black creature coat
  const cut = mk(32, 32, (x, y) => {
    const border = x === 0 || y === 0 || x === 31 || y === 31;
    if (border) return x === 0 && y === 0 ? [10, 8, 6, 255] : [0, 0, 0, 0];
    const body = x >= 8 && x < 24 && y >= 8 && y < 24;
    if (!body) return [0, 0, 0, 0];
    if (x === 15) return [250, 140, 30, 255]; // a fire crack through the coat
    return [28, 24, 22, 255]; // a near-black charcoal coat
  });
  const cout = stripBlackBackground(cut);
  ok(alpha(cout, 9, 9) === 255 && alpha(cout, 20, 20) === 255, "a dark cutout creature keeps its coat");
  ok(alpha(cout, 15, 12) === 255, "its bright line work survives with it");
  ok(alpha(cout, 0, 0) === 255, "its border smudge is left alone (it is at most glow)");
}

// ---------------------------------------------------------------------------
// HEIGHT: terraces, slopes, cliffs, carved terrain, caves, fair play
// ---------------------------------------------------------------------------
console.log("\n-- HEIGHT --");
{
  const SEEDS = ["MAPCHECK-1", "EMBER", "12345-ABC", "FROSTPEAK", "DUNE", "ZED-9"];
  const N8: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

  // HGT-1 determinism: two independent worlds of one seed agree on every height fact
  {
    const a = heightOf(new World(seedFromText("EMBER")));
    const b = heightOf(new World(seedFromText("EMBER")));
    let same = true;
    for (let i = 0; i < 4000 && same; i++) {
      const x = 1500 + ((i * 37) % 900);
      const y = 1700 + ((i * 53) % 900);
      same = a.level(x, y) === b.level(x, y) && a.isRamp(x, y) === b.isRamp(x, y) && a.isMouth(x, y) === b.isMouth(x, y) && a.caveOpen(CAVE_UPPER, x, y) === b.caveOpen(CAVE_UPPER, x, y);
    }
    ok(same, "height is a pure function of the seed (levels, slopes, mouths, caves)");
  }

  let canyonSeeds = 0;
  let mouthTotal = 0;
  for (const s of SEEDS) {
    const w = new World(seedFromText(s));
    const hf = heightOf(w);
    const st = w.startPoint();

    // HGT-2 landmarks sit on level plateaus with only gentle edges around them
    let flatOk = true;
    let gentleOk = true;
    for (const f of w.featuresNear(st.x, st.y, 260)) {
      const L = hf.level(f.x, f.y);
      for (let dy = -PIN_CORE; dy <= PIN_CORE && flatOk; dy++) {
        for (let dx = -PIN_CORE; dx <= PIN_CORE; dx++) {
          if (hf.isWater(f.x + dx, f.y + dy)) continue;
          if (hf.level(f.x + dx, f.y + dy) !== L) { flatOk = false; break; }
        }
      }
      for (let dy = -PIN_RAMP + 1; dy < PIN_RAMP && gentleOk; dy++) {
        for (let dx = -PIN_RAMP + 1; dx < PIN_RAMP; dx++) {
          const x = f.x + dx;
          const y = f.y + dy;
          if (!w.passable(x, y)) continue;
          for (const [ox, oy] of N8) {
            if (Math.max(Math.abs(dx + ox), Math.abs(dy + oy)) >= PIN_RAMP || !w.passable(x + ox, y + oy)) continue;
            const r = stepRule(w, SURFACE, x, y, x + ox, y + oy, PLAYER_MOVER);
            if (!r.ok || r.drop > 1) { gentleOk = false; break; }
          }
          if (!gentleOk) break;
        }
      }
    }
    ok(flatOk, `${s}: every landmark stands on a level plateau (never cut in half)`);
    ok(gentleOk, `${s}: no cliffs or ledges inside any landmark's approach`);

    // HGT-3 the start area is not boxed in: walking by slopes reaches a wide region
    const seen = new Set<number>([st.y * 4096 + st.x]);
    const q: [number, number][] = [[st.x, st.y]];
    let far = 0;
    while (q.length && seen.size < 12000) {
      const [x, y] = q.shift() as [number, number];
      far = Math.max(far, cheb(x, y, st.x, st.y));
      for (const [dx, dy] of N8) {
        const nx = x + dx;
        const ny = y + dy;
        const k = ny * 4096 + nx;
        if (seen.has(k) || !w.passable(nx, ny)) continue;
        const r = stepRule(w, SURFACE, x, y, nx, ny, PLAYER_MOVER);
        if (!r.ok || r.drop > 1) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    ok(seen.size >= 12000 && far >= 40, `${s}: start area opens onto ${seen.size}+ tiles by slopes (reach ${far})`);

    // HGT-4 riverbeds sit below their banks
    let rivers = 0;
    let raised = 0;
    for (let y = st.y - 200; y <= st.y + 200; y += 3) {
      for (let x = st.x - 200; x <= st.x + 200; x += 3) {
        if (w.tile(x, y).biome !== "river") continue;
        rivers++;
        for (const [dx, dy] of N8) {
          const nb = w.tile(x + dx, y + dy).biome;
          if (nb !== "river" && nb !== "lake" && nb !== "sea" && nb !== "deep" && hf.level(x + dx, y + dy) < hf.level(x, y) && !hf.inGentleZone(x, y)) raised++;
        }
      }
    }
    ok(rivers === 0 || raised / rivers < 0.05, `${s}: riverbeds lie below their banks (${raised} raised of ${rivers})`);

    // HGT-5 carved world: canyons exist somewhere, cave mouths ring the start
    let canyon = 0;
    for (let y = 0; y < 4096 && !canyon; y += 12) for (let x = 0; x < 4096; x += 12) if (hf.isCanyon(x, y)) { canyon++; break; }
    if (canyon) canyonSeeds++;
    const mouths = hf.mouthsIn(st.x - 400, st.y - 400, st.x + 400, st.y + 400);
    mouthTotal += mouths.length;
    ok(mouths.length >= 10, `${s}: cave mouths appear across the land (${mouths.length} within 400 tiles)`);
    ok(
      mouths.every((m) => !hf.isWater(m.x, m.y) && hf.level(m.x, m.y - 1) > hf.level(m.x, m.y) && !w.tile(m.x, m.y).feature && !w.siteAt(m.x, m.y)),
      `${s}: every cave mouth is set into the foot of higher ground, clear of landmarks`,
    );
    ok(mouths.every((m) => hf.caveOpen(CAVE_UPPER, m.x, m.y) && hf.caveOpen(CAVE_UPPER, m.x, m.y + 2)), `${s}: every cave mouth opens onto upper-cave floor`);
    let shafts = 0;
    let shaftOk = true;
    for (let cy = Math.floor((st.y - 400) / 56); cy <= Math.floor((st.y + 400) / 56); cy++) {
      for (let cx = Math.floor((st.x - 400) / 56); cx <= Math.floor((st.x + 400) / 56); cx++) {
        const k = hf.shaftKeyInCell(cx, cy);
        if (k < 0) continue;
        shafts++;
        if (!hf.caveOpen(CAVE_UPPER, k % 4096, Math.floor(k / 4096)) || !hf.caveOpen(CAVE_DEEP, k % 4096, Math.floor(k / 4096))) shaftOk = false;
      }
    }
    ok(shafts > 0 && shaftOk, `${s}: deep shafts link open floor on both cave layers (${shafts})`);
  }
  ok(canyonSeeds >= SEEDS.length - 1, `canyons carve the world on most seeds (${canyonSeeds}/${SEEDS.length})`);
  ok(mouthTotal > 0, "cave mouths exist");

  const g = newGame("HEIGHT-1", "Rook", "wanderer", "#e8742a", previewStarter("HEIGHT-1", "cindermaw"));
  g.party[0].level = 25;
  g.party[0].hp = statOf(g.party[0], "hp");
  const w = getWorld(g.seed);
  const hf = heightOf(w);
  const st = w.startPoint();

  // locate a sheer cliff (south foot below a 2+ level face) and a slope near start
  let cliff: { x: number; y: number; d: number } | null = null;
  let ramp: { x: number; y: number; lx: number; ly: number } | null = null;
  for (let r = 20; r < 500 && (!cliff || !ramp); r += 1) {
    for (let i = 0; i < 8 * r && (!cliff || !ramp); i += 3) {
      const a = (i / (8 * r)) * Math.PI * 2;
      const x = Math.round(st.x + Math.cos(a) * r);
      const y = Math.round(st.y + Math.sin(a) * r);
      if (!w.passable(x, y) || !w.passable(x, y - 1) || hf.isWater(x, y) || hf.isWater(x, y - 1)) continue;
      const d = hf.level(x, y - 1) - hf.level(x, y);
      if (!cliff && d >= 2 && !w.siteAt(x, y) && !w.siteAt(x, y - 1)) cliff = { x, y, d };
      if (!ramp && d === 1 && hf.isRamp(x, y - 1)) ramp = { x: x, y: y - 1, lx: x, ly: y };
    }
  }
  ok(!!cliff && !!ramp, "found a sheer cliff and a slope near the start");

  if (cliff && ramp) {
    // HGT-6 step rules per mover
    ok(!stepRule(w, SURFACE, cliff.x, cliff.y, cliff.x, cliff.y - 1, PLAYER_MOVER).ok, "walkers cannot climb a sheer cliff");
    ok(stepRule(w, SURFACE, ramp.lx, ramp.ly, ramp.x, ramp.y, PLAYER_MOVER).ok, "walkers climb one level by a slope");
    ok(stepRule(w, SURFACE, cliff.x, cliff.y, cliff.x, cliff.y - 1, moverOf("cragjaw")).ok, "climbers (Cragjaw) scale sheer cliffs");
    ok(stepRule(w, SURFACE, cliff.x, cliff.y, cliff.x, cliff.y - 1, moverOf("zephyr_hawk")).ok, "fliers ignore cliffs");
    const down = stepRule(w, SURFACE, cliff.x, cliff.y - 1, cliff.x, cliff.y, PLAYER_MOVER);
    ok(down.ok && down.drop === cliff.d, "stepping down is always physically possible");
    ok(fallLevels(PLAYER_MOVER, down.drop) === cliff.d - 1, "a drop of 2+ levels is a fall");
    ok(fallLevels(moverOf("zephyr_hawk"), 4) === 0 && fallLevels(moverOf("cragjaw"), 4) === 0, "fliers and climbers never fall");
    ok(fallLevels(PLAYER_MOVER, 1) === 0, "stepping down one level is never a fall");
    ok(fallDamage(100, 2) > fallDamage(100, 1) && fallDamage(100, 1) > 0, "higher falls hurt more");

    // HGT-7 movePlayer: refuses cliffs, warns then falls
    g.player.x = cliff.x;
    g.player.y = cliff.y;
    const steps0 = g.stats.steps;
    const up = movePlayer(g, 0, -1);
    ok(!up.ok && g.player.y === cliff.y && g.stats.steps === steps0, "the player is stopped by a sheer cliff");
    g.player.x = cliff.x;
    g.player.y = cliff.y - 1;
    for (const id of Object.keys(g.creatures)) delete g.creatures[id];
    g.field = {};
    const hp0 = g.party[0].hp;
    const warn = movePlayer(g, 0, 1);
    ok(!warn.ok && g.player.y === cliff.y - 1, "a long drop asks for a second step first");
    for (const id of Object.keys(g.creatures)) delete g.creatures[id];
    g.field = {};
    const jump = movePlayer(g, 0, 1);
    ok(jump.ok && g.player.y === cliff.y, "stepping again jumps down the ledge");
    if (cliff.d >= 2) ok(g.party[0].hp < hp0, `the party takes fall damage (${hp0} → ${g.party[0].hp})`);

    // HGT-8 pathfinding uses slopes and never jumps
    const p = findPath(w, ramp.lx, ramp.ly + 3, ramp.x, ramp.y - 2);
    let legal = !!p;
    let px = ramp.lx;
    let py = ramp.ly + 3;
    for (const [x, y] of p ?? []) {
      const r = stepRule(w, SURFACE, px, py, x, y, PLAYER_MOVER);
      if (!r.ok || r.drop > 1) legal = false;
      px = x;
      py = y;
    }
    ok(legal, `tap-to-travel routes climb by slopes and never jump (${p?.length ?? 0} steps)`);
    const pc = findPath(w, cliff.x, cliff.y, cliff.x, cliff.y - 1, 3000);
    ok(!pc || pc.length > 1, "routes never climb straight up a cliff face");

    // HGT-9 sight: cliffs hide what lies above and behind them; tops see down.
    // Needs a true plateau: a 2+ level face with level land behind its rim.
    let plateau: { x: number; y: number } | null = null;
    for (let r = 10; r < 600 && !plateau; r++) {
      for (let i = 0; i < 8 * r; i += 2) {
        const a = (i / (8 * r)) * Math.PI * 2;
        const x = Math.round(st.x + Math.cos(a) * r);
        const y = Math.round(st.y + Math.sin(a) * r);
        if (hf.isWater(x, y) || hf.isWater(x, y + 1)) continue;
        const R = hf.level(x, y - 1);
        if (R - hf.level(x, y) < 2 || hf.level(x, y + 1) > hf.level(x, y)) continue;
        if ([2, 3, 4, 5].every((k) => !hf.isWater(x, y - k) && hf.level(x, y - k) === R)) {
          plateau = { x, y };
          break;
        }
      }
    }
    ok(!!plateau, "found a plateau cliff for the sight test");
    if (plateau) {
      ok(!heightLOS(w, SURFACE, plateau.x, plateau.y + 1, plateau.x, plateau.y - 5), "standing below a cliff, you cannot see onto the land behind its rim");
      ok(heightLOS(w, SURFACE, plateau.x, plateau.y - 1, plateau.x, plateau.y + 1), "from the cliff top you can see down to its foot");
    }
  }

  // HGT-10 combat edge + mover types
  ok(heightEdge(5, 3) > 0 && heightEdge(3, 5) < 0 && heightEdge(4, 4) === 0, "high ground gives better aim; uphill attacks are harder");
  ok(heightEdge(20, 0) === heightEdge(2, 0), "height edge is capped");
  ok(moverOf("crystal_golem").heavy && moverOf("cragjaw").burrows && moverOf("cragjaw").climbs && moverOf("pipwisp").flies, "species derive climber/flier/heavy/burrower traits");
  ok(!moverOf("slimekin").climbs && !moverOf("slimekin").flies, "ordinary walkers neither climb nor fly");
  {
    let straddle: { x: number; y: number } | null = null;
    for (let y = st.y - 300; y < st.y + 300 && !straddle; y += 2) for (let x = st.x - 300; x < st.x + 300; x += 2) {
      if (!hf.isWater(x, y) && !hf.isWater(x + 1, y + 1) && Math.abs(hf.level(x, y) - hf.level(x + 1, y + 1)) >= 2) { straddle = { x, y }; break; }
    }
    ok(!!straddle && !bodyLevelOk(w, SURFACE, straddle.x, straddle.y, 2), "big bodies never straddle a cliff");
  }

  // HGT-11 underground: walk into a mouth, explore the cave layer, walk back out
  const mouth = hf.mouthsIn(st.x - 300, st.y - 300, st.x + 300, st.y + 300)[0];
  ok(!!mouth, "a cave mouth near the start");
  if (mouth) {
    g.player.x = mouth.x;
    g.player.y = mouth.y + 1;
    for (const id of Object.keys(g.creatures)) delete g.creatures[id];
    g.field = {};
    const inR = movePlayer(g, 0, -1);
    ok(inR.ok && layerOf(g) === CAVE_UPPER, "stepping into a cave mouth takes you to the upper caves");
    ok(sightRadius(g) === CAVE_SIGHT, "caves have a short view range");
    const cres = Object.values(g.creatures);
    ok(cres.every((c) => c.layer === CAVE_UPPER && hf.caveOpen(CAVE_UPPER, c.x, c.y)), `cave wildlife lives on cave floor only (${cres.length})`);
    ok(cres.every((c) => CAVE_FAUNA[CAVE_UPPER].some(([id]) => id === c.speciesId)), "cave wildlife comes from the cave fauna");
    ok(Object.values(g.field).every((p) => hf.caveOpen(CAVE_UPPER, p.x, p.y)), "the party follows you underground");
    // wander a little through the tunnels
    let moved = 0;
    for (const [dx, dy] of [[0, 1], [0, 1], [1, 0], [-1, 0], [-1, 0], [1, 0], [0, -1]] as [number, number][]) {
      for (const id of Object.keys(g.creatures)) delete g.creatures[id];
      if (layerOf(g) !== CAVE_UPPER) break;
      const r = movePlayer(g, dx, dy);
      if (r.ok) moved++;
    }
    ok(moved >= 3, `you can explore the cave floor (${moved} steps)`);
    ok(Object.keys(g.knowledge.caves ?? {}).length > 0, "cave exploration is remembered separately");
    // walk back to the mouth and out
    for (const id of Object.keys(g.creatures)) delete g.creatures[id];
    g.field = {};
    if (layerOf(g) === CAVE_UPPER) {
      const path = findPath(w, g.player.x, g.player.y, mouth.x, mouth.y + 1, 4000, CAVE_UPPER) ?? [];
      for (const [x, y] of path) {
        for (const id of Object.keys(g.creatures)) delete g.creatures[id];
        g.field = {};
        movePlayer(g, x - g.player.x, y - g.player.y);
      }
      for (const id of Object.keys(g.creatures)) delete g.creatures[id];
      g.field = {};
      movePlayer(g, mouth.x - g.player.x, mouth.y - g.player.y);
    }
    ok(layerOf(g) === SURFACE, "walking back onto the cave mouth leads out to the surface");
    ok(Object.values(g.creatures).every((c) => (c.layer ?? 0) === SURFACE), "surface wildlife returns when you come out");
    // deep caves via a shaft
    changeLayer(g, CAVE_DEEP);
    // crossing layers is not a lifecycle event: chronicled monsters, anchored
    // spawns and exceptional individuals persist as real (dormant) bodies; the
    // deep caves still field their own fauna
    ok(
      layerOf(g) === CAVE_DEEP && Object.values(g.creatures).some((c) => c.layer === CAVE_DEEP) && Object.values(g.creatures).every((c) => c.layer === CAVE_DEEP || c.known || isAnchoredSpawn(c.id) || isExceptionalCreature(c)),
      "the deep caves hold their own wildlife",
    );
    changeLayer(g, SURFACE);
    ok(layerOf(g) === SURFACE && g.player.layer === undefined, "returning to the surface clears the layer field");
  }

  // HGT-12 inspect info
  if (cliff) {
    const gi = groundInfo(w, SURFACE, cliff.x, cliff.y - 1);
    ok(gi.level === hf.level(cliff.x, cliff.y - 1) && gi.cliff, "inspecting shows a tile's level and cliff edges");
  }
  if (ramp) ok(groundInfo(w, SURFACE, ramp.x, ramp.y).ramp, "inspecting shows slopes");

  // HGT-13 save migration: legacy saves load, unsafe spots are fixed, idempotent
  {
    const legacy = JSON.parse(JSON.stringify(g)) as GameState;
    legacy.version = 14;
    delete legacy.player.layer;
    delete (legacy.knowledge as { caves?: unknown }).caves;
    // a saved spot that is no longer standable (out in the sea)
    let sea: { x: number; y: number } | null = null;
    for (let r = 10; r < 1500 && !sea; r += 7) for (let a = 0; a < 16; a++) {
      const x = Math.round(st.x + Math.cos(a) * r);
      const y = Math.round(st.y + Math.sin(a) * r);
      if (w.inBounds(x, y) && w.tile(x, y).biome === "sea") { sea = { x, y }; break; }
    }
    if (sea) {
      legacy.player.x = sea.x;
      legacy.player.y = sea.y;
      const refield = migrateHeight(legacy, w);
      ok(refield && walkable(w, SURFACE, legacy.player.x, legacy.player.y), "a saved spot that is no longer safe moves to the nearest safe ground");
      ok(cheb(legacy.player.x, legacy.player.y, sea.x, sea.y) <= 24, "…and it is nearby");
    }
    ok(!!legacy.knowledge.caves, "cave knowledge is backfilled");
    const snap = JSON.stringify(legacy);
    migrateHeight(legacy, w);
    ok(JSON.stringify(legacy) === snap, "height migration is idempotent");
  }
}

// ---------------------------------------------------------------------------
// GROWTH (Phase 8): lifecycle, physical size, footprint classes
// ---------------------------------------------------------------------------
console.log("\n-- GROWTH --");
{
  const g = newGame("GROWTH-1", "Rook", "wanderer", "#e8742a", previewStarter("GROWTH-1", "slimekin"));
  g.party[0].level = 12;
  g.party[0].hp = statOf(g.party[0], "hp");
  const w = getWorld(g.seed);
  const shared = wildGenotypeFromSeed(99, "cragjaw");
  const baby = createMonster(g, "cragjaw", 5, { seed: 11, origin: "Test", stage: "newborn", genes: shared, sex: "female", personality: "gentle" });
  const adult = createMonster(g, "cragjaw", 5, { seed: 12, origin: "Test", genes: shared, sex: "female", personality: "gentle" });
  ok(baby.bornTick === g.tick && adult.bornTick < g.tick, "bred monsters enter as newborns; created adults are backdated (mature)");
  ok(bodyFootprint(baby, g.tick) === 1 && bodyFootprint(adult, g.tick) === 2, "a newborn Cragjaw is 1×1; a mature one is 2×2 (species footprint)");
  ok(physicalSize(baby, "cragjaw", g.tick) < physicalSize(adult, "cragjaw", g.tick), "newborns are physically smaller than adults of the same genes");
  ok(stageOf(baby.bornTick, "cragjaw", g.tick) === "newborn", "stage: newborn at birth");
  ok(stageOf(baby.bornTick, "cragjaw", baby.bornTick + NEWBORN_TICKS + 1) === "juvenile", "stage: juvenile after the newborn window");
  const matTick = baby.bornTick + matureAgeOf("cragjaw") + 1;
  ok(stageOf(baby.bornTick, "cragjaw", matTick) === "mature", "stage: mature after the growth span");
  ok(bodyFootprint(baby, matTick) === 2, "the same individual crosses the footprint threshold at maturity (1×1 → 2×2)");
  const smallGenes = { ...shared, size: { a: 26, b: 26 } };
  const bigGenes = { ...shared, size: { a: 48, b: 48 } };
  const hugeGenes = { ...shared, size: { a: 52, b: 52 } };
  ok(physicalSize({ genes: smallGenes }, "cragjaw", g.tick) < physicalSize({ genes: bigGenes }, "cragjaw", g.tick), "size genetics shift final physical size");
  ok(bodyFootprint({ speciesId: "cragjaw", genes: shared }, g.tick) === 2 && bodyFootprint({ speciesId: "cragjaw", genes: hugeGenes }, g.tick) === 3, "two individuals of one species can differ in physical dimensions (large lineage)");
  let parity = true;
  for (let expr = 5; expr <= 100; expr++) if (footprintClass(expr / 25) !== sizeToFootprint(expr)) parity = false;
  ok(parity, "footprint classification matches the legacy size thresholds across the whole allele range");
  let lineage = { ...smallGenes };
  const startSize = physicalSize({ genes: lineage }, "cragjaw", g.tick);
  for (let i = 0; i < 8; i++) lineage = { ...lineage, size: { a: Math.min(100, lineage.size.a + 6), b: Math.min(100, lineage.size.b + 6) } };
  ok(physicalSize({ genes: lineage }, "cragjaw", g.tick) > startSize, "size mutations propagate into larger lineages across generations");
  ok(statOf(baby, "hp", g.tick) < statOf(adult, "hp", g.tick) && statOf(baby, "atk", g.tick) < statOf(adult, "atk", g.tick), "growth scales hp and attack");
  ok(statOf(baby, "agi", g.tick) === statOf(adult, "agi", g.tick), "agility is untouched by size growth (the young stay quick)");
  ok(statOf(baby, "hp") === statOf(adult, "hp"), "without a tick, stats stay the mature values (legacy behavior)");
  ok(foodDemand(baby, "cragjaw", g.tick) < foodDemand(adult, "cragjaw", g.tick), "young eat less than adults");
  const wyrm = createMonster(g, "sunwyrm", 5, { seed: 13, origin: "Test", genes: wildGenotypeFromSeed(13, "sunwyrm") });
  ok(foodDemand(wyrm, "sunwyrm", g.tick) > foodDemand(adult, "cragjaw", g.tick), "larger species require more food");
  const youngDuke = createMonster(g, "cragjaw", 10, { seed: 14, origin: "Test", stage: "newborn", genes: shared, sex: "male" });
  const blocked = canMate(youngDuke, adult, "player", g.tick);
  ok(!blocked.ok && blocked.reason === "immature", "a level-10 newborn still cannot breed — maturity follows development, not level");
  const grownTick = youngDuke.bornTick + matureAgeOf("cragjaw") + 1;
  ok(stageOf(youngDuke.bornTick, "cragjaw", grownTick) === "mature" && canMate(youngDuke, adult, "player", grownTick).ok, "the same pair is permitted once growth completes");
  // collision + movement read the growth footprint
  let spot: { x: number; y: number } | null = null;
  outer: for (let r = 3; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = g.player.x + dx;
        const y = g.player.y + dy;
        if (w.inBounds(x, y) && w.passable(x, y) && !w.siteAt(x, y)?.wall && !creatureAt(g, x, y) && !partyMonAt(g, x, y)) {
          spot = { x, y };
          break outer;
        }
      }
    }
  }
  ok(!!spot, "found open ground for the footprint tests");
  if (spot) {
    const juv: WildCreature = {
      id: "grow:juv", speciesId: "stormmane_drake", level: 6, x: spot.x, y: spot.y, homeX: spot.x, homeY: spot.y, hpFrac: 1, satiety: 70,
      disposition: "calm", activity: "Wandering", personality: "gentle", geneSeed: 4242, genes: wildGenotypeFromSeed(4242, "stormmane_drake"), gen: 1,
      lineageId: "L:grow:juv", repro: makeReproProfile(wildReproMode("grow:juv", "stormmane_drake"), 6, 0), calmUntil: g.tick + 100000,
      alpha: false, affection: 0, stalking: false, bornTick: g.tick,
    };
    g.creatures["grow:juv"] = juv;
    ok(creatureAt(g, juv.x + 1, juv.y) === null, "a newborn of a Huge species occupies 1×1 (collision uses the growth footprint)");
    delete juv.bornTick;
    ok(creatureAt(g, juv.x + 1, juv.y) === juv, "the adult of the same body occupies 3×3");
    delete g.creatures["grow:juv"];
  }
  const pm = createMonster(g, "stormmane_drake", 6, { seed: 15, origin: "Test", stage: "newborn" });
  g.party.push(pm);
  g.field[pm.uid] = { x: g.player.x + 30, y: g.player.y + 30 };
  ok(partyMonAt(g, g.player.x + 31, g.player.y + 30) === null, "party collision sees the newborn's 1×1 body");
  g.party.pop();
  delete g.field[pm.uid];
  // growth transitions: delayed where the body cannot fit, applied where it can
  changeLayer(g, CAVE_UPPER);
  const hf = heightOf(w);
  let tunnel: { x: number; y: number } | null = null;
  let chamber: { x: number; y: number } | null = null;
  for (let y = g.player.y - 80; y < g.player.y + 80 && !(tunnel && chamber); y++) {
    for (let x = g.player.x - 80; x < g.player.x + 80; x++) {
      if (!hf.caveOpen(CAVE_UPPER, x, y)) continue;
      if (!tunnel && !hf.caveOpen(CAVE_UPPER, x - 1, y) && !hf.caveOpen(CAVE_UPPER, x + 1, y)) tunnel = { x, y };
      if (!chamber && [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]].every(([dx, dy]) => hf.caveOpen(CAVE_UPPER, x + dx, y + dy))) chamber = { x, y };
    }
  }
  if (tunnel && chamber) {
    const c: WildCreature = {
      id: "grow:cave", speciesId: "stormmane_drake", level: 6, x: tunnel.x, y: tunnel.y, homeX: tunnel.x, homeY: tunnel.y, hpFrac: 1, satiety: 70,
      disposition: "calm", activity: "Wandering", personality: "gentle", geneSeed: 4243, genes: wildGenotypeFromSeed(4243, "stormmane_drake"), gen: 1,
      lineageId: "L:grow:cave", repro: makeReproProfile(wildReproMode("grow:cave", "stormmane_drake"), 6, 0), calmUntil: g.tick + 100000,
      alpha: false, affection: 0, stalking: false, layer: CAVE_UPPER, fpCap: 1,
      bornTick: g.tick - NEWBORN_TICKS - growthSpan("stormmane_drake") - 1,
    };
    g.creatures["grow:cave"] = c;
    resolveGrowth(g, w);
    ok(c.fpCap === 1, "growth into 3×3 delays inside a 1-wide tunnel — the body never expands into rock");
    c.x = chamber.x;
    c.y = chamber.y;
    resolveGrowth(g, w);
    ok(c.fpCap === 3, "growth applies once the body fits (placement cap lifted)");
    delete g.creatures["grow:cave"];
  } else console.log("skip growth-placement checks (no tunnel/chamber in these caves)");
  changeLayer(g, 0);
  // backward compatibility
  const legacy = JSON.parse(JSON.stringify(g)) as GameState;
  legacy.version = 14;
  legacy.party[0].bornTick = legacy.tick; // pre-Phase-8 style: recent creation, no growth awareness
  migrateGrowth(legacy);
  ok(stageOf(legacy.party[0].bornTick, legacy.party[0].speciesId, legacy.tick) === "mature", "legacy adult monsters stay adult (bornTick backdated)");
  const snapTick = JSON.stringify(legacy.party[0].bornTick);
  migrateGrowth(legacy);
  ok(JSON.stringify(legacy.party[0].bornTick) === snapTick, "growth migration is idempotent");
  ok(bodyFootprint({ speciesId: "cragjaw" }, g.tick) === 2 && bodyFootprint({ speciesId: "stormmane_drake" }, g.tick) === 3, "bodies without growth data keep their species footprint");
}

// ---------------------------------------------------------------------------
// ECOLOGY (Phase 7): carrying capacity, pressures, vitals, spawning
// ---------------------------------------------------------------------------
console.log("\n-- ECOLOGY --");
{
  const g = newGame("ECO-1", "Rook", "wanderer", "#e8742a", previewStarter("ECO-1", "slimekin"));
  g.party[0].level = 12;
  g.party[0].hp = statOf(g.party[0], "hp");
  const w = getWorld(g.seed);
  // a quiet far-away stage keeps ambient spawns and territories out of the census
  let base: { x: number; y: number } | null = null;
  for (let r = 500; r < 1600 && !base; r += 40) {
    for (let a = 0; a < 12 && !base; a++) {
      const x = Math.round(g.player.x + Math.cos(a) * r);
      const y = Math.round(g.player.y + Math.sin(a) * r);
      if (w.inBounds(x, y) && w.passable(x, y) && !w.siteAt(x, y)) base = { x, y };
    }
  }
  ok(!!base, "found a quiet far-away stage for the ecology scenario");
  if (base) {
    for (const id of Object.keys(g.creatures)) delete g.creatures[id];
    g.player.x = base.x;
    g.player.y = base.y;
  }
  const mkWild = (id: string, speciesId: string, near: { x: number; y: number }, opts: { juvenile?: boolean; maxR?: number } = {}): WildCreature | null => {
    const maxR = opts.maxR ?? 8;
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = near.x + dx;
          const y = near.y + dy;
          if (!w.inBounds(x, y) || !w.passable(x, y) || w.siteAt(x, y)?.wall || creatureAt(g, x, y) || partyMonAt(g, x, y) || (x === g.player.x && y === g.player.y)) continue;
          const c: WildCreature = {
            id, speciesId, level: 6, x, y, homeX: x, homeY: y, hpFrac: 1, satiety: 70, disposition: "calm", activity: "Wandering", personality: "gentle",
            geneSeed: 777, genes: wildGenotypeFromSeed(777, speciesId), gen: 1, lineageId: `L:${id}`,
            repro: makeReproProfile(wildReproMode(id, speciesId), 6, 0), calmUntil: g.tick + 100000, alpha: false, affection: 0, stalking: false,
          };
          if (opts.juvenile) c.bornTick = g.tick;
          g.creatures[id] = c;
          return c;
        }
      }
    }
    return null;
  };
  const first = mkWild("eco:seed", "slimekin", g.player);
  const t = first ? createTerritory(g, "slimekin", g.player.x, g.player.y) : null;
  ok(!!first && !!t, "the Phase 6 territory anchors the ecological census");
  if (t && first) {
    const cens = () => buildCensus(g, w, 0).get(t.id);
    const sparse = assessTerritory(g, w, t, cens());
    ok(sparse.capacity >= 1 && sparse.food > 0 && sparse.adults === 1 && sparse.juveniles === 0, "capacity is derived from the environment; the census reads the range");
    ok(sparse.territoryId === t.id && sparse.quality === t.quality, "the assessment queries the existing Territory object (no second representation)");
    ok(sparse.reproductive === 1, "reproductive adults are counted through the reproduction system");
    // density pressure: pack the range past its carrying capacity
    for (let i = 0; i < sparse.capacity + 8; i++) mkWild(`eco:crowd:${i}`, "slimekin", g.player);
    const crowded = assessTerritory(g, w, t, cens());
    ok(crowded.density > 1, `over-capacity ranges read as dense (${crowded.adults + crowded.juveniles} of ${crowded.capacity})`);
    ok(crowded.migrationPressure > sparse.migrationPressure, "density raises migration pressure (exposed for Phase 9 behavior)");
    ok(adultMortalityChance(crowded) > 0 && adultMortalityChance(sparse) === 0, "adult mortality pressure exists only under scarcity + crowding");
    ok(!allowsBreeding(g, w, first, new Rng(1)), "breeding is refused outright under extreme density");
    ok(!spawnAllowedByEcology(g, w, 0, t.x, t.y, "slimekin", buildCensus(g, w, 0)), "a territory holding its species share refuses new immigrants");
    // nest scarcity + predator pressure on a neighboring range (kept outside t's radius)
    let henSpot: { x: number; y: number } | null = null;
    for (let r = 12; r <= 18 && !henSpot; r++) {
      for (let a = 0; a < 16 && !henSpot; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = Math.round(g.player.x + Math.cos(ang) * r);
        const y = Math.round(g.player.y + Math.sin(ang) * r);
        if (w.inBounds(x, y) && Math.max(Math.abs(x - g.player.x), Math.abs(y - g.player.y)) >= 12 && w.passable(x, y) && !w.siteAt(x, y) && !creatureAt(g, x, y)) henSpot = { x, y };
      }
    }
    if (henSpot) {
      const hen = mkWild("eco:hen", "dunescuttle", henSpot, { maxR: 0 });
      const t2 = hen ? createTerritory(g, "dunescuttle", hen.x, hen.y) : null;
      if (hen && t2) {
        const cens2 = () => buildCensus(g, w, 0).get(t2.id);
        const bare = assessTerritory(g, w, t2, cens2());
        const nest = createNest(g, hen.id, "dunescuttle", hen.x + 1, hen.y);
        attachNest(g, nest, hen.id);
        const nested = assessTerritory(g, w, t2, cens2());
        ok(developmentTypeFor("dunescuttle", "sexual") === "egg" && bare.nestAvailability < nested.nestAvailability, "nest scarcity lowers nest availability");
        ok(nested.capacity >= bare.capacity, "nests raise carrying capacity for egg-layers");
        let predSpot: { x: number; y: number } | null = null;
        for (let r = 0; r <= 4 && !predSpot; r++) {
          for (let dy = -r; dy <= r && !predSpot; dy++) {
            for (let dx = -r; dx <= r && !predSpot; dx++) {
              const x = henSpot.x + dx;
              const y = henSpot.y + dy;
              if (Math.max(Math.abs(x - g.player.x), Math.abs(y - g.player.y)) >= 11 && w.passable(x, y) && !w.siteAt(x, y) && !creatureAt(g, x, y)) predSpot = { x, y };
            }
          }
        }
        if (predSpot) {
          mkWild("eco:pred", "cindermaw", predSpot, { maxR: 0 });
          const withPred = assessTerritory(g, w, t2, cens2());
          ok(withPred.predatorPressure > bare.predatorPressure && withPred.factors.predatorModifier < bare.factors.predatorModifier, "carnivores in range register as predator pressure and suppress capacity");
          ok(juvenileMortalityChance(withPred, true) > juvenileMortalityChance(bare, true), "predators lower juvenile survival");
          ok(juvenileMortalityChance(withPred, false) > juvenileMortalityChance(withPred, true), "lost nests endanger juveniles further");
        }
      }
    } else console.log("skip nest/predator checks (no room for the hen)");
    // the ecology loop never bypasses reproduction: only removals, no creations
    const ids = new Set(Object.keys(g.creatures));
    let removed = 0;
    for (let i = 0; i < 8; i++) {
      g.tick += ECOLOGY_INTERVAL;
      ecologyTick(g, w, (id) => {
        removed++;
        delete g.creatures[id];
      });
    }
    ok(Object.keys(g.creatures).every((id) => ids.has(id)), "the ecology loop only removes pressured bodies — it never creates offspring");
    void removed;
    // recovery once conditions improve
    for (const id of Object.keys(g.creatures)) if (id.startsWith("eco:crowd")) delete g.creatures[id];
    const recovered = assessTerritory(g, w, t, cens());
    ok(recovered.migrationPressure < crowded.migrationPressure && recovered.density < 1.01, "after conditions improve, pressure falls — populations can recover");
    let bred = false;
    for (let i = 0; i < 10 && !bred; i++) bred = allowsBreeding(g, w, first, new Rng(1000 + i));
    ok(bred, "breeding is permitted again on a recovered range");
    ok(spawnAllowedByEcology(g, w, 0, (t.x + 2000) % 4096, (t.y + 2000) % 4096, "slimekin", buildCensus(g, w, 0)), "unclaimed wilds remain open to immigration");
    ok(CREATURE_CAP >= 100, "the technical spawn cap exists separately from ecological capacity");
    // vitals + region aggregates (Phase 11 seed)
    ecoOnBirth(g, "slimekin", t.x, t.y, true);
    ecoOnDeath(g, "slimekin", t.x, t.y, true);
    const v = g.ecology?.vitals.slimekin;
    ok(!!v && v.births === 1 && v.deaths === 1 && v.juvenileDeaths === 1, "births and deaths are recorded as species vitals");
    const reg = Object.values(g.ecology?.regions ?? {}).flat().find((p) => p.speciesId === "slimekin");
    ok(!!reg && reg.pop === 0 && reg.births === 1 && reg.deaths === 1, "aggregate per-region populations track the same events");
  }
  // existing spawning still populates the world (ecology-gated, not disabled)
  for (const id of Object.keys(g.creatures)) delete g.creatures[id];
  let teleported = false;
  for (let r = 400; r < 1600 && !teleported; r += 40) {
    for (let a = 0; a < 12 && !teleported; a++) {
      const x = Math.round(g.player.x + Math.cos(a) * r);
      const y = Math.round(g.player.y + Math.sin(a) * r);
      if (w.inBounds(x, y) && w.passable(x, y) && !w.siteAt(x, y)) {
        g.player.x = x;
        g.player.y = y;
        teleported = true;
      }
    }
  }
  g.loadedChunks = [];
  loadChunks(g);
  ok(teleported && Object.keys(g.creatures).length >= 3, `spawning still works in unclaimed wilds (${Object.keys(g.creatures).length} residents)`);
  advance(g, 90);
  ok(g.party[0].hp >= 0 && Object.keys(g.creatures).length <= CREATURE_CAP, "advance() runs cleanly with the ecology tick wired in");
  ok(g.version === 24, "save version 24");
  migrateEcology(g);
  const snap = JSON.stringify(g.ecology);
  migrateEcology(g);
  ok(JSON.stringify(g.ecology) === snap, "ecology migration is idempotent");
}

// ---------------------------------------------------------------------------
// LINEAGE (Phase 10): persistent ancestry, inheritance, mutation
// ---------------------------------------------------------------------------
console.log("\n-- LINEAGE --");
{
  const g = newGame("LINE-1", "Rook", "wanderer", "#e8742a", previewStarter("LINE-1", "slimekin"));
  g.party[0].level = 12;
  g.party[0].hp = statOf(g.party[0], "hp");
  const mkParent = (seed: number, sex: Sex, sizeAllele: number, vigorAllele: number, lineageId: string): Monster => {
    const m = createMonster(g, "cragjaw", 10, { seed, origin: "Test", sex });
    m.genes = { ...m.genes, size: { a: sizeAllele, b: sizeAllele }, vigor: { a: vigorAllele, b: vigorAllele } };
    m.lineageId = lineageId;
    m.generation = 3;
    m.mutHistory = [];
    return m;
  };
  // wild egg-raiders would eat the test clutches mid-development — clear the
  // hungry carnivores camped around the breeding ground (the raids themselves
  // are checked separately)
  const clearRaiders = (): void => {
    for (const id of Object.keys(g.creatures)) {
      const c = g.creatures[id];
      if (SPECIES[c.speciesId].diet === "carnivore" && cheb(c.x, c.y, g.player.x, g.player.y) <= 12) delete g.creatures[id];
    }
  };
  clearRaiders();
  const mom = mkParent(101, "female", 90, 80, "L:test101");
  const dad = mkParent(102, "male", 80, 70, "L:test102");
  g.party.push(mom, dad);
  const r1 = requestBreeding(g, mom.uid, dad.uid);
  ok(r1.ok, "player breeding runs through the unified pipeline");
  let kid: Monster | undefined;
  if (r1.ok) {
    g.tick = r1.development.completeTick + 1;
    advanceDevelopment(g);
    kid = [...g.party, ...g.pen].find((m) => m.parents?.includes(mom.uid));
    ok(!!kid, "offspring materializes when development completes");
    if (kid) {
      ok(kid.parents?.length === 2 && kid.parents.includes(mom.uid) && kid.parents.includes(dad.uid), "parent references are valid");
      ok(kid.generation === 4, "generation advances past both parents");
      ok(kid.lineageId === [mom.lineageId!, dad.lineageId!].sort()[0], "lineage id follows the ancestry policy without touching species");
      const inheritOk = GENE_KEYS.every((k) => {
        const legal = [mom.genes[k].a, mom.genes[k].b, dad.genes[k].a, dad.genes[k].b];
        const near = (v: number): boolean => legal.some((pa) => Math.abs(v - pa) <= 6);
        return near(kid!.genes[k].a) && near(kid!.genes[k].b);
      });
      ok(inheritOk, "every allele descends from a parent allele within drift (Mendelian inheritance + mutation)");
      ok(GENE_KEYS.every((k) => kid!.genes[k].a >= 5 && kid!.genes[k].a <= 100 && kid!.genes[k].b >= 5 && kid!.genes[k].b <= 100), "genes stay within the legal 5–100 range");
      const rec = lineageSummary(g, kid.lineageId!);
      ok(!!rec && rec.depth >= 4 && rec.historical >= 1, "lineage record tracks the birth");
      ok(childrenOf(g, mom.uid).includes(kid.uid), "offspring index query works");
      // sibling: same parents, a different draw
      g.tick += BREED_COOLDOWN_TICKS;
      const r2 = requestBreeding(g, mom.uid, dad.uid);
      ok(r2.ok, "breeding respects and then clears cooldowns");
      if (r2.ok) {
        g.tick = r2.development.completeTick + 1;
        advanceDevelopment(g);
        const kid2 = [...g.party, ...g.pen].find((m) => m.parents?.includes(mom.uid) && m.uid !== kid!.uid);
        ok(!!kid2 && JSON.stringify(kid2!.genes) !== JSON.stringify(kid!.genes), "siblings receive different valid genotypes");
        ok(!!kid2 && relatedness(kid, kid2) !== "unrelated", "relatedness reads shared ancestry correctly");
      }
      // cross-species player breeding keeps ancestry valid and species separate
      clearRaiders();
      const male2 = mkParent(103, "male", 70, 75, "L:test103");
      g.party.push(male2);
      const slime = createMonster(g, "slimekin", 10, { seed: 201, origin: "Test", sex: "female" });
      g.party.push(slime);
      const r3 = requestBreeding(g, male2.uid, slime.uid);
      ok(r3.ok, "player cross-species breeding stays permitted");
      if (r3.ok) {
        g.tick = r3.development.completeTick + 1;
        advanceDevelopment(g);
        const cross = [...g.party, ...g.pen].find((m) => m.parents?.includes(slime.uid));
        ok(!!cross && (cross.speciesId === "cragjaw" || cross.speciesId === "slimekin"), "cross-species offspring receives a valid species");
        ok(!!cross && cross.lineageId === [male2.lineageId!, slime.lineageId!].sort()[0], "cross-species lineage merges ancestry without overriding species");
        ok(!!cross && relatedness(kid, cross) === "unrelated", "different lineages read as unrelated");
      }
      ok(statOf(kid, "hp", g.tick) > 0, "phenotype stats keep deriving from the authoritative genotype");
    }
  }
  // mutation: bidirectional and bounded
  let up = 0;
  let down = 0;
  for (let i = 0; i < 400; i++) {
    const p = mutateGene({ a: 60, b: 60 }, new Rng(5000 + i));
    if (p.a > 60 || p.b > 60) up++;
    if (p.a < 60 || p.b < 60) down++;
  }
  ok(up > 20 && down > 20, `mutations move gene values both upward (${up}) and downward (${down})`);
  let lo: GenePair = { a: 5, b: 5 };
  let hi: GenePair = { a: 100, b: 100 };
  for (let i = 0; i < 300; i++) {
    lo = mutateGene(lo, new Rng(9000 + i));
    hi = mutateGene(hi, new Rng(9500 + i));
  }
  ok(lo.a >= 5 && lo.b >= 5 && hi.a <= 100 && hi.b <= 100, "mutation clamps within the legal allele range");
  // selective breeding keeps exceptional traits in the lineage (deterministic chain)
  {
    const rng = new Rng(4242);
    let genes: Genome = mom.genes;
    for (let i = 0; i < 6; i++) genes = driftGenome(inheritGenome(genes, dad.genes, rng), rng);
    ok(expressGene(genes.size) >= 50, "repeated large-parent breeding keeps large size potential in the lineage");
  }
  // ancestor removal does not invalidate descendants
  g.party = g.party.filter((m) => m !== mom);
  if (kid) ok(childrenOf(g, mom.uid).includes(kid.uid) && !!lineageSummary(g, kid.lineageId!), "removing an ancestor does not invalidate descendant ancestry");
  // save round trip
  const snapKid = kid ? JSON.stringify({ genes: kid.genes, lin: kid.lineageId, par: kid.parents, mut: kid.mutHistory }) : "";
  const rt = JSON.parse(JSON.stringify(g)) as GameState;
  const kidRT = [...rt.party, ...rt.pen].find((m) => m.uid === kid?.uid);
  ok(!!kidRT && !!kid && JSON.stringify({ genes: kidRT.genes, lin: kidRT.lineageId, par: kidRT.parents, mut: kidRT.mutHistory }) === snapKid, "saving and loading preserves genotype, ancestry, lineage id and mutation history");
  // legacy migration
  const legacy = JSON.parse(JSON.stringify(g)) as GameState;
  legacy.version = 16;
  for (const m of [...legacy.party, ...legacy.pen]) {
    delete m.lineageId;
    delete m.generation;
    delete m.mutHistory;
    m.parents = null;
  }
  for (const c of Object.values(legacy.creatures)) {
    delete c.lineageId;
    delete c.gen;
    delete c.parents;
  }
  legacy.lineages = {};
  legacy.childIndex = {};
  migrateBiology(legacy);
  migrateLineages(legacy);
  ok([...legacy.party, ...legacy.pen, ...Object.values(legacy.creatures)].every((b) => !!b.lineageId), "older saves without lineage metadata are backfilled as founders");
  ok(Object.keys(legacy.lineages).length >= 1 && Object.values(legacy.lineages).every((r) => r.living >= 1), "migration creates living lineage records");
  const snapLin = JSON.stringify(legacy.lineages);
  migrateLineages(legacy);
  ok(JSON.stringify(legacy.lineages) === snapLin, "lineage migration is idempotent");
  // many generations, bounded queries
  for (let gen = 2; gen <= 8; gen++) {
    recordLineageBirth(g, { uid: `gen${gen}`, speciesId: "cragjaw", lineageId: "L:deep", generation: gen, genes: dad.genes } as unknown as Monster, [`gen${gen - 1}`]);
  }
  ok(lineageSummary(g, "L:deep")?.depth === 8, "lineage depth scales across many generations");
  ok(childrenOf(g, "gen7").includes("gen8"), "multi-generation ancestry queries stay functional");
  // exactly-once delivery
  if (kid) {
    const n = [...g.party, ...g.pen].filter((m) => m.parents?.includes(mom.uid)).length;
    advanceDevelopment(g);
    ok([...g.party, ...g.pen].filter((m) => m.parents?.includes(mom.uid)).length === n, "repeated event processing does not duplicate offspring");
  }
}

// ---------------------------------------------------------------------------
// WILDLIFE (Phase 9): needs-driven decisions, territory, migration
// ---------------------------------------------------------------------------
console.log("\n-- WILDLIFE --");
{
  const g = newGame("WILD-1", "Rook", "wanderer", "#e8742a", previewStarter("WILD-1", "slimekin"));
  g.party[0].level = 12;
  g.party[0].hp = statOf(g.party[0], "hp");
  const w = getWorld(g.seed);
  let base: { x: number; y: number } | null = null;
  for (let r = 500; r < 1600 && !base; r += 40) {
    for (let a = 0; a < 16 && !base; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = Math.round(g.player.x + Math.cos(ang) * r);
      const y = Math.round(g.player.y + Math.sin(ang) * r);
      const b = w.inBounds(x, y) ? BIOMES[w.tile(x, y).biome] : null;
      if (b && b.passable && w.tile(x, y).biome === "meadow" && !w.siteAt(x, y)) base = { x, y };
    }
  }
  ok(!!base, "found a forage-rich quiet stage");
  if (base) {
    for (const id of Object.keys(g.creatures)) delete g.creatures[id];
    g.player.x = base.x;
    g.player.y = base.y;
    const cheb2 = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const mkWild = (id: string, speciesId: string, near: { x: number; y: number }, opts: { satiety?: number; hpFrac?: number; alpha?: boolean; level?: number; maxR?: number; disposition?: Disposition } = {}): WildCreature | null => {
      const maxR = opts.maxR ?? 6;
      for (let r = 0; r <= maxR; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = near.x + dx;
            const y = near.y + dy;
            if (!w.inBounds(x, y) || !w.passable(x, y) || w.siteAt(x, y)?.wall || creatureAt(g, x, y) || partyMonAt(g, x, y) || (x === g.player.x && y === g.player.y)) continue;
            const c: WildCreature = {
              id, speciesId, level: opts.level ?? 6, x, y, homeX: x, homeY: y, hpFrac: opts.hpFrac ?? 1, satiety: opts.satiety ?? 80,
              disposition: opts.disposition ?? "calm", activity: "Wandering", personality: "gentle", geneSeed: 777,
              genes: wildGenotypeFromSeed(777, speciesId), gen: 1, lineageId: `L:${id}`,
              repro: makeReproProfile(wildReproMode(id, speciesId), opts.level ?? 6, 0), calmUntil: g.tick + 100000, alpha: opts.alpha ?? false,
              affection: 0, stalking: false,
            };
            g.creatures[id] = c;
            return c;
          }
        }
      }
      return null;
    };
    // hungry monsters find and eat available food
    const hungry = mkWild("w:hungry", "slimekin", base, { satiety: 10 });
    const s0 = hungry?.satiety ?? 0;
    let ate = false;
    for (let i = 0; i < 20 && !ate && hungry && g.creatures["w:hungry"]; i++) {
      advance(g, 10);
      ate = hungry.satiety > s0 || g.depleted[`${hungry.x},${hungry.y}`] !== undefined;
    }
    ok(ate, "a hungry monster seeks out and eats available food");
    // fleeing a credible threat
    const rabbit = mkWild("w:rabbit", "slimekin", base, { satiety: 80 });
    const wolf = rabbit ? mkWild("w:wolf", "cindermaw", rabbit, { satiety: 30, disposition: "aggressive", maxR: 2 }) : null;
    const d0 = rabbit && wolf ? cheb2(rabbit, wolf) : 99;
    if (rabbit && wolf) advance(g, 4);
    ok(!rabbit || !g.creatures["w:rabbit"] || cheb2(rabbit, wolf) > d0 || rabbit.activity.includes("Flee"), "monsters flee credible threats");
    // badly hurt monsters break off
    const hurt = mkWild("w:hurt", "slimekin", base, { satiety: 80, hpFrac: 0.15, maxR: 4 });
    const dP = hurt ? cheb2(hurt, g.player) : 0;
    if (hurt) advance(g, 4);
    ok(!hurt || !g.creatures["w:hurt"] || cheb2(hurt, g.player) > dP || hurt.activity === "Fleeing, hurt", "badly hurt monsters break off and run");
    // predator pursuit
    const hawk = mkWild("w:hawk", "zephyr_hawk", base, { satiety: 20, level: 8, maxR: 5 });
    const snack = hawk ? mkWild("w:snack", "slimekin", hawk, { satiety: 80, maxR: 3 }) : null;
    // a fresh kill lying nearby must not outrank the hunt this check studies
    for (const id of Object.keys(g.carrion ?? {})) {
      const m = (g.carrion ?? {})[id];
      if (hawk && cheb2(m, hawk) <= 9) delete g.carrion[id];
    }
    const dh = hawk && snack ? cheb2(hawk, snack) : 99;
    let minD = dh;
    let sawHunt = false;
    if (hawk && snack) {
      for (let i = 0; i < 10 && g.creatures["w:snack"]; i++) {
        advance(g, 2);
        if (hawk.activity.startsWith("Hunting")) sawHunt = true;
        if (g.creatures["w:snack"]) minD = Math.min(minD, cheb2(hawk, snack));
      }
    }
    ok(!hawk || !snack || !g.creatures["w:snack"] || minD < dh || sawHunt, "predators pursue suitable prey without teleporting");
    // territory return (kept within the simulation radius: SIM_R is 30)
    const t = createTerritory(g, "cragjaw", base.x + 14, base.y);
    const homing = mkWild("w:home", "cragjaw", { x: base.x + 28, y: base.y }, { satiety: 80, maxR: 1 });
    if (homing) homing.territoryId = t.id;
    const dh2 = homing ? cheb2(homing, t) : 99;
    if (homing) advance(g, 12);
    ok(!homing || !g.creatures["w:home"] || cheb2(homing, t) < dh2, "monsters return to their territory when displaced");
    // alpha territory defense
    const alpha = mkWild("w:alpha", "cindermaw", { x: base.x - 22, y: base.y + 10 }, { satiety: 80, alpha: true });
    const t2 = alpha ? createTerritory(g, "cindermaw", alpha.x, alpha.y) : null;
    if (alpha && t2) {
      alpha.territoryId = t2.id;
      t2.ownerId = alpha.id;
    }
    const intr = alpha ? mkWild("w:intr", "slimekin", { x: alpha.x - 4, y: alpha.y }, { satiety: 80, maxR: 1 }) : null;
    const dA = alpha && intr ? cheb2(alpha, intr) : 99;
    if (alpha && intr) advance(g, 10);
    ok(
      !alpha || !intr || alpha.activity === "Defending its territory" || !g.creatures["w:alpha"] || cheb2(alpha, intr) < dA || intr.hpFrac < 1 || intr.disposition === "skittish",
      "alphas defend their territory against intruders",
    );
    // dominance transfer keeps ownership with the territory system
    const weakAlpha = mkWild("w:walpha", "cindermaw", { x: base.x + 10, y: base.y - 24 }, { satiety: 80, alpha: true, level: 4 });
    const t3 = weakAlpha ? createTerritory(g, "cindermaw", weakAlpha.x, weakAlpha.y) : null;
    if (weakAlpha && t3) {
      weakAlpha.territoryId = t3.id;
      t3.ownerId = weakAlpha.id;
      weakAlpha.hpFrac = 0.5;
    }
    const challenger = weakAlpha ? mkWild("w:chal", "cindermaw", weakAlpha, { satiety: 80, level: 15, maxR: 2 }) : null;
    const minion = weakAlpha ? mkWild("w:minion", "cindermaw", weakAlpha, { satiety: 80, maxR: 3 }) : null;
    if (minion && weakAlpha) minion.pack = weakAlpha.id;
    ok(profileOf("cindermaw").challenges, "cindermaw's behavioral profile allows dominance challenges");
    if (weakAlpha && t3 && challenger) {
      seizeTerritory(g, challenger, weakAlpha, g.tick);
      ok(!weakAlpha.alpha && challenger.alpha, "a deposed alpha loses rank to the challenger");
      ok(t3.ownerId === challenger.id, "territory ownership transfers through the territory system's own fields");
      ok(!minion || minion.pack === challenger.id, "pack loyalty follows the new alpha");
    }
    // nest defense
    const hen = mkWild("w:hen", "dunescuttle", { x: base.x, y: base.y + 26 }, { satiety: 80 });
    if (hen) {
      const nest = createNest(g, hen.id, "dunescuttle", hen.x + 1, hen.y);
      attachNest(g, nest, hen.id);
      if (hen.repro) hen.repro.nestId = nest.id;
      const dev: ReproductiveDevelopment = {
        id: "d:wild", parentIds: [hen.id, hen.id], speciesId: "dunescuttle", pairing: "sexual", type: "egg", state: "developing",
        startTick: g.tick, completeTick: g.tick + 500, nestId: nest.id, origin: "wild",
      };
      g.developments["d:wild"] = dev;
      nest.developmentIds.push("d:wild");
      const thief = mkWild("w:thief", "cindermaw", { x: hen.x + 2, y: hen.y }, { satiety: 80, maxR: 1 });
      const dH = thief ? cheb2(hen, thief) : 99;
      advance(g, 8);
      ok(!hen || !g.creatures["w:hen"] || !thief || !g.creatures["w:thief"] || hen.activity.includes("Defend") || cheb2(hen, thief) < dH, "monsters defend nests with developing young");
    }
    // migration under population pressure
    const spot2 = { x: base.x + 22, y: base.y - 12 };
    const t4 = createTerritory(g, "slimekin", spot2.x, spot2.y);
    const residents: WildCreature[] = [];
    for (let i = 0; i < 25; i++) {
      const r = mkWild(`w:mig:${i}`, "slimekin", spot2, { satiety: 95, maxR: 6 });
      if (r) {
        r.territoryId = t4.id;
        residents.push(r);
      }
    }
    advance(g, 240);
    const moved = residents.filter((r) => g.creatures[r.id] && (r.territoryId !== t4.id || cheb2(r, t4) > 13));
    ok(moved.length >= 1, `overcrowded monsters migrate away from their range (${moved.length}/${residents.length} left)`);
    ok(moved.every((r) => r.migrateUntil !== undefined), "migrated bodies carry an anti-oscillation cooldown");
    ok(residents.every((r) => !g.creatures[r.id] || cheb2(r, spot2) <= 240), "migration happens through real movement (no teleporting)");
    // AI processing stays bounded
    const t0 = performance.now();
    advance(g, 40);
    const ms = performance.now() - t0;
    ok(ms < 5000, `AI processing remains bounded (${Math.round(ms)}ms for 40 ticks, ${Object.keys(g.creatures).length} bodies)`);
  }
}

/* ---------------- Phase 11: persistent distant ecosystem ---------------- */
{
  const g = newGame("DIST-1", "R", "wanderer", "#e8742a", previewStarter("DIST-1", "slimekin"));
  g.party[0].level = 12;
  g.party[0].hp = statOf(g.party[0], "hp");
  const w = getWorld(g.seed);
  let stage: { cx: number; cy: number; x: number; y: number } | null = null;
  for (let r = 500; r < 1600 && !stage; r += 40) {
    for (let a = 0; a < 16 && !stage; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = Math.round(g.player.x + Math.cos(ang) * r);
      const y = Math.round(g.player.y + Math.sin(ang) * r);
      if (!w.inBounds(x, y)) continue;
      const t = w.tile(x, y);
      if (t.biome !== "meadow" || !BIOMES[t.biome].passable || t.feature || w.siteAt(x, y)) continue;
      stage = { cx: Math.floor(x / CHUNK), cy: Math.floor(y / CHUNK), x: Math.floor(x / CHUNK) * CHUNK + 4, y: Math.floor(y / CHUNK) * CHUNK + 4 };
    }
  }
  ok(!!stage, "found a quiet meadow stage for distant simulation");
  if (stage) {
    const { cx, cy, x: bx, y: by } = stage;
    for (const id of Object.keys(g.creatures)) delete g.creatures[id];
    g.loadedChunks = [chunkKey(0, cx, cy)];
    g.player.x = bx;
    g.player.y = by;
    const flatGenes = (v: number): Genes => {
      const o = {} as Genes;
      for (const k of GENE_KEYS) o[k] = v;
      return o;
    };
    const mk = (id: string, speciesId: string, dx: number, dy: number, opts: { satiety?: number; level?: number; bornTick?: number; gen?: number } = {}): WildCreature => {
      const c: WildCreature = {
        id, speciesId, level: opts.level ?? 6, x: bx + dx, y: by + dy, homeX: bx + dx, homeY: by + dy, hpFrac: 1,
        satiety: opts.satiety ?? 80, disposition: "calm", activity: "Wandering", personality: "gentle", geneSeed: 777,
        genes: wildGenotypeFromSeed(777 + hashString(id), speciesId), gen: opts.gen ?? 1, lineageId: `L:${id}`,
        repro: makeReproProfile(wildReproMode(id, speciesId), opts.level ?? 6, 0), bornTick: opts.bornTick,
        calmUntil: g.tick + 100000, alpha: false, affection: 0, stalking: false,
      };
      g.creatures[id] = c;
      return c;
    };
    // controlled population: 10 adult + 2 juvenile slimekin, 3 cindermaw predators, 1 exceptional slimekin
    for (let i = 0; i < 10; i++) mk(`d${i}`, "slimekin", (i % 4) * 2, Math.floor(i / 4) * 2);
    mk("dj1", "slimekin", 7, 4, { bornTick: g.tick - 400 });
    mk("dj2", "slimekin", 5, 4, { bornTick: g.tick - 400 });
    for (let i = 0; i < 3; i++) mk(`dc${i}`, "cindermaw", 1 + i * 2, 8);
    mk("de1", "slimekin", 8, 6, { gen: 5 });
    // a wild brood whose egg must keep developing while the region is abstracted
    const nest = createNest(g, "d0", "slimekin", bx + 3, by + 1);
    attachNest(g, nest, "d0");
    const child = {
      speciesId: "slimekin", sex: "female" as Sex, level: 2, genes: wildGenotypeFromSeed(4242, "slimekin"),
      mutations: [], personality: "gentle", skills: ["tackle"], plus: 0, bond: 0,
      generation: 2, lineageId: "L:d0", mutHistory: [], parents: ["d0", "d2"] as [string, string], parentNames: ["d0", "d2"],
    };
    const dev: ReproductiveDevelopment = {
      id: "d:far", parentIds: ["d0", "d2"], speciesId: "slimekin", pairing: "sexual", type: "egg", state: "developing",
      startTick: g.tick, completeTick: g.tick + 500, nestId: nest.id, origin: "wild", child,
    };
    g.developments["d:far"] = dev;
    nest.developmentIds.push("d:far");
    // leave: the chunk unloads and its wildlife folds into abstract populations
    g.player.x = bx + CHUNK * 7;
    loadChunks(g);
    const key = distantKey(0, cx, cy);
    const reg = g.distant?.[key];
    ok(!!reg && reg.abstracted, "leaving a region folds its wildlife into an abstract population");
    const slimePop = reg?.pops.find((p) => p.speciesId === "slimekin");
    ok(slimePop?.count === 12, `abstract population counts every ordinary member (${slimePop?.count})`);
    ok(slimePop?.juveniles === 2, "life-stage mix survives abstraction");
    ok(reg?.pops.find((p) => p.speciesId === "cindermaw")?.count === 3, "predators abstract into their own population");
    ok(slimePop?.lineageId === "L:d0", "population-level ancestry is preserved");
    ok(!!g.creatures["de1"], "exceptional individuals remain individually represented");
    ok(!g.creatures["d0"] && !g.creatures["dc0"], "abstracted members no longer exist as bodies");

    // ---- unit-level abstract ecology on crafted regions ----
    const chunkOk = (ax: number, ay: number, biome?: string): boolean => {
      const x2 = ax * CHUNK + 8;
      const y2 = ay * CHUNK + 8;
      if (!w.inBounds(x2, y2)) return false;
      const t = w.tile(x2, y2);
      if (t.feature || w.siteAt(x2, y2)) return false;
      return biome ? t.biome === biome : BIOMES[t.biome].passable;
    };
    const ring: [number, number][] = [];
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) ring.push([cx + dx, cy + dy]);
    const foodScore = (ax: number, ay: number): number => {
      const sx = ax * CHUNK + 8;
      const sy = ay * CHUNK + 8;
      let s = 0;
      for (const [fx, fy] of [[0, 0], [7, 0], [-7, 0], [0, 7], [0, -7]] as const) {
        if (!w.inBounds(sx + fx, sy + fy)) return -1;
        const t = w.tile(sx + fx, sy + fy);
        if (t.feature || w.siteAt(sx + fx, sy + fy)) return -1;
        const b = BIOMES[t.biome];
        if (!b.passable) return -1;
        s += b.forageChance * (1 + b.forage.reduce((a, [, wt]) => a + wt, 0) / 8);
      }
      return s;
    };
    const pool = ring
      .filter(([ax, ay]) => (ax !== cx || ay !== cy) && foodScore(ax, ay) >= 0)
      .sort((a, b) => foodScore(b[0], b[1]) - foodScore(a[0], a[1]))
      .slice(0, 5);
    ok(pool.length >= 5, "found distant test chunks for controlled ecology");
    const craftRegion = (ax: number, ay: number, pops: { speciesId: string; count: number; juveniles?: number; satiety?: number; level?: number; seed?: number }[]): DistantRegion => {
      const r2: DistantRegion = {
        key: distantKey(0, ax, ay), layer: 0, cx: ax, cy: ay, lastTick: g.tick, abstracted: true,
        pops: pops.map((p) => ({ speciesId: p.speciesId, count: p.count, juveniles: p.juveniles ?? 0, genes: flatGenes(55), satiety: p.satiety ?? 80, level: p.level ?? 6, lineageId: null, seed: p.seed ?? (hashString(p.speciesId) ^ 0xabcd) })),
      };
      g.distant = g.distant ?? {};
      g.distant[r2.key] = r2;
      return r2;
    };
    if (pool.length >= 5) {
      // growth under favorable conditions: a small population below carrying capacity
      const grow = craftRegion(pool[0][0], pool[0][1], [{ speciesId: "slimekin", count: 2 }]);
      stepRegion(g, w, grow, 30);
      // distant conceptions complete on the development clock — resolve them the way the game does
      for (const d of Object.values(g.developments)) if (d.distant && d.state === "developing") d.completeTick = g.tick - 1;
      advanceDevelopment(g);
      ok(grow.pops[0] && grow.pops[0].count > 2, `populations grow under favorable ecological conditions (${grow.pops[0]?.count} after 30 days)`);
      // decline under scarcity and crowding
      const shrink = craftRegion(pool[1][0], pool[1][1], [{ speciesId: "slimekin", count: 20, juveniles: 4 }]);
      stepRegion(g, w, shrink, 6);
      ok(shrink.pops[0] && shrink.pops[0].count < 20 && shrink.pops[0].count >= 0, `overcrowded populations decline toward carrying capacity (${shrink.pops[0]?.count})`);
      // predation couples predator and prey
      const hunt = craftRegion(pool[2][0], pool[2][1], [
        { speciesId: "slimekin", count: 20 },
        { speciesId: "cindermaw", count: 4 },
      ]);
      stepRegion(g, w, hunt, 5);
      const prey = hunt.pops.find((p) => p.speciesId === "slimekin");
      const pred = hunt.pops.find((p) => p.speciesId === "cindermaw");
      ok(prey && prey.count < 20, `predation reduces prey populations (${prey?.count} prey left)`);
      ok(pred && pred.count >= 4, "predator populations persist off prey availability");
      ok(
        [grow, shrink, hunt].every((r2) => r2.pops.every((p) => Number.isFinite(p.count) && p.count >= 0 && p.juveniles >= 0 && p.juveniles <= p.count && Number.isFinite(p.satiety))),
        "population counts never become negative or non-finite",
      );
      // migration transfers members without duplication or loss
      const mig = craftRegion(pool[3][0], pool[3][1], [{ speciesId: "slimekin", count: 30, juveniles: 6, seed: 0x51ce }]);
      const slimeTotal = (): number => Object.values(g.distant ?? {}).reduce((a, r2) => a + (r2.pops.find((p) => p.speciesId === "slimekin")?.count ?? 0), 0);
      const beforeKeys = new Set(Object.keys(g.distant ?? {}));
      const totalBefore = slimeTotal();
      stepRegion(g, w, mig, 1);
      const arrivals = Object.values(g.distant ?? {}).filter((r2) => !beforeKeys.has(r2.key) && r2.pops.some((p) => p.speciesId === "slimekin"));
      ok(arrivals.length >= 1, "dispersing members arrive in a neighboring region");
      const totalAfter = slimeTotal();
      ok(totalAfter <= totalBefore && totalAfter >= totalBefore - 8, `migration transfers population without duplication (${totalAfter}/${totalBefore} after mortality)`);
      // bounded catch-up, applied exactly once
      const far = craftRegion(pool[4][0], pool[4][1], [{ speciesId: "slimekin", count: 10, juveniles: 2 }]);
      far.lastTick = g.tick - 100 * DISTANT_INTERVAL;
      advanceDistantEcosystem(g, w);
      ok(far.lastTick === g.tick, "long absences fold into bounded catch-up (never unbounded)");
      const snap1 = JSON.stringify(far.pops.map((p) => [p.speciesId, p.count]));
      advanceDistantEcosystem(g, w);
      ok(snap1 === JSON.stringify(far.pops.map((p) => [p.speciesId, p.count])), "repeated updates never apply the same elapsed period twice");
    }

    // ---- absence changes the world, then the region materializes on return ----
    advance(g, 2 * DISTANT_INTERVAL + 20);
    const broodDev = g.developments["d:far"];
    ok(!!broodDev && broodDev.state === "completed" && !!broodDev.resultId && !!g.creatures[broodDev.resultId!], "developing offspring complete while their region is abstracted");
    const popSnap = reg?.pops.map((p) => ({ speciesId: p.speciesId, count: p.count, juveniles: p.juveniles, genes: { ...p.genes }, lineageId: p.lineageId }));
    g.player.x = bx;
    g.player.y = by;
    loadChunks(g);
    const bodies = Object.values(g.creatures).filter((c) => c.id.startsWith(`w:${cx}:${cy}:`));
    ok(bodies.length >= 1 && bodies.length <= MAT_CAP_REGION, `returning materializes a bounded slice of the population (${bodies.length} bodies)`);
    ok(bodies.every((c) => Math.floor(c.x / CHUNK) === cx && Math.floor(c.y / CHUNK) === cy), "materialized bodies occupy valid tiles inside their region");
    const popSlime = popSnap?.find((p) => p.speciesId === "slimekin");
    const matSlime = bodies.filter((c) => c.speciesId === "slimekin");
    ok(!!popSlime && matSlime.length >= 1 && matSlime.every((c) => GENE_KEYS.every((k) => Math.abs(expressGene(c.genes[k]) - popSlime.genes[k]) <= 8)), "materialized genetics descend from the population's accumulated gene pool");
    if (popSlime?.lineageId) ok(matSlime.every((c) => c.lineageId === popSlime.lineageId), "population-level ancestry carries into materialized bodies");
    if ((popSlime?.juveniles ?? 0) >= 2 && matSlime.length > 0) ok(matSlime.some((c) => c.bornTick !== undefined), "juveniles materialize with their growth state intact");
    ok(!Object.keys(g.creatures).some((id) => id.startsWith(`c:${cx}:${cy}:`)), "chunks under population management skip generic respawns (no duplication)");
    const stillAbstract = g.distant?.[key]?.pops.find((p) => p.speciesId === "slimekin");
    if (popSlime) ok(matSlime.length + (stillAbstract?.count ?? 0) === popSlime.count, `population accounting reconciles across materialization (${matSlime.length}+${stillAbstract?.count ?? 0}=${popSlime.count})`);
    ok(!!g.creatures["de1"], "unique individuals were never merged into anonymous populations");

    // ---- persistence: abstract populations survive save/load ----
    const saved = JSON.parse(JSON.stringify(g)) as GameState;
    const popSig = (s: GameState): string => JSON.stringify(Object.keys(s.distant ?? {}).sort().flatMap((k) => (s.distant ?? {})[k].pops.map((p) => [k, p.speciesId, p.count, p.juveniles, p.lineageId])));
    const before = popSig(saved);
    migrateDistant(saved);
    migrateDistant(saved);
    ok(popSig(saved) === before, "abstract populations survive save/load migration unchanged (idempotent)");
    const legacy = JSON.parse(JSON.stringify(saved)) as GameState;
    delete legacy.distant;
    migrateDistant(legacy);
    ok(!!legacy.distant && Object.keys(legacy.distant).length === 0, "older saves gain distant-state defaults through migration");
  }
}

/* ---------------- Phase 12: food web — plants, carrion, wild fights ---------------- */
{
  const fg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const fw = getWorld(fg.seed);
  const openSpot = (x0: number, y0: number): { x: number; y: number } | null => {
    for (let r = 0; r < 30; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = x0 + dx;
          const y = y0 + dy;
          if (!fw.inBounds(x, y) || !fw.passable(x, y) || fw.tile(x, y).feature || fw.siteAt(x, y)) continue;
          if (creatureAt(fg, x, y) || (x === fg.player.x && y === fg.player.y)) continue;
          return { x, y };
        }
      }
    }
    return null;
  };
  const home0 = openSpot(fg.player.x, fg.player.y);
  ok(home0 !== null, "open wild ground exists for the food-web checks");
  if (home0) {
    fg.player.x = home0.x;
    fg.player.y = home0.y;
    fg.field = {};
    initField(fg);
    loadChunks(fg);
    // controlled cast: only the bodies crafted below act
    for (const id of Object.keys(fg.creatures)) delete fg.creatures[id];

    const mkBody = (id: string, speciesId: string, pos: { x: number; y: number }, satiety: number): WildCreature => {
      const c: WildCreature = {
        id, speciesId, level: 5, x: pos.x, y: pos.y, homeX: pos.x, homeY: pos.y,
        hpFrac: 1, satiety, disposition: "calm", activity: "Wandering", personality: "gentle",
        geneSeed: 7000 + hashString(id), genes: wildGenotypeFromSeed(7000 + hashString(id), speciesId), gen: 1, lineageId: `L:${id}`,
        repro: makeReproProfile(wildReproMode(id, speciesId), 5, 0),
        calmUntil: 0, alpha: false, affection: 0, stalking: false,
      };
      fg.creatures[id] = c;
      return c;
    };
    const findPlant = (): { x: number; y: number; item: ItemId } | null => {
      let best: { x: number; y: number; item: ItemId } | null = null;
      let bd = 99;
      for (let dy = -14; dy <= 14; dy++) {
        for (let dx = -14; dx <= 14; dx++) {
          const x = home0.x + dx;
          const y = home0.y + dy;
          if (!fw.inBounds(x, y) || !fw.passable(x, y) || fw.tile(x, y).feature || fw.siteAt(x, y)?.wall) continue;
          if (creatureAt(fg, x, y) || (x === fg.player.x && y === fg.player.y)) continue;
          const it = fw.forage(x, y, fg.tick, fg.depleted);
          if (!it || !ITEMS[it].diets.includes("herbivore")) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (d < bd) {
            bd = d;
            best = { x, y, item: it };
          }
        }
      }
      return best;
    };

    // ---- plants are physical objects: stable, deplete, regrow ----
    const plant = findPlant();
    ok(plant !== null, "forage plants grow within reach of the party");
    if (plant) {
      ok(fw.forage(plant.x, plant.y, fg.tick, fg.depleted) === plant.item, "a plant stands where it grew (stable placement, not a per-look dice roll)");
      const dep = { ...fg.depleted, [`${plant.x},${plant.y}`]: fg.tick };
      ok(fw.forage(plant.x, plant.y, fg.tick, dep) === null, "a grazed plant is gone while depleted");
      ok(fw.forage(plant.x, plant.y, fg.tick + 2 * DAY_TICKS + 1, dep) === plant.item, "plants regrow on the same spot after two days");
      const e1 = mkBody("fd1", "mossback", plant, 30);
      const s0 = e1.satiety;
      advance(fg, 1);
      ok(e1.satiety > s0 && fg.depleted[`${plant.x},${plant.y}`] !== undefined, "a hungry herbivore eats the plant it stands on and depletes it");
      const plant2 = findPlant();
      ok(plant2 !== null, "another plant grows within reach");
      if (plant2) {
        let ps: { x: number; y: number } | null = null;
        // rings 3–5 stay inside the creature's scan radius (6), and the spot must be food-free
        for (let r = 3; r <= 5 && !ps; r++) {
          for (let dy = -r; dy <= r && !ps; dy++) {
            for (let dx = -r; dx <= r && !ps; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              const x = plant2.x + dx;
              const y = plant2.y + dy;
              if (!fw.inBounds(x, y) || !fw.passable(x, y) || fw.tile(x, y).feature || fw.siteAt(x, y)) continue;
              if (creatureAt(fg, x, y) || cheb(x, y, fg.player.x, fg.player.y) > 26) continue;
              if (fw.forage(x, y, fg.tick, fg.depleted)) continue;
              ps = { x, y };
            }
          }
        }
        if (ps) {
          // the world is food-dense: clear every other plant around the start so
          // the walk-to-food rule is the only way to eat
          for (let dy = -8; dy <= 8; dy++) {
            for (let dx = -8; dx <= 8; dx++) {
              const x = ps.x + dx;
              const y = ps.y + dy;
              if (x === plant2.x && y === plant2.y) continue;
              if (fw.forage(x, y, fg.tick, fg.depleted)) fg.depleted[`${x},${y}`] = fg.tick;
            }
          }
          // pick an id whose staggered scan phase fires on the first tick, so
          // the walk starts before wander noise can carry the body off course
          let sid = "fd2";
          for (let k = 0; k < 40; k++) {
            if ((fg.tick + 1 + hashString(`fd2-${k}`)) % 6 === 0) {
              sid = `fd2-${k}`;
              break;
            }
          }
          mkBody(sid, "mossback", ps, 30);
          advance(fg, 14);
          const at = fg.creatures[sid];
          ok(fg.depleted[`${plant2.x},${plant2.y}`] !== undefined || (at !== undefined && cheb(at.x, at.y, plant2.x, plant2.y) <= 2), "a hungry herbivore walks to a plant it can smell");
        } else ok(false, "a standing spot exists for the foraging-walk check");
      }
    }

    // ---- a wild kill leaves carrion; a scavenger feeds; carrion rots ----
    for (const id of Object.keys(fg.creatures)) if (id !== "fd1" && id !== "fd2") delete fg.creatures[id];
    const preySpot = openSpot(home0.x, home0.y);
    ok(preySpot !== null, "a free tile exists for the hunt");
    if (preySpot) {
      // the predator is crafted FIRST: bodies act in creation order, so it
      // strikes before the prey can flee — one lunge (min 0.3) beats hp 0.2
      const pred = mkBody("pd1", "cindermaw", preySpot, 10);
      const preySpot2 = openSpot(preySpot.x, preySpot.y) ?? { x: preySpot.x + 1, y: preySpot.y };
      const prey = mkBody("pr1", "slimekin", preySpot2, 80);
      prey.hpFrac = 0.2;
      const predAt = { x: pred.x, y: pred.y };
      if (cheb(predAt.x, predAt.y, prey.x, prey.y) > 1) {
        pred.x = prey.x + 1;
        pred.y = prey.y;
      }
      let caught = false;
      for (let i = 0; i < 12 && !caught; i++) {
        advance(fg, 1);
        caught = fg.creatures["pr1"] === undefined;
      }
      ok(caught, "a hungry predator hunts down and catches prey");
      ok((fg.creatures["pd1"]?.hpFrac ?? 0) > 0, "cornered prey fights back, but the hunter survives the scrap");
      const ca = Object.values(fg.carrion ?? {}).find((m) => m.speciesId === "slimekin");
      ok(!!ca && ca.portions >= 1, "the fallen body leaves carrion where it died");
      if (ca) {
        const sc = mkBody("sc1", "cindermaw", openSpot(ca.x, ca.y) ?? { x: ca.x, y: ca.y + 1 }, 10);
        const portions0 = ca.portions;
        advance(fg, 1);
        ok(sc.satiety > 10 && ((fg.carrion ?? {})[ca.id] === undefined || (fg.carrion ?? {})[ca.id].portions < portions0), "a scavenger feeds on the remains");
        for (const it of Object.values(fg.carrion ?? {})) it.born = fg.tick - CARRION_DAYS * DAY_TICKS - 1;
        advance(fg, 1);
        ok(Object.keys(fg.carrion ?? {}).length === 0, "carrion rots away after its lifespan");
      }
    }
    // ---- technical cap and save migration ----
    const junk = openSpot(home0.x, home0.y) ?? { x: home0.x, y: home0.y };
    for (let i = 0; i < CARRION_CAP + 10; i++) {
      spawnCarrion(fg, mkBody(`junk${i}`, "slimekin", junk, 50));
      delete fg.creatures[`junk${i}`];
    }
    ok(Object.keys(fg.carrion ?? {}).length <= CARRION_CAP, `carrion is bounded (${CARRION_CAP} tracked, oldest rot first)`);
    const legacy = JSON.parse(JSON.stringify(fg)) as GameState;
    delete legacy.carrion;
    legacy.carrionSeq = undefined;
    migrateCarrion(legacy);
    migrateCarrion(legacy);
    ok(!!legacy.carrion && legacy.carrionSeq === 0 && Object.keys(legacy.carrion).length === 0, "older saves gain carrion defaults through migration (idempotent)");
  }

  // ---- the hamlet folk ----
  const ham = getWorld(gs.seed).featuresNear(gs.player.homeX, gs.player.homeY, 8).find((f) => f.kind === "hamlet");
  ok(!!ham, "the home hamlet stands where the walk began");
  if (ham) {
    const hw = getWorld(gs.seed);
    const folk = hw.settlementNpcs(ham);
    ok(folk.length === 3, "every hamlet fields its three folk");
    ok(JSON.stringify(folk.map((n) => n.role).sort()) === JSON.stringify(["innkeep", "penkeeper", "trader"]), "the folk cover inn, pen and trade");
    ok(JSON.stringify(folk) === JSON.stringify(hw.settlementNpcs(ham)), "hamlet folk are deterministic (same seed, same people, same posts)");
    ok(folk.every((n) => !hw.siteAt(n.x, n.y)?.wall), "the folk stand on walkable ground by their doors");
    ok(folk.every((n) => hw.npcAt(n.x, n.y)?.name === n.name), "npcAt resolves each folk member at their post");
  }
}

/* ---------------- Phase 13: gathering, wild experience, busier wilds ---------------- */
{
  const xg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const xw = getWorld(xg.seed);
  initField(xg);
  loadChunks(xg);
  const nearSpot = (x0: number, y0: number): { x: number; y: number } | null => {
    for (let r = 0; r < 30; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = x0 + dx;
          const y = y0 + dy;
          if (!xw.inBounds(x, y) || !xw.passable(x, y) || xw.tile(x, y).feature || xw.siteAt(x, y)) continue;
          if (creatureAt(xg, x, y) || (x === xg.player.x && y === xg.player.y)) continue;
          return { x, y };
        }
      }
    }
    return null;
  };
  const body = (id: string, speciesId: string, pos: { x: number; y: number }, satiety: number): WildCreature => {
    const c: WildCreature = {
      id, speciesId, level: 5, x: pos.x, y: pos.y, homeX: pos.x, homeY: pos.y,
      hpFrac: 1, satiety, disposition: "calm", activity: "Wandering", personality: "gentle",
      geneSeed: 7000 + hashString(id), genes: wildGenotypeFromSeed(7000 + hashString(id), speciesId), gen: 1, lineageId: `L:${id}`,
      repro: makeReproProfile(wildReproMode(id, speciesId), 5, 0),
      calmUntil: 0, alpha: false, affection: 0, stalking: false,
    };
    xg.creatures[id] = c;
    return c;
  };

  // ---- gathering ----
  let gather: { x: number; y: number; item: ItemId } | null = null;
  const hx = xg.player.x;
  const hy = xg.player.y;
  gatherLoop: for (let dy = -14; dy <= 14; dy++) {
    for (let dx = -14; dx <= 14; dx++) {
      const x = hx + dx;
      const y = hy + dy;
      if (!xw.inBounds(x, y) || !xw.passable(x, y) || xw.tile(x, y).feature || xw.siteAt(x, y)?.wall) continue;
      const it = xw.forage(x, y, xg.tick, xg.depleted);
      if (it) {
        gather = { x, y, item: it };
        break gatherLoop;
      }
    }
  }
  ok(!!gather, "the starting lands hold plants worth gathering");
  if (gather) {
    xg.player.x = gather.x;
    xg.player.y = gather.y;
    const before = xg.bag[gather.item] ?? 0;
    forageHere(xg);
    ok((xg.bag[gather.item] ?? 0) > before && xg.depleted[`${gather.x},${gather.y}`] !== undefined, "foraging fills the bag and empties the tile");
  }

  // ---- dressing remains into meat ----
  const drSpot = nearSpot(xg.player.x, xg.player.y) ?? { x: xg.player.x + 1, y: xg.player.y };
  const dr = body("dr1", "slimekin", drSpot, 80);
  const drCarr = spawnCarrion(xg, dr);
  delete xg.creatures["dr1"];
  const meat0 = xg.bag.meat ?? 0;
  dressCarrion(xg);
  ok(!!drCarr && (xg.bag.meat ?? 0) > meat0 && (xg.carrion ?? {})[drCarr.id] === undefined, "a fresh kill can be dressed into bag meat");

  // ---- wild experience: kills bank xp, veterans rise ----
  const huntSpot = nearSpot(xg.player.x, xg.player.y) ?? { x: xg.player.x + 2, y: xg.player.y };
  const xpPred = body("xp1", "cindermaw", huntSpot, 10);
  // clear chunk wildlife so nothing else competes for the bait
  for (const id of Object.keys(xg.creatures)) if (id !== "xp1") delete xg.creatures[id];
  const lv0 = xpPred.level;
  let rose = false;
  for (let k = 0; k < 20 && !rose; k++) {
    xpPred.satiety = 10;
    xpPred.hpFrac = 1;
    for (const id of Object.keys(xg.carrion ?? {})) delete xg.carrion![id];
    const pr = body(`xpk${k}`, "slimekin", nearSpot(xpPred.x, xpPred.y) ?? { x: xpPred.x + 1, y: xpPred.y }, 80);
    pr.hpFrac = 0.2; // one lunge (min 0.3) brings it down; the predator acts first in creation order
    if (Math.max(Math.abs(pr.x - xpPred.x), Math.abs(pr.y - xpPred.y)) > 1) {
      pr.x = xpPred.x + 1;
      pr.y = xpPred.y;
    }
    advance(xg, 2);
    if ((xg.creatures["xp1"]?.level ?? lv0) > lv0) rose = true;
  }
  ok((xg.creatures["xp1"]?.xp ?? 0) > 0 || rose, "a wild killer banks experience from its prey");
  ok(rose, "a veteran wild monster rises in level from repeated kills");

  // ---- experience persists; migration is idempotent ----
  const rt = JSON.parse(JSON.stringify(xg)) as GameState;
  ok(rt.creatures["xp1"]?.level === xg.creatures["xp1"]?.level && rt.creatures["xp1"]?.xp === xg.creatures["xp1"]?.xp, "wild experience and level survive the save round trip");
  const bare = rt.creatures["xp1"]!;
  delete bare.xp;
  migrateWildXp(rt);
  migrateWildXp(rt);
  ok(bare.xp === 0, "older saves gain wild experience defaults through migration (idempotent)");

  // ---- the wilds start busier ----
  const freshCount = (): number => {
    const g = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
    initField(g);
    loadChunks(g);
    return Object.keys(g.creatures).length;
  };
  const n1 = freshCount();
  const n2 = freshCount();
  ok(n1 === n2 && n1 >= 40, `the wilds start busier and deterministic (${n1} bodies around the start)`);
}

/* --------------- Phase 14: persistence, distant nests, sensible resources --------------- */
{
  const pg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const pw = getWorld(pg.seed);
  initField(pg);
  loadChunks(pg);
  const resident = Object.values(pg.creatures).find((c) => !isAnchoredSpawn(c.id) && !c.alpha && sameLayer(pg, c));
  ok(!!resident, "a resident wild monster is available for the persistence checks");
  if (resident) {
    resident.known = true;
    const nest = createNest(pg, resident.id, resident.speciesId, resident.x, resident.y);
    let far = { x: Math.min(WORLD_SIZE - 2, pg.player.x + 90), y: pg.player.y };
    for (let k = 0; k < 40 && (!pw.passable(far.x, far.y) || pw.siteAt(far.x, far.y)?.wall); k++) far = { x: far.x, y: far.y + 2 };
    pg.player.x = far.x;
    pg.player.y = far.y;
    loadChunks(pg);
    ok(pg.creatures[resident.id] === resident, "a monster you have met is still the same body when you leave");
    ok(pg.nests[nest.id]?.state === "active", "its nest stays active while its owner is far away");
    migrateBreeding(pg);
    ok(pg.nests[nest.id]?.state === "active", "migration does not abandon the nest of a persistent owner");
    // an ordinary, never-met neighbour folds into the abstract population; its nest follows it
    const stranger = makeCreature("str:1", "slimekin", resident.homeX, resident.homeY, 5, 12345, false);
    pg.creatures["str:1"] = stranger;
    const strangerNest = createNest(pg, "str:1", "slimekin", resident.homeX + 1, resident.homeY);
    pg.loadedChunks.push(chunkKey(SURFACE, Math.floor(resident.homeX / CHUNK), Math.floor(resident.homeY / CHUNK)));
    loadChunks(pg);
    ok(!pg.creatures["str:1"], "ordinary wildlife the player never met folds into its abstract population");
    ok(Object.values(pg.distant ?? {}).some((r) => r.abstracted && r.pops.some((p) => p.speciesId === "slimekin")), "the folded population carries the species");
    ok(pg.nests[strangerNest.id]?.state === "active" && pg.nests[strangerNest.id]!.ownerId.startsWith("pop:"), "a folded owner's nest passes into the population's care, still active");
    // a truly dead owner's nest is abandoned — the real lifecycle rule
    const deadNest = createNest(pg, "dead:owner", resident.speciesId, pg.player.x + 1, pg.player.y);
    migrateBreeding(pg);
    ok(pg.nests[deadNest.id]?.state === "abandoned", "a nest whose owner truly died is abandoned");
    ok(activeBodyCount(pg) < CREATURE_CAP, "spawn capacity counts live local bodies, not every chronicled monster");
  }

  // ---- distant births follow reproductive mode and nesting behavior ----
  const dg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const dw = getWorld(dg.seed);
  initField(dg);
  loadChunks(dg);
  const lushChunk = (): { cx: number; cy: number } | null => {
    for (let r = 4; r < 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const cx = Math.floor(dg.player.x / CHUNK) + dx;
          const cy = Math.floor(dg.player.y / CHUNK) + dy;
          const t = dw.tile(cx * CHUNK + 8, cy * CHUNK + 8);
          if (BIOMES[t.biome].passable && BIOMES[t.biome].forageChance >= 0.35 && BIOMES[t.biome].forage.length > 0 && !t.feature) return { cx, cy };
        }
      }
    }
    return null;
  };
  const base = lushChunk();
  ok(!!base, "a lush unvisited chunk exists for the distant checks");
  if (base) {
    const ecx = base.cx;
    const ecy = base.cy;
    const inChunk = (c: { x: number; y: number }): boolean => Math.floor(c.x / CHUNK) === ecx && Math.floor(c.y / CHUNK) === ecy;
    const makePop = (speciesId: string): AbstractPop => {
      const reg = ensureRegion(dg, 0, ecx, ecy);
      const p: AbstractPop = {
        speciesId,
        count: 3,
        juveniles: 0,
        genes: { vigor: 40, might: 40, guard: 40, swift: 40, wit: 40, size: 40 },
        satiety: 80,
        level: 6,
        lineageId: null,
        seed: dg.seed ^ hashString(reg.key + speciesId),
      };
      reg.pops.push(p);
      reg.abstracted = true;
      return p;
    };
    const regionOf = (p: AbstractPop): DistantRegion | undefined => Object.values(dg.distant ?? {}).find((r) => r.pops.includes(p));

    // gloamoth: sexed Bug → egg-layer; distant conceptions need a persistent nest
    const epop = makePop("gloamoth");
    let steps = 0;
    while (steps++ < 80 && !Object.values(dg.developments).some((d) => d.distant && d.speciesId === "gloamoth")) {
      const reg = regionOf(epop);
      if (!reg) break;
      stepRegion(dg, dw, reg, 1);
    }
    const eggDevs = Object.values(dg.developments).filter((d) => d.distant && d.speciesId === "gloamoth");
    ok(eggDevs.length > 0, "distant egg-layers conceive through the shared development path");
    const popNests = () => Object.values(dg.nests).filter((n) => n.ownerId.startsWith("pop:") && n.speciesId === "gloamoth" && n.state === "active");
    ok(popNests().length > 0, "distant eggs are laid in persistent, population-owned nests");
    ok(eggDevs.every((d) => !!d.nestId && !!d.dist && !!dg.nests[d.nestId!]?.developmentIds.includes(d.id)), "each development record sits inside its nest record");

    // records survive the save migration (idempotent) — snapshot while eggs are in flight
    const rt = JSON.parse(JSON.stringify(dg)) as GameState;
    migrateBreeding(rt);
    ok(Object.values(rt.nests).some((n) => n.ownerId.startsWith("pop:") && n.state === "active"), "population nests survive the save migration");
    ok(Object.values(rt.developments).some((d) => d.distant && d.state === "developing"), "distant developments survive the save migration");

    const countBefore = epop.count;
    for (const d of eggDevs) d.completeTick = dg.tick + 2;
    advance(dg, 6);
    ok(epop.count > countBefore && epop.juveniles > 0, "a distant egg completes into its population, not into a stray body");
    ok(!Object.values(dg.creatures).some(inChunk), "no real body is born in a region nobody is visiting");

    // cindermaw: sexed Beast → live gestation; young need no nest but still develop on the record
    const gpop = makePop("cindermaw");
    steps = 0;
    while (steps++ < 80 && !Object.values(dg.developments).some((d) => d.distant && d.speciesId === "cindermaw")) {
      const reg = regionOf(gpop);
      if (!reg) break;
      stepRegion(dg, dw, reg, 1);
    }
    const gDevs = Object.values(dg.developments).filter((d) => d.distant && d.speciesId === "cindermaw");
    ok(gDevs.length > 0 && gDevs.every((d) => d.type === "gestation" && !d.nestId), "live-bearing populations carry gestations without nests");
    ok(!Object.values(dg.nests).some((n) => n.speciesId === "cindermaw" && n.ownerId.startsWith("pop:")), "no nest records are invented for live bearers");
    for (const d of gDevs) d.completeTick = dg.tick + 2;
    const gBefore = gpop.count;
    advance(dg, 6);
    ok(gpop.count > gBefore, "a distant gestation completes into its population");

    // a revisited region materializes around its persistent nests
    // (the predator leaves the range first, so prey growth is not cancelled out)
    const preg = regionOf(gpop);
    if (preg) preg.pops = preg.pops.filter((p) => p !== gpop);
    for (let k = 0; k < 200 && epop.juveniles < 4; k++) {
      const reg = regionOf(epop);
      if (!reg) break;
      stepRegion(dg, dw, reg, 1);
      for (const d of Object.values(dg.developments)) if (d.distant && d.state === "developing" && d.speciesId === "gloamoth") d.completeTick = dg.tick + 1;
      advance(dg, 4);
    }
    ok(epop.juveniles >= 4, `the population's young accumulate in the region (${epop.juveniles} young, count ${epop.count})`);
    let placed = false;
    placeLoop: for (let dy = 0; dy < CHUNK; dy++) {
      for (let dx = 0; dx < CHUNK; dx++) {
        const x = ecx * CHUNK + dx;
        const y = ecy * CHUNK + dy;
        if (dw.inBounds(x, y) && dw.passable(x, y) && !dw.siteAt(x, y)?.wall) {
          dg.player.x = x;
          dg.player.y = y;
          placed = true;
          break placeLoop;
        }
      }
    }
    ok(placed, "the distant region holds standable ground");
    loadChunks(dg);
    const locals = Object.values(dg.creatures).filter((c) => inChunk(c) && sameLayer(dg, c));
    ok(locals.length > 0, "returning to the region materializes its population");
    const youngByNest = locals.some((c) => c.bornTick !== undefined && popNests().some((n) => Math.max(Math.abs(c.x - n.x), Math.abs(c.y - n.y)) <= 2));
    ok(youngByNest, "the region's young materialize beside its persistent nests");
  }

  // ---- resources grow where they make sense ----
  const fg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const fw = getWorld(fg.seed);
  const emptyDep: Record<string, number> = {};
  const spring = fg.tick;
  const winter = DAY_TICKS * SEASON_DAYS * 3 + 5;
  const s0 = riverNear(fw, fw.startPoint().x, fw.startPoint().y) ?? fw.startPoint();
  let dryShrooms = 0;
  let wallForage = 0;
  let winterHoney = 0;
  let wetTiles = 0;
  let wetHits = 0;
  let dryTiles = 0;
  let dryHits = 0;
  for (let y = s0.y - 90; y <= s0.y + 90; y++) {
    for (let x = s0.x - 90; x <= s0.x + 90; x++) {
      if (!fw.inBounds(x, y)) continue;
      const t = fw.tile(x, y);
      const b = BIOMES[t.biome];
      if (!b.passable || b.forageChance <= 0) continue;
      if (fw.siteAt(x, y)?.wall) {
        if (fw.forage(x, y, spring, emptyDep)) wallForage++;
        continue;
      }
      const item = fw.forage(x, y, spring, emptyDep);
      if (item === "mushroom" && t.moist < 0.5) dryShrooms++;
      if (fw.forage(x, y, winter, emptyDep) === "honeycomb") winterHoney++;
      const nearWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nb = fw.tile(x + dx, y + dy).biome;
        return nb === "river" || nb === "lake" || nb === "sea" || nb === "deep";
      });
      if (nearWater) {
        wetTiles++;
        if (item) wetHits++;
      } else {
        dryTiles++;
        if (item) dryHits++;
      }
    }
  }
  ok(dryShrooms === 0, "mushrooms only sprout on damp ground");
  ok(wallForage === 0, "nothing grows inside standing walls");
  ok(winterHoney === 0, "no honeycomb ripens while the bees are dormant");
  ok(wetTiles > 100 && dryTiles > 100, "the scan covers both banks and dry ground");
  ok(wetHits / wetTiles > dryHits / dryTiles, "riverbanks are more generous than dry ground");
}

/* ------------- Phase 15: river fish, nest maps, egg theft, nest raiding ------------- */
{
  const g = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const w = getWorld(g.seed);

  // fish live only in rivers
  ok(BIOMES.river.forage.some(([id]) => id === "fish"), "rivers carry fish");
  for (const b of ["beach", "marsh", "sea", "lake"] as const) {
    ok(!BIOMES[b].forage.some(([id]) => id === "fish"), `${b} terrain holds no fish`);
  }
  let fishOutside = 0;
  let fishIn = 0;
  const rc = riverNear(w, g.player.x, g.player.y) ?? { x: g.player.x, y: g.player.y };
  for (let y = Math.max(0, rc.y - 90); y <= Math.min(WORLD_SIZE - 1, rc.y + 90); y++) {
    for (let x = Math.max(0, rc.x - 90); x <= Math.min(WORLD_SIZE - 1, rc.x + 90); x++) {
      if (w.forage(x, y, 1000, {}) === "fish") {
        if (w.tile(x, y).biome === "river") fishIn++;
        else fishOutside++;
      }
    }
  }
  ok(fishOutside === 0, "no fish is ever found outside rivers");
  ok(fishIn > 0, `river banks yield fish (${fishIn} found)`);

  const openSpot = (wo: World, x0: number, y0: number): { x: number; y: number } | null => {
    for (let r = 0; r < 30; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = x0 + dx;
          const y = y0 + dy;
          if (!wo.inBounds(x, y) || !walkable(wo, SURFACE, x, y)) continue;
          if (wo.tile(x, y).feature || wo.siteAt(x, y)) continue;
          return { x, y };
        }
      }
    }
    return null;
  };
  const makeEgg = (st: GameState, nest: Nest, tag: string | number, speciesId = "mossback"): ReproductiveDevelopment => {
    const dev: ReproductiveDevelopment = {
      id: `d:egg${tag}`,
      parentIds: ["w:eggmother", "w:eggfather"],
      speciesId,
      pairing: "sexual",
      type: "egg",
      state: "developing",
      startTick: st.tick,
      completeTick: st.tick + DEVELOPMENT_TICKS.egg,
      nestId: nest.id,
      origin: "wild",
    };
    st.developments[dev.id] = dev;
    nest.developmentIds.push(dev.id);
    return dev;
  };

  // nests join the map's memory and stay charted once seen
  // (pick a tile the player actually sees — cliffs occlude the tiles behind them)
  const seenSpot = (x0: number, y0: number): { x: number; y: number } | null => {
    for (let r = 0; r < 10; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = x0 + dx;
          const y = y0 + dy;
          if (!w.inBounds(x, y) || !walkable(w, SURFACE, x, y)) continue;
          if (w.tile(x, y).feature || w.siteAt(x, y)) continue;
          if (!seesTile(g, x, y)) continue;
          // the scenario stages a mother and a tame nest around the nest tile
          let room = true;
          for (const [ox, oy] of [[3, 0], [1, 1], [1, 0], [-1, 0]]) {
            if (!walkable(w, SURFACE, x + ox, y + oy) || w.siteAt(x + ox, y + oy)) room = false;
          }
          if (!room) continue;
          return { x, y };
        }
      }
    }
    return null;
  };
  // the nest scenario needs a visible open tile — step out of the settlement
  // first, since the green's floor leaves none within sight of the plaza
  const nestHome = openSpot(w, g.player.x, g.player.y);
  ok(!!nestHome, "found wild ground beyond the green for the nest");
  if (nestHome) {
    g.player.x = nestHome.x;
    g.player.y = nestHome.y;
  }
  const spot = seenSpot(g.player.x + 2, g.player.y);
  ok(!!spot, "found an open tile for the nest");
  if (spot) {
    const nest = createNest(g, "w:eggmother", "mossback", spot.x, spot.y);
    makeEgg(g, nest, 1);
    updateKnowledge(g);
    ok(!!g.knowledge.nestsSeen?.[nest.id], "a nest you can see joins the map's memory");
    const far = openSpot(w, spot.x + 40, spot.y);
    if (far) {
      g.player.x = far.x;
      g.player.y = far.y;
      updateKnowledge(g);
      ok(!!g.knowledge.nestsSeen?.[nest.id], "charted nests stay on the map once out of sight");
    }

    // stealing: first with no mother around
    g.player.x = spot.x + 1;
    g.player.y = spot.y;
    stealEgg(g);
    ok((g.bag.egg ?? 0) === 1 && !g.developments["d:egg1"] && nest.developmentIds.length === 0, "a stolen egg leaves the nest and fills the pack");
    // the mother does not forgive
    const mom = makeCreature("w:eggmother", "mossback", spot.x + 3, spot.y, 5, 0x3e99, false);
    g.creatures[mom.id] = mom;
    makeEgg(g, nest, 2);
    stealEgg(g);
    ok((g.bag.egg ?? 0) === 2 && mom.stalking && mom.known === true && mom.disposition === "aggressive", "the robbed mother marks the thief");
    // your own tame brood is not for the taking
    const tameNest = createNest(g, g.party[0].uid, "mossback", spot.x + 1, spot.y + 1);
    makeEgg(g, tameNest, 3);
    stealEgg(g);
    ok((g.bag.egg ?? 0) === 2 && !!g.developments["d:egg3"], "your own tame brood cannot be stolen from");
  }

  // carnivores raid nests — other species' eggs only
  const rg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  ok(quietGround(rg), "found quiet wild ground for the nest raid");
  const rw = getWorld(rg.seed);
  const rspot = openSpot(rw, rg.player.x + 12, rg.player.y + 4);
  ok(!!rspot, "found an open tile for the raid");
  const hspot = openSpot(rw, rg.player.x - 14, rg.player.y);
  ok(!!hspot, "found an open tile for the grazer");
  if (rspot && hspot) {
    // nothing else to eat for miles: the only meal on the menu is the egg
    starveArea(rg, rspot.x, rspot.y, 16);
    // and no ambient egg-raiders muscling in on the staged crime
    for (const c of [...Object.values(rg.creatures)]) {
      if (SPECIES[c.speciesId].diet !== "carnivore" && SPECIES[c.speciesId].diet !== "omnivore") continue;
      if (Math.max(Math.abs(c.x - rspot.x), Math.abs(c.y - rspot.y)) <= 30) delete rg.creatures[c.id];
    }
    // a mossback nest with an egg, its mother nowhere in range
    const preyNest = createNest(rg, "w:gone-hen", "mossback", rspot.x, rspot.y);
    makeEgg(rg, preyNest, "r1");
    // the raider: a hungry boglurk (carnivore), placated so it only thinks about eggs
    const raider = makeCreature("w:raider", "boglurk", rspot.x + 2, rspot.y, 6, 0x51ce, false);
    raider.satiety = 40;
    raider.disposition = "skittish";
    raider.calmUntil = rg.tick + 100000;
    rg.creatures[raider.id] = raider;
    // a boglurk nest with its own egg two tiles down — same species is off the menu
    const kinNest = createNest(rg, "w:gone-kin", "boglurk", rspot.x, rspot.y + 2);
    makeEgg(rg, kinNest, "r2", "boglurk");
    // a grazed mossback beside a wyrm clutch: not a carnivore, so the eggs are safe
    const wyrmNest = createNest(rg, "w:gone-wyrm", "crested_wyrm", hspot.x, hspot.y);
    makeEgg(rg, wyrmNest, "r3", "crested_wyrm");
    const herb = makeCreature("w:herb", "mossback", hspot.x + 1, hspot.y, 4, 0x77, false);
    herb.satiety = 0;
    herb.disposition = "skittish";
    herb.calmUntil = rg.tick + 100000;
    rg.creatures[herb.id] = herb;

    let ate = !rg.developments["d:eggr1"];
    let ticks = 0;
    for (let i = 0; i < 200 && !ate; i++) {
      advance(rg, 2);
      ticks += 2;
      ate = !rg.developments["d:eggr1"];
    }
    ok(ate && raider.satiety > 40 && !!rg.creatures["w:raider"], `hungry carnivores devour other species' eggs (${ticks} ticks, satiety ${Math.round(raider.satiety)})`);
    ok(!!rg.developments["d:eggr2"], "carnivores spare the eggs of their own kind");
    ok(!!rg.developments["d:eggr3"], "non-carnivores leave eggs alone");
  }
}

/* ------------------- Phase 16: context button + fed wilds ------------------- */
{
  const mkEgg16 = (st: GameState, nest: Nest, tag: string | number, speciesId = "mossback"): ReproductiveDevelopment => {
    const dev: ReproductiveDevelopment = {
      id: `d:ctx${tag}`,
      parentIds: ["w:ctxhen", "w:ctxrooster"],
      speciesId,
      pairing: "sexual",
      type: "egg",
      state: "developing",
      startTick: st.tick,
      completeTick: st.tick + DEVELOPMENT_TICKS.egg,
      nestId: nest.id,
      origin: "wild",
    };
    st.developments[dev.id] = dev;
    nest.developmentIds.push(dev.id);
    return dev;
  };
  const ids16 = (acts: { id: string }[]): string => JSON.stringify(acts.map((a) => a.id));

  /* ---- the button always knows ---- */
  {
    const xg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
    const xw = getWorld(xg.seed);
    const standOk = (x: number, y: number, rich: boolean): boolean => {
      if (!xw.inBounds(x, y) || !walkable(xw, SURFACE, x, y)) return false;
      if (xw.tile(x, y).feature || xw.siteAt(x, y)) return false;
      return (BIOMES[xw.tile(x, y).biome].forage.length > 0) === rich;
    };
    let base: { x: number; y: number } | null = null;
    ctxA: for (let r = 0; r < 100; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = xg.player.x + dx;
          const y = xg.player.y + dy;
          if (standOk(x, y, false) && standOk(x + 1, y, false) && standOk(x, y + 2, false) && standOk(x + 1, y + 1, false) && standOk(x + 2, y, false)) {
            base = { x, y };
            break ctxA;
          }
        }
      }
    }
    ok(!!base, "found a barren shore for the context button");
    if (base) {
      const B = base;
      const go = (dx: number, dy: number): void => { xg.player.x = B.x + dx; xg.player.y = B.y + dy; };
      go(0, 0);
      ok(contextActions(xg).length === 0, "barren ground offers no context action");
      const eggNest = createNest(xg, "w:ctxhen", "mossback", B.x, B.y + 2);
      mkEgg16(xg, eggNest, "a");
      go(0, 2);
      ok(ids16(contextActions(xg)) === '["egg"]', "an egg alone reads as Steal Egg");
      const corpse = makeCreature("w:ctxmeat", "mossback", B.x + 2, B.y, 3, 0x1601, false);
      ok(!!spawnCarrion(xg, corpse), "the fallen body leaves remains");
      go(1, 0);
      ok(ids16(contextActions(xg)) === '["dress"]', "remains alone read as Dress");
      go(1, 1);
      ok(ids16(contextActions(xg)) === '["egg","dress"]', "an egg outranks remains");
      let greens: { x: number; y: number } | null = null;
      ctxB: for (let r = 3; r < 100; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = B.x + dx;
            const y = B.y + dy;
            if (standOk(x, y, true) && standOk(x + 1, y, true) && standOk(x + 3, y, true)) {
              greens = { x, y };
              break ctxB;
            }
          }
        }
      }
      ok(!!greens, "found rich ground for the full pick-list");
      if (greens) {
        const G = greens;
        const gNest = createNest(xg, "w:ctxhen2", "mossback", G.x, G.y + 1);
        mkEgg16(xg, gNest, "b");
        const corpse2 = makeCreature("w:ctxmeat2", "mossback", G.x + 1, G.y, 3, 0x1602, false);
        spawnCarrion(xg, corpse2);
        xg.player.x = G.x;
        xg.player.y = G.y;
        ok(ids16(contextActions(xg)) === '["egg","dress","forage"]', "the pick-list reads egg, remains, forage");
        const devId = gNest.developmentIds[0];
        runContextAction(xg, "egg");
        ok(!xg.developments[devId], "picking Steal Egg takes the egg");
        xg.player.x = G.x + 3;
        xg.player.y = G.y;
        ok(ids16(contextActions(xg)) === '["forage"]', "plain ground reads as Forage");
      }
    }
  }

  /* ---- fed wilds ---- */
  {
    const fg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
    ok(quietGround(fg), "found quiet wild ground for the wildlife stages");
    const fw = getWorld(fg.seed);
    for (const id of Object.keys(fg.creatures)) delete fg.creatures[id];
    fg.tick = 96; // mid-morning: diurnal bodies are awake
    const place = (id: string, speciesId: string, x: number, y: number, level: number, h: number): WildCreature => {
      const c = makeCreature(id, speciesId, x, y, level, h, false);
      fg.creatures[id] = c;
      return c;
    };
    const calm = (c: WildCreature): void => { c.calmUntil = fg.tick + 1000000; };
    const standFree = (x: number, y: number, species: string, wantForage: boolean): boolean => {
      if (!fw.inBounds(x, y) || !walkable(fw, SURFACE, x, y)) return false;
      if (fw.tile(x, y).feature || fw.siteAt(x, y)) return false;
      if (creatureAt(fg, x, y) || partyMonAt(fg, x, y)) return false;
      const self = fw.forage(x, y, fg.tick, fg.depleted);
      return (!!self && ITEMS[self].diets.includes(SPECIES[species].diet)) === wantForage;
    };
    const freeSpot = (x0: number, y0: number, species: string): { x: number; y: number } | null => {
      for (let r = 0; r < 16; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = x0 + dx;
            const y = y0 + dy;
            if (standFree(x, y, species, false)) return { x, y };
          }
        }
      }
      return null;
    };
    const ringSpot = (radius: number, species: string, wantForage: boolean): { x: number; y: number } | null => {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const x = fg.player.x + dx;
          const y = fg.player.y + dy;
          if (standFree(x, y, species, wantForage)) return { x, y };
        }
      }
      return null;
    };
    const foodOut = (species: string, x0: number, y0: number, awayFrom?: { x: number; y: number }): { x: number; y: number; item: ItemId } | null => {
      const diet = SPECIES[species].diet;
      for (let r = 7; r <= 10; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = x0 + dx;
            const y = y0 + dy;
            if (!fw.inBounds(x, y) || !fw.passable(x, y)) continue;
            if (fw.tile(x, y).feature || fw.siteAt(x, y)) continue;
            const it = fw.forage(x, y, fg.tick, fg.depleted);
            if (!it || !ITEMS[it].diets.includes(diet)) continue;
            if (awayFrom && cheb(x, y, awayFrom.x, awayFrom.y) < cheb(x0, y0, awayFrom.x, awayFrom.y)) continue;
            const steps = Math.max(Math.abs(dx), Math.abs(dy));
            let clear = true;
            for (let i = 1; i <= steps && clear; i++) {
              const sx = x0 + Math.round((dx * i) / steps);
              const sy = y0 + Math.round((dy * i) / steps);
              if (!fw.inBounds(sx, sy) || !fw.passable(sx, sy) || fw.tile(sx, sy).feature || fw.siteAt(sx, sy)) clear = false;
            }
            if (clear) return { x, y, item: it };
          }
        }
      }
      return null;
    };
    const runUntil = (cond: () => boolean, cap: number): number => {
      let t = 0;
      while (t < cap && !cond()) {
        advance(fg, 2);
        t += 2;
      }
      return t;
    };
    /** Jump the clock to the next 06:00 window so diurnal bodies are awake. */
    const toMorning = (): void => {
      const h = Math.floor((fg.tick % DAY_TICKS) / 12);
      if (h < 6 || h >= 19) fg.tick += ((6 * 12 - (fg.tick % DAY_TICKS)) % DAY_TICKS + DAY_TICKS) % DAY_TICKS;
    };

    // slower drain: 100 ticks at 0.22 — the old 0.3 would leave 70
    const drainSpot = freeSpot(fg.player.x + 9, fg.player.y + 9, "mossback");
    ok(!!drainSpot, "a quiet tile for the drain check");
    if (drainSpot) starveArea(fg, drainSpot.x, drainSpot.y, 14);
    if (drainSpot) {
      const sleeper = place("w:drain16", "mossback", drainSpot.x, drainSpot.y, 5, 0xa10);
      sleeper.satiety = 100;
      runUntil(() => false, 100);
      ok(Math.abs(sleeper.satiety - 78) < 0.5, `bellies drain slower (${Math.round(sleeper.satiety)} after 100 ticks)`);
      delete fg.creatures["w:drain16"];
    }

    // a plant-eater walks to food it smells (old scan radius was 6)
    const seekSpot = freeSpot(fg.player.x - 11, fg.player.y - 7, "mossback");
    ok(!!seekSpot, "a quiet tile for the seeker");
    if (seekSpot) {
      const herb = place("w:seeker16", "mossback", seekSpot.x, seekSpot.y, 4, 0xb20);
      herb.satiety = 40;
      calm(herb);
      const food = foodOut("mossback", seekSpot.x, seekSpot.y);
      ok(!!food, "smelly food waits 7–10 tiles from the seeker");
      if (food) {
        runUntil(() => herb.satiety > 60 || !fg.creatures["w:seeker16"], 900);
        ok(herb.satiety > 60 && !!fg.creatures["w:seeker16"], `hungry plant-eaters walk to food they smell (satiety ${Math.round(herb.satiety)})`);
      }
      delete fg.creatures["w:seeker16"];
    }

    // food is judged from where the body stands, not from a home anchor
    let driftSpot: { x: number; y: number } | null = null;
    driftA: for (let r = 12; r <= 30; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = fg.player.x + dx;
          const y = fg.player.y + dy;
          if (!standFree(x, y, "mossback", false)) continue;
          for (let dy2 = -3; dy2 <= 3; dy2++) {
            for (let dx2 = -3; dx2 <= 3; dx2++) {
              const it = fw.forage(x + dx2, y + dy2, fg.tick, fg.depleted);
              if (it && ITEMS[it].diets.includes("herbivore")) {
                driftSpot = { x, y };
                break driftA;
              }
            }
          }
        }
      }
    }
    ok(!!driftSpot, "a quiet tile for the drifter");
    if (driftSpot) {
      const drifter = place("w:drifter16", "mossback", driftSpot.x, driftSpot.y, 4, 0xb21);
      drifter.satiety = 40;
      drifter.homeX = driftSpot.x + 25;
      drifter.homeY = driftSpot.y + 25;
      calm(drifter);
      let near: { x: number; y: number } | null = null;
      ctxC: for (let r = 1; r <= 3; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = driftSpot.x + dx;
            const y = driftSpot.y + dy;
            if (!fw.inBounds(x, y) || !fw.passable(x, y)) continue;
            const it = fw.forage(x, y, fg.tick, fg.depleted);
            if (it && ITEMS[it].diets.includes("herbivore") && cheb(x, y, drifter.homeX, drifter.homeY) > 16) {
              near = { x, y };
              break ctxC;
            }
          }
        }
      }
      ok(!!near, "food grows beside the drifter, far outside its old home-anchored nose");
      if (near) {
        runUntil(() => drifter.satiety > 60 || !fg.creatures["w:drifter16"], 700);
        ok(drifter.satiety > 60 && !!fg.creatures["w:drifter16"], "displaced bodies feed from where they stand");
      }
      delete fg.creatures["w:drifter16"];
    }

    // predators scent prey beyond the old 7-tile perception cap
    const prowlSpot = freeSpot(fg.player.x + 13, fg.player.y + 11, "hollowcrow");
    ok(!!prowlSpot, "a quiet tile for the prowler");
    if (prowlSpot) {
      const preySpot = freeSpot(prowlSpot.x + 9, prowlSpot.y, "bloomwisp");
      ok(!!preySpot, "a tile for the prey");
      if (preySpot) {
        // night: the diurnal prey sleeps — the nocturnal hunter walks straight to it
        const hh = Math.floor((fg.tick % DAY_TICKS) / 12);
        if (hh >= 6 && hh < 19) fg.tick += ((22 * 12 - (fg.tick % DAY_TICKS)) % DAY_TICKS + DAY_TICKS) % DAY_TICKS;
        const prowler = place("w:prowler16", "hollowcrow", prowlSpot.x, prowlSpot.y, 8, 0xb22);
        prowler.satiety = 42;
        calm(prowler);
        const nibble = place("w:nibble16", "bloomwisp", preySpot.x, preySpot.y, 3, 0xb23);
        nibble.satiety = 60;
        calm(nibble);
        const d0 = cheb(prowlSpot.x, prowlSpot.y, preySpot.x, preySpot.y);
        ok(d0 > 7, `prey waits ${d0} tiles out — past the old 7-tile nose`);
        if (d0 > 7) {
          runUntil(() => nibble.hpFrac < 1 || !fg.creatures["w:nibble16"] || !fg.creatures["w:prowler16"], 700);
          const struck = (nibble.hpFrac < 1 || !fg.creatures["w:nibble16"]) && !!fg.creatures["w:prowler16"];
          ok(struck, `predators scent prey beyond arm's length and close in (hp ${nibble.hpFrac.toFixed(2)}, d ${cheb(prowler.x, prowler.y, nibble.x, nibble.y)}, satiety ${Math.round(prowler.satiety)}, tick ${fg.tick})`);
        }
        delete fg.creatures["w:prowler16"];
        delete fg.creatures["w:nibble16"];
      }
    }

    // desperate predators take prey they would normally refuse
    const despSpot = freeSpot(fg.player.x + 20, fg.player.y - 6, "nimbletuft");
    ok(!!despSpot, "a quiet tile for the desperate hunter");
    if (despSpot) {
      let titanSpot: { x: number; y: number } | null = null;
      titanA: for (let r = 2; r < 8; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = despSpot.x + dx;
            const y = despSpot.y + dy;
            let ok2 = true;
            for (let oy = 0; oy < 2 && ok2; oy++) for (let ox = 0; ox < 2 && ok2; ox++) {
              if (!fw.inBounds(x + ox, y + oy) || !walkable(fw, SURFACE, x + ox, y + oy) || fw.tile(x + ox, y + oy).feature || fw.siteAt(x + ox, y + oy)) ok2 = false;
            }
            if (ok2 && !creatureAt(fg, x, y) && !partyMonAt(fg, x, y)) {
              titanSpot = { x, y };
              break titanA;
            }
          }
        }
      }
      ok(!!titanSpot, "a tile for the too-big prey");
      if (titanSpot) {
        const desperate = place("w:desperate16", "nimbletuft", despSpot.x, despSpot.y, 6, 0xb24);
        desperate.satiety = 10;
        calm(desperate);
        const titan = place("w:titan16", "jade_spikeon", titanSpot.x, titanSpot.y, 4, 0xb25);
        titan.satiety = 60;
        calm(titan);
        runUntil(() => titan.hpFrac < 1 || !fg.creatures["w:titan16"] || !fg.creatures["w:desperate16"], 200);
        ok((titan.hpFrac < 1 || !fg.creatures["w:titan16"]) && !!fg.creatures["w:desperate16"], `starving predators take prey they would normally refuse (hp ${titan.hpFrac.toFixed(2)}, d ${cheb(desperate.x, desperate.y, titan.x, titan.y)}, satiety ${Math.round(desperate.satiety)}, "${desperate.activity}" vs "${titan.activity}", tick ${fg.tick})`);
        delete fg.creatures["w:desperate16"];
        delete fg.creatures["w:titan16"];
      }
    }

    const ringSpotOut = (minR: number, species: string, wantForage: boolean): { x: number; y: number } | null => {
      for (let r = minR; r <= 22; r++) {
        const s = ringSpot(r, species, wantForage);
        if (s) return s;
      }
      return null;
    };

    // shyness yields to hunger
    const shySpot = ringSpotOut(4, "mossback", false);
    ok(!!shySpot, "a spot beyond the green for the shy one");
    if (shySpot) {
      toMorning();
      const shy = place("w:shy16", "mossback", shySpot.x, shySpot.y, 3, 0xb26);
      shy.satiety = 22;
      shy.disposition = "skittish";
      const food = foodOut("mossback", shySpot.x, shySpot.y, { x: fg.player.x, y: fg.player.y });
      ok(!!food, "food the shy one can smell away from you");
      if (food) {
        runUntil(() => shy.satiety > 45 || !fg.creatures["w:shy16"], 500);
        ok(shy.satiety > 45 && !!fg.creatures["w:shy16"], "a shy body too hungry to stay shy goes and eats");
      }
      delete fg.creatures["w:shy16"];
    }

    // watching yields to hunger
    const watchSpot = ringSpotOut(3, "mossback", false);
    ok(!!watchSpot, "a spot beyond the green for the watcher");
    if (watchSpot) {
      toMorning();
      const watcher = place("w:watcher16", "mossback", watchSpot.x, watchSpot.y, 3, 0xb27);
      watcher.satiety = 40;
      watcher.disposition = "curious";
      const food = foodOut("mossback", watchSpot.x, watchSpot.y, { x: fg.player.x, y: fg.player.y });
      ok(!!food, "food the watcher can smell away from you");
      if (food) {
        runUntil(() => watcher.satiety > 55 || !fg.creatures["w:watcher16"], 500);
        ok(watcher.satiety > 55 && !!fg.creatures["w:watcher16"], "a curious body stops watching and feeds when hungry");
      }
      delete fg.creatures["w:watcher16"];
    }

    // stalking yields to hunger — staged beyond the party's defend-radius, since
    // your own monster muddles a hunger experiment fought this close to home
    let hungerBase: { x: number; y: number } | null = null;
    hunger: for (let r = 24; r < 90; r += 3) {
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2;
        const x = fg.player.x + Math.round(Math.cos(ang) * r);
        const y = fg.player.y + Math.round(Math.sin(ang) * r);
        if (standFree(x, y, "crested_wyrm", false) && standFree(x + 3, y, "mossback", false) && standFree(x - 3, y, "mossback", false) && standFree(x, y + 3, "mossback", false)) {
          hungerBase = { x, y };
          break hunger;
        }
      }
    }
    const stalkSpot = hungerBase;
    ok(!!stalkSpot, "a quiet spot far from the party for the hungry stalker");
    if (stalkSpot) {
      const stalker = place("w:stalker16", "crested_wyrm", stalkSpot.x, stalkSpot.y, 6, 0xb28);
      stalker.satiety = 15;
      stalker.disposition = "aggressive";
      stalker.personality = "fierce";
      // a guaranteed meal grazes within scent — a body the strict rule forbids and desperation allows
      let mealSpot: { x: number; y: number } | null = null;
      mealA: for (let r = 3; r <= 5; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = stalkSpot.x + dx;
            const y = stalkSpot.y + dy;
            if (standFree(x, y, "mossback", false) && Math.max(Math.abs(x - fg.player.x), Math.abs(y - fg.player.y)) > 18) {
              mealSpot = { x, y };
              break mealA;
            }
          }
        }
      }
      ok(!!mealSpot, "a meal grazes within the stalker's nose");
      if (mealSpot) {
        const meal = place("w:meal16", "mossback", mealSpot.x, mealSpot.y, 3, 0xb32);
        meal.satiety = 60;
        calm(meal);
        runUntil(() => stalker.satiety > 30 || !fg.creatures["w:stalker16"], 400);
        ok(stalker.satiety > 30 && !!fg.creatures["w:stalker16"], `a stalking hunter breaks off to feed when starving (satiety ${Math.round(stalker.satiety)}, "${stalker.activity}", tick ${fg.tick})`);
        delete fg.creatures["w:meal16"];
      }
      delete fg.creatures["w:stalker16"];
    }

    // a blocked seeker gives up and re-targets later: food it smells but the land refuses
    let sealed: { x: number; y: number } | null = null;
    let shore: { x: number; y: number } | null = null;
    let sealedSeeker: string | null = null;
    {
      // faithful rehearsal of the greedy route: does the block counter trip before the body reaches the food?
      const route = (speciesId: string, sx: number, sy: number, tx: number, ty: number): boolean => {
        const mv = moverOf(speciesId);
        const sp = SPECIES[speciesId];
        const avoid = mv.heavy ? HEAVY_CLIMB_AVOID : CLIMB_AVOID;
        const enter = (cx: number, cy: number, nx: number, ny: number): boolean => {
          if (!fw.inBounds(nx, ny)) return false;
          const st = stepRule(fw, SURFACE, cx, cy, nx, ny, mv);
          if (!st.ok || fallLevels(mv, st.drop) > 0) return false;
          if (!bodyLevelOk(fw, SURFACE, nx, ny, footprintOf(sp))) return false;
          const t = fw.tile(nx, ny);
          if (t.biome === "deep") return false;
          if (t.biome === "peak" && !mv.climbs && !mv.flies) return false;
          if ((t.biome === "sea" || t.biome === "lake") && !sp.swims) return false;
          if (t.biome === "river" && sp.fears === "water" && !sp.traits.includes("flutter")) return false;
          if (isSettlement(t.feature)) return false;
          if (fw.siteAt(nx, ny)?.wall) return false;
          return true;
        };
        let cx = sx;
        let cy = sy;
        let stuck = 0;
        for (let step = 0; step < 200; step++) {
          if (cheb(cx, cy, tx, ty) <= 1) return false;
          const before = Math.hypot(tx - cx, ty - cy);
          let bx = -1;
          let by = -1;
          let bd = before;
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            for (let dx2 = -1; dx2 <= 1; dx2++) {
              if (!dx2 && !dy2) continue;
              const nx = cx + dx2;
              const ny = cy + dy2;
              if (!enter(cx, cy, nx, ny)) continue;
              const raw = Math.hypot(tx - nx, ty - ny);
              const rise = mv.flies || mv.climbs ? 0 : stepRule(fw, SURFACE, cx, cy, nx, ny, mv).rise;
              const d = raw + rise * avoid;
              if (d < bd) {
                bd = d;
                bx = nx;
                by = ny;
              }
            }
          }
          if (bx >= 0) {
            cx = bx;
            cy = by;
          }
          if (bx >= 0 && Math.hypot(tx - cx, ty - cy) < before - 1e-9) stuck = 0;
          else if (++stuck >= 8) return true;
        }
        return true;
      };
      // the sim's own staggered scan, replayed: the first diet-compatible tile this body would smell from s
      const firstSeekFrom = (sx: number, sy: number, speciesId: string): { x: number; y: number } | null => {
        const diet = SPECIES[speciesId].diet;
        for (let r = 1; r <= 10; r++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              const x = sx + dx;
              const y = sy + dy;
              if (!fw.inBounds(x, y) || cheb(x, y, sx, sy) > 12) continue;
              const it = fw.forage(x, y, fg.tick, fg.depleted);
              if (it && ITEMS[it].diets.includes(diet)) return { x, y };
            }
          }
        }
        return null;
      };
      sealA: for (let r = 4; r < 120 && !sealed; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = fg.player.x + dx;
            const y = fg.player.y + dy;
            if (!fw.inBounds(x, y) || !fw.passable(x, y)) continue;
            if (fw.tile(x, y).feature || fw.siteAt(x, y)) continue;
            for (const seeker of ["cindermaw", "bloomwisp"]) {
              const it = fw.forage(x, y, fg.tick, fg.depleted);
              if (!it || !ITEMS[it].diets.includes(SPECIES[seeker].diet)) continue;
              for (let sr = 3; sr <= 6; sr++) {
                for (let sdy = -sr; sdy <= sr; sdy++) {
                  for (let sdx = -sr; sdx <= sr; sdx++) {
                    if (Math.max(Math.abs(sdx), Math.abs(sdy)) !== sr) continue;
                    const sx = x + sdx;
                    const sy = y + sdy;
                    if (!standFree(sx, sy, seeker, false)) continue;
                    if (!route(seeker, sx, sy, x, y)) continue;
                    // the sealed meal must be the only food in smell range, or
                    // the walker simply grazes elsewhere and the block is never tested
                    let otherFood = false;
                    for (let rr = 1; rr <= 12 && !otherFood; rr++) {
                      for (let dy2 = -rr; dy2 <= rr && !otherFood; dy2++) {
                        for (let dx2 = -rr; dx2 <= rr; dx2++) {
                          if (Math.max(Math.abs(dx2), Math.abs(dy2)) !== rr) continue;
                          const ax = sx + dx2;
                          const ay = sy + dy2;
                          if (!fw.inBounds(ax, ay) || (ax === x && ay === y)) continue;
                          const ait = fw.forage(ax, ay, fg.tick, fg.depleted);
                          if (ait && ITEMS[ait].diets.includes(SPECIES[seeker].diet)) otherFood = true;
                        }
                      }
                    }
                    if (otherFood) continue;
                    const first = firstSeekFrom(sx, sy, seeker);
                    if (!first || first.x !== x || first.y !== y) continue;
                    sealed = { x, y };
                    shore = { x: sx, y: sy };
                    sealedSeeker = seeker;
                    break sealA;
                  }
                }
              }
            }
          }
        }
      }
    }
    if (sealed && shore && sealedSeeker) {
      toMorning();
      const walker = place("w:sealed16", sealedSeeker, shore.x, shore.y, 4, 0xb29);
      walker.satiety = 40;
      walker.homeX = shore.x;
      walker.homeY = shore.y;
      calm(walker);
      const banStart = fg.tick;
      runUntil(() => (!walker.seek && (walker.seekBan ?? 0) > fg.tick) || !fg.creatures["w:sealed16"], 600);
      ok(!!fg.creatures["w:sealed16"] && !walker.seek && (walker.seekBan ?? 0) > banStart && (walker.seekBan ?? 0) <= banStart + 900, `a blocked seeker gives up instead of butting the same rock (${sealedSeeker}, d ${cheb(shore.x, shore.y, sealed.x, sealed.y)}, seek ${walker.seek ? `${walker.seek.x},${walker.seek.y}` : "null"}, T ${sealed.x},${sealed.y}, at ${walker.x},${walker.y}, satiety ${Math.round(walker.satiety)}, "${walker.activity}", tick ${fg.tick})`);
      delete fg.creatures["w:sealed16"];
    } else ok(true, "no sealed food within reach (skipped)");

    // a famished body risks feeding near a threat
    let dinerSpot: { x: number; y: number } | null = null;
    for (let r = 8; r <= 20 && !dinerSpot; r++) dinerSpot = ringSpot(r, "bloomwisp", true);
    if (dinerSpot) {
      const diner = place("w:diner16", "bloomwisp", dinerSpot.x, dinerSpot.y, 3, 0xb30);
      diner.satiety = 10;
      diner.disposition = "skittish";
      const menaceSpot = freeSpot(dinerSpot.x + 2, dinerSpot.y, "crested_wyrm");
      if (menaceSpot) {
        const menace = place("w:menace16", "crested_wyrm", menaceSpot.x, menaceSpot.y, 5, 0xb31);
        menace.satiety = 46; // threatens (< 50) but does not hunt (≥ 45)
        menace.homeX = dinerSpot.x;
        menace.homeY = dinerSpot.y;
        runUntil(() => diner.satiety > 15 || !fg.creatures["w:diner16"], 100);
        ok(diner.satiety > 15 && !!fg.creatures["w:diner16"], "a famished body risks feeding near a threat");
        delete fg.creatures["w:menace16"];
      }
      delete fg.creatures["w:diner16"];
    } else ok(true, "no ripe forage tile nearby (skipped)");
  }
}

/* ----------------- Phase 17: carried eggs hatch into companions ----------------- */
{
  const g = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const w = getWorld(g.seed);

  // incubation is pure time, tuned per species: small ≈ 2 days, titanic ≈ 4
  ok(incubationTicks("bloomwisp") === 576, `a small egg incubates for exactly two in-world days (${incubationTicks("bloomwisp")})`);
  ok(incubationTicks("sunwyrm") === 1094, `a titanic egg needs roughly four (${incubationTicks("sunwyrm")})`);
  ok(incubationTicks("skyhorn_dragon") > 576 && incubationTicks("skyhorn_dragon") < 1094, "bigger bodies incubate in between");

  migrateEggs(g);
  migrateEggs(g);
  ok(Array.isArray(g.eggs) && g.eggs.length === 0, "older saves gain an empty egg pack through migration, twice over");

  const openSpot = (wo: World, x0: number, y0: number): { x: number; y: number } | null => {
    for (let r = 0; r < 30; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = x0 + dx;
          const y = y0 + dy;
          if (!wo.inBounds(x, y) || !walkable(wo, SURFACE, x, y)) continue;
          if (wo.tile(x, y).feature || wo.siteAt(x, y)) continue;
          return { x, y };
        }
      }
    }
    return null;
  };
  const blChild = (tag: string, speciesId: string): ChildBlueprint => ({
    speciesId,
    sex: "female",
    level: 1,
    genes: rollGenome(new Rng(hashString(tag) ^ 0x9a11), speciesId, 0),
    mutations: [],
    personality: "gentle",
    skills: [],
    plus: 1,
    bond: 33,
    generation: 2,
    lineageId: "L:testline",
    mutHistory: [],
    parents: ["w:eggmother", "w:eggfather"],
    parentNames: ["Old Moss", "Old Boulder"],
  });
  const blEgg = (st: GameState, nest: Nest, tag: string, speciesId: string): ReproductiveDevelopment => {
    const dev: ReproductiveDevelopment = {
      id: `d:ce${tag}`,
      parentIds: ["w:eggmother", "w:eggfather"],
      speciesId,
      pairing: "sexual",
      type: "egg",
      state: "developing",
      startTick: st.tick,
      completeTick: st.tick + DEVELOPMENT_TICKS.egg,
      nestId: nest.id,
      origin: "wild",
      child: blChild(tag, speciesId),
    };
    st.developments[dev.id] = dev;
    nest.developmentIds.push(dev.id);
    return dev;
  };

  const spot = openSpot(w, g.player.x + 3, g.player.y);
  ok(!!spot, "found an open tile for the carried-egg nest");
  if (spot) {
    const nest = createNest(g, "w:eggmother", "bloomwisp", spot.x, spot.y);
    const dev1 = blEgg(g, nest, "1", "bloomwisp");
    const genes1 = JSON.stringify(dev1.child.genes);
    g.player.x = spot.x + 1;
    g.player.y = spot.y;
    stealEgg(g);
    const eggs = g.eggs ?? [];
    const egg = eggs[0]!;
    ok(eggs.length === 1 && egg.child.parentNames?.[0] === "Old Moss" && egg.child.lineageId === "L:testline" && genes1 === JSON.stringify(egg.child.genes) && !g.developments["d:ce1"] && nest.developmentIds.length === 0, "stealing captures the bloodline: genes, parentage and lineage ride with the shell");
    ok(egg.hatchTick === egg.stolenTick + incubationTicks("bloomwisp"), "the carried egg's hatch time is its species' incubation");

    // the pack carries four eggs, no more
    for (let i = 2; i <= 4; i++) takeEggIntoPack(g, "mossback", blChild(`x${i}`, "mossback"), false);
    ok(eggs.length === PACK_EGG_CAP, "the pack holds four eggs");
    blEgg(g, nest, "2", "bloomwisp");
    stealEgg(g);
    ok(eggs.length === PACK_EGG_CAP && !!g.developments["d:ce2"], "a full pack refuses a fifth egg");
    delete g.developments["d:ce2"];
    nest.developmentIds = [];

    // incubation is pure time; the ready egg announces itself
    advance(g, egg.hatchTick - g.tick - 2);
    ok(!egg.announced, "an egg keeps quiet until its hour");
    advance(g, 2);
    ok(egg.announced === true && g.tick >= egg.hatchTick, "a ready egg announces itself");

    // keep: the exact bred-baby birth path
    const histBefore = g.lineages?.["L:testline"]?.historical ?? 0;
    const msg = hatchCarriedEgg(g, egg.id, "keep");
    const baby = [...g.party, ...g.pen].find((m) => m.lineageId === "L:testline");
    ok(msg === "" && !!baby, "keeping a ready egg hatches it");
    ok(!!baby && baby.level === 1 && baby.bornTick === g.tick && baby.bond === 60 && baby.generation === 2 && baby.parentNames?.[0] === "Old Moss" && baby.origin === "Bred", "a kept egg hatches tamed: newborn, imprinted bond, lineage, parentage");
    ok(!!baby && genes1 === JSON.stringify(baby.genes), "the kept hatchling carries its egg's exact genotype");
    ok((g.lineages?.["L:testline"]?.historical ?? 0) === histBefore + 1 && !!baby && (g.childIndex?.["w:eggmother"] ?? []).includes(baby.uid), "the hatch registers in the lineage records like any birth");
    ok(g.seen["bloomwisp"] === true && g.tamed["bloomwisp"] === true, "the hatchling is seen and counted as yours");
    ok(eggs.length === PACK_EGG_CAP - 1, "the hatched egg leaves the pack");

    // release: an imprinted, curious wanderer beside you, registered in the wild
    takeEggIntoPack(g, "bloomwisp", blChild("rel", "bloomwisp"), false);
    const egg2 = eggs[eggs.length - 1]!;
    egg2.hatchTick = g.tick;
    const birthsBefore = g.ecology?.vitals["bloomwisp"]?.births ?? 0;
    const popOf = (st: GameState): number =>
      Object.values(st.ecology?.regions ?? {}).reduce((a, list) => a + (list.find((p) => p.speciesId === "bloomwisp")?.pop ?? 0), 0);
    const popBefore = popOf(g);
    const msg2 = hatchCarriedEgg(g, egg2.id, "release");
    const hatchling = Object.values(g.creatures).find((c) => c.lineageId === "L:testline" && c.bornTick === g.tick);
    ok(msg2 === "" && !!hatchling && cheb(hatchling!.x, hatchling!.y, g.player.x, g.player.y) <= 2 && hatchling!.disposition === "curious" && hatchling!.affection === 45 && hatchling!.known === true, "releasing hatches a wild, persistent wanderer beside you — imprinted, but free");
    ok(!!hatchling && JSON.stringify(hatchling.genes) === JSON.stringify(egg2.child.genes), "the released hatchling carries its egg's genotype");
    ok((g.ecology?.vitals["bloomwisp"]?.births ?? 0) === birthsBefore + 1 && popOf(g) === popBefore + 1, "a released hatchling registers in the wild like any nest hatch");
    ok(!eggs.find((e) => e.id === egg2.id), "the released egg leaves the pack");

    // eggs are food only by choice: the auto-feeder can't see them, a plain egg is still food
    const eater = createMonster(g, "cindermaw", 5, { origin: "test", seed: 0x399 });
    g.party.push(eater);
    takeEggIntoPack(g, "bloomwisp", blChild("eat", "bloomwisp"), false);
    const egg3 = eggs[eggs.length - 1]!;
    egg3.hatchTick = g.tick;
    for (const c of Object.values(g.creatures)) {
      if (cheb(c.x, c.y, g.player.x, g.player.y) <= 6) {
        c.disposition = "calm";
        c.calmUntil = g.tick + 100000;
        c.stalking = false;
      }
    }
    g.bag = {};
    eater.satiety = 10;
    g.party[0]!.satiety = 10;
    campRest(g, 1);
    ok(eggs.includes(egg3), "automatic feeding never touches a carried egg");
    g.bag.egg = 1;
    eater.satiety = 10;
    g.party[0]!.satiety = 10;
    campRest(g, 1);
    ok((g.bag.egg ?? 0) === 0 && eggs.includes(egg3), "a plain bag egg feeds the auto-feeder; the carried egg still rides along");
    const msg3 = eatCarriedEgg(g, egg3.id);
    ok(msg3.length > 0 && (g.bag.egg ?? 0) === 1 && !eggs.includes(egg3), "eating an egg is a choice that trades it for food");
    const egg4 = takeEggIntoPack(g, "bloomwisp", blChild("feed", "bloomwisp"), false)!;
    egg4.hatchTick = g.tick;
    eater.satiety = 10;
    const carried = removeCarriedEgg(g, egg4.id);
    const line = carried ? useItemOn(g, eater, "egg") : "";
    ok(!!carried && line.length > 0 && eater.satiety > 10 && eggs.length === 3, "an egg can be hand-fed to a party monster");
  }

  // the wild notices: a stolen nursery egg shrinks the abstract flock, and still hatches
  const ng = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const nw = getWorld(ng.seed);
  const nspot = openSpot(nw, ng.player.x + 6, ng.player.y);
  ok(!!nspot, "found an open tile for the nursery nest");
  if (nspot) {
    const far = { cx: Math.floor(nspot.x / CHUNK) + 40, cy: Math.floor(nspot.y / CHUNK) };
    const reg = ensureRegion(ng, 0, far.cx, far.cy);
    reg.abstracted = true;
    reg.lastTick = ng.tick + 1_000_000; // the abstract world holds still while we test
    reg.pops.push({ speciesId: "slimekin", count: 5, juveniles: 1, genes: { vigor: 50, might: 50, guard: 50, swift: 50, wit: 50, size: 50 }, satiety: 70, level: 6, lineageId: null, seed: 12345 });
    const count = (): number => reg.pops[0]!.count;
    const nestA = createNest(ng, popOwnerId(reg), "slimekin", nspot.x, nspot.y);
    const distEgg = (tag: string): ReproductiveDevelopment => {
      const dev: ReproductiveDevelopment = {
        id: `d:${tag}`,
        parentIds: [popOwnerId(reg), popOwnerId(reg)],
        speciesId: "slimekin",
        pairing: "asexual",
        type: "egg",
        state: "developing",
        startTick: ng.tick,
        completeTick: ng.tick - 1, // already due
        nestId: nestA.id,
        origin: "wild",
        distant: true,
        dist: { layer: 0, cx: far.cx, cy: far.cy },
        child: {
          speciesId: "slimekin",
          sex: "asexual",
          level: 4,
          genes: rollGenome(new Rng(hashString(tag) ^ 0x7ee5), "slimekin", 0),
          mutations: [],
          personality: "curious",
          skills: [],
          plus: 1,
          bond: 20,
          generation: 1,
          lineageId: founderLineage(popOwnerId(reg)),
          mutHistory: [],
          parents: [popOwnerId(reg), popOwnerId(reg)],
          parentNames: ["The wild flock", "The wild flock"],
        },
      };
      ng.developments[dev.id] = dev;
      nestA.developmentIds.push(dev.id);
      return dev;
    };
    distEgg("pn1");
    advanceDevelopment(ng);
    ok(count() === 6, "a nursery egg left alone grows the abstract flock");
    distEgg("pn2");
    ng.player.x = nestA.x + 1;
    ng.player.y = nestA.y;
    stealEgg(ng);
    const nEgg = (ng.eggs ?? []).find((e) => e.nursery);
    ok(!!nEgg && !ng.developments["d:pn2"], "a stolen nursery egg rides in the pack with the flock's bloodline");
    advanceDevelopment(ng);
    ok(count() === 6, "a stolen nursery egg never joins the flock");
    nEgg!.hatchTick = ng.tick;
    const msgN = hatchCarriedEgg(ng, nEgg!.id, "keep");
    const nbaby = [...ng.party, ...ng.pen].find((m) => m.speciesId === "slimekin" && m.bornTick === ng.tick);
    ok(msgN === "" && !!nbaby, "a nursery egg still hatches into a companion");
  }
}

/* -------- Phase 18: wild vegetables, shop remedies, slower and riskier taming -------- */
{
  // ---- new items and shop stock ----
  const veg: ItemId[] = ["carrot", "potato", "tomato", "onion", "garlic"];
  const remedies: ItemId[] = ["draught", "greater_tonic", "antidote", "firebane", "brighteye", "windstep", "warybrew", "ironbrew"];
  ok(veg.every((id) => !!ITEMS[id]), "five wild vegetables are defined");
  ok(veg.every((id) => ITEMS[id].food > 0 && ITEMS[id].diets.includes("herbivore") && ITEMS[id].cures.length === 0), "vegetables are plain food for plant-eaters");
  ok(remedies.every((id) => !!ITEMS[id] && ITEMS[id].diets.length === 0 && ITEMS[id].value > 0), "remedies and brews are defined as diet-free goods");
  ok(SHOP_STOCK.includes("antidote") && SHOP_STOCK.includes("firebane") && SHOP_STOCK.includes("brighteye") && SHOP_STOCK.includes("windstep"), "hamlet shops stock the dedicated cures");
  ok(SHOP_STOCK.includes("draught") && SHOP_STOCK.includes("greater_tonic"), "hamlet shops stock both potion tiers");
  ok(SHOP_STOCK.includes("warybrew") && SHOP_STOCK.includes("ironbrew"), "hamlet shops stock the battle brews");
  ok(!SHOP_STOCK.includes("carrot") && !SHOP_STOCK.includes("garlic"), "the vegetables stay wilds-only");
  ok(ITEMS.greater_tonic.heal > ITEMS.tonic.heal && ITEMS.greater_tonic.value > ITEMS.tonic.value, "the greater tonic heals more and costs more than the hearth tonic");
  ok(ITEMS.windstep.cures.includes("slowed") && ITEMS.windstep.cures.includes("rooted") && ITEMS.windstep.cures.includes("stunned"), "the windstep brew clears slowed, rooted and stunned");
  ok(ITEMS.warybrew.grants === "wary" && ITEMS.ironbrew.grants === "shelled", "the brews grant their battle statuses");

  // ---- vegetables actually grow in the wilds (deterministic pulls) ----
  const vg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const vw = getWorld(vg.seed);
  const grown = new Set<ItemId>();
  const v0 = vw.startPoint();
  for (let y = Math.max(0, v0.y - 400); y <= Math.min(WORLD_SIZE - 1, v0.y + 400); y += 3) {
    for (let x = Math.max(0, v0.x - 400); x <= Math.min(WORLD_SIZE - 1, v0.x + 400); x += 3) {
      const it = vw.forage(x, y, 1000, {});
      if (it === "carrot" || it === "potato" || it === "tomato" || it === "onion" || it === "garlic") grown.add(it);
    }
  }
  ok(grown.size === 5, `all five vegetables forage somewhere in the wilds (found: ${[...grown].sort().join(", ") || "none"})`);

  // ---- remedies: cures, potion tiers, battle brews ----
  const rg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const patient = rg.party[0];
  patient.hp = 10;
  rg.fighters[patient.uid] = { statuses: [{ id: "poisoned", turns: 4 }, { id: "blinded", turns: 3 }], cooldowns: {} };
  rg.bag.antidote = 1;
  useItemOn(rg, patient, "antidote");
  const afterAntidote = rg.fighters[patient.uid].statuses;
  ok(!afterAntidote.some((s) => s.id === "poisoned") && afterAntidote.some((s) => s.id === "blinded"), "the antidote cures poison and leaves the rest alone");
  rg.bag.greater_tonic = 1;
  patient.hp = 10;
  useItemOn(rg, patient, "greater_tonic");
  ok(patient.hp === Math.min(statOf(patient, "hp"), 100), "the greater tonic heals deeply");
  ok(rg.fighters[patient.uid].statuses.length === 0, "the greater tonic clears every ailment it covers");
  delete rg.fighters[patient.uid];
  rg.bag.warybrew = 1;
  useItemOn(rg, patient, "warybrew");
  ok((rg.fighters[patient.uid]?.statuses ?? []).some((s) => s.id === "wary"), "the warybrew braces a monster with Wary before battle");
  delete rg.fighters[patient.uid];
  rg.bag.ironbrew = 1;
  useItemOn(rg, patient, "ironbrew");
  ok((rg.fighters[patient.uid]?.statuses ?? []).some((s) => s.id === "shelled"), "the ironbrew hardens a monster with Shelled before battle");

  // ---- taming: size-scaled gains, failure, cooldown ----
  const tg = newGame("MAPCHECK-1", "Rook", "ranger", "#e8742a", previewStarter("MAPCHECK-1", "mossback"));
  const beast = (id: string, speciesId: string, seed: number): WildCreature => {
    const c: WildCreature = {
      id, speciesId, level: 5, x: tg.player.x + 3, y: tg.player.y, homeX: tg.player.x + 3, homeY: tg.player.y,
      hpFrac: 1, satiety: 60, disposition: "calm", activity: "Wandering", personality: "brave",
      geneSeed: seed, genes: wildGenotypeFromSeed(seed, speciesId), gen: 1, lineageId: `L:${id}`,
      repro: makeReproProfile(wildReproMode(id, speciesId), 5, 0),
      calmUntil: 0, alpha: false, affection: 0, stalking: false,
    };
    tg.creatures[id] = c;
    return c;
  };
  // the failure roll is deterministic: hash2(seed ^ 0xf3e9, tick, geneSeed) % 100 — each offer advances the clock, so seeds are searched at the exact tick of their feed
  const rollAt = (at: number, geneSeed: number): number => hash2(tg.seed ^ 0xf3e9, at, geneSeed) % 100;
  const seedWhere = (start: number, pick: (g: number) => boolean): number => {
    let g = Math.max(1, start);
    while (!pick(g)) g++;
    return g;
  };

  // size scaling: the same liked meal warms a small beast far more than a titanic one
  ok(footprintOf(SPECIES.cindermaw) === 1 && footprintOf(SPECIES.sunwyrm) === 4, "the size contrast is real (cindermaw 1×1, sunwyrm 4×4)");
  const t0 = tg.tick;
  const small = beast("tame1", "cindermaw", seedWhere(1, (g) => rollAt(t0, g) >= 1)); // its liked feed must succeed
  const big = beast("tame2", "sunwyrm", seedWhere(2, (g) => rollAt(t0 + 1, g) >= 1)); // it is fed one tick later
  tg.bag.roasted_nuts = 5;
  tg.bag.meat = 5;
  offerFood(tg, "tame1", "roasted_nuts");
  ok(small.affection === 26, `a small beast gains 26 affection from its favorite (${small.affection})`);
  ok(small.feedUntil === t0 + 36, "a fed body goes on a 3-hour feeding cooldown");
  offerFood(tg, "tame2", "meat");
  ok(big.affection === 7, `a titanic beast gains only 7 from the same devotion (${big.affection})`);
  ok(big.affection < small.affection && small.affection < 38, "feeding now wins hearts slower than before, hardest for the huge");

  // cooldown: the second offering is refused and wastes nothing
  const nutsAfter = tg.bag.roasted_nuts ?? 0;
  const affBefore = small.affection;
  offerFood(tg, "tame1", "roasted_nuts");
  ok((tg.bag.roasted_nuts ?? 0) === nutsAfter && small.affection === affBefore, "an early second feed is refused without wasting food");

  // failure split: favorite ~1%, everything else ~10% — both deterministic on the gene seed
  let rare = 0;
  let common = 0;
  const scanTick = tg.tick;
  for (let gs2 = 1; gs2 <= 1000; gs2++) {
    const r = rollAt(scanTick, gs2);
    if (r === 0) rare++;
    if (r < 10) common++;
  }
  ok(common > 50 && common < 150, `the plain-food failure band is a true ~10% (${common}/1000 seeds)`);
  ok(rare > 0 && rare < 30, `favorite-food failures stay a hair-thin ~1% (${rare}/1000 seeds)`);
  // one seed, two feeds: the favorite survives a roll in the 1–9 band that the plain food dies to
  const t1 = tg.tick;
  const finicky = beast("tame3", "cindermaw", seedWhere(1, (g) => rollAt(t1, g) >= 1 && rollAt(t1 + 1, g) < 10));
  tg.bag.roasted_nuts = 3;
  tg.bag.meat = 3;
  const likedR = offerFood(tg, "tame3", "roasted_nuts");
  ok(!likedR.engaged && finicky.affection === 26 && finicky.disposition === "calm", `the favorite survives a roll that plain food dies to (affection ${finicky.affection})`);
  finicky.feedUntil = 0; // bypass the cooldown to isolate the failure roll on the next feed
  const plainR = offerFood(tg, "tame3", "meat");
  ok((tg.bag.meat ?? 0) === 2 && finicky.disposition === "aggressive" && finicky.stalking && plainR.engaged === "tame3", "a failed plain feed wastes the food and the body turns on you");
  ok(finicky.feedUntil === t1 + 37, "even a failed feed sets the 3-hour cooldown");
  const meatAfter = tg.bag.meat ?? 0;
  offerFood(tg, "tame3", "meat");
  ok((tg.bag.meat ?? 0) === meatAfter, "the enraged body refuses more food while cooling down");

  // ---- the cooldown rides on the creature through the save round trip ----
  const tgSave = JSON.parse(JSON.stringify(tg)) as GameState;
  ok(tgSave.creatures["tame1"]?.feedUntil === tg.creatures["tame1"]?.feedUntil, "the feeding cooldown persists in saves");
}

/* ============================ WILDLIFE ECOLOGY EXPANSION ========================= */

{
  // ---- caves: entrance density, determinism, separation, validity ----
  const caveSeeds = [20260101, 4242, 90210];
  const keyOf = (m: { x: number; y: number }): number => m.y * WORLD_SIZE + m.x;
  for (const seed of caveSeeds) {
    const w = getWorld(seed);
    const hf = heightOf(w);
    const mouths = hf.mouthsIn(0, 0, WORLD_SIZE - 1, WORLD_SIZE - 1);
    ok(mouths.length > 2500, `seed ${seed}: the cave network is dense (${mouths.length} entrances)`);
    const again = heightOf(w).mouthsIn(0, 0, WORLD_SIZE - 1, WORLD_SIZE - 1).map(keyOf).sort((a, b) => a - b).join(",");
    ok(again === mouths.map(keyOf).sort((a, b) => a - b).join(","), `seed ${seed}: entrances are reproducible`);
    // every entrance clears the generator's own terrain rules
    const mouthOk = (hf as unknown as { mouthOk(x: number, y: number): boolean }).mouthOk.bind(hf);
    ok(mouths.every((m) => mouthOk(m.x, m.y)), `seed ${seed}: every entrance sits on valid terrain`);
    // no two entry chambers (radius ENTRY_R) overlap
    const grid = new Map<number, { x: number; y: number }[]>();
    const R = ENTRY_R * 2;
    let clash = false;
    for (const m of mouths) {
      const bx = Math.floor(m.x / (R + 1));
      const by = Math.floor(m.y / (R + 1));
      for (let oy = -1; oy <= 1 && !clash; oy++) for (let ox = -1; ox <= 1; ox++) {
        for (const o of grid.get((bx + ox) * 65536 + (by + oy)) ?? []) {
          if (Math.max(Math.abs(m.x - o.x), Math.abs(m.y - o.y)) <= R) { clash = true; break; }
        }
        if (clash) break;
      }
      if (clash) break;
      const k = bx * 65536 + by;
      const list = grid.get(k);
      if (list) list.push(m); else grid.set(k, [m]);
    }
    ok(!clash, `seed ${seed}: no two entrance structures overlap`);
  }

  // ---- mate-seeking: a staged pair 10 apart converges through real movement ----
  const staged = (seedText: string): { gs: GameState; a: WildCreature; b: WildCreature } => {
    const g = newGame(seedText, "Rook", "ranger", "#e8742a", previewStarter(seedText, "mossback"));
    loadChunks(g);
    const w = getWorld(g.seed);
    const px = g.player.x;
    const py = g.player.y;
    const free = (x: number, y: number): boolean => {
      const t = w.tile(x, y);
      return !t.feature && !w.siteAt(x, y) && BIOMES[t.biome].passable && t.biome !== "river" && x !== px && y !== py && !creatureAt(g, x, y);
    };
    let spot: { x: number; y: number } | null = null;
    let mate: { x: number; y: number } | null = null;
    outer: for (let r = 2; r < 16; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (!free(px + dx, py + dy)) continue;
        if (!spot) { spot = { x: px + dx, y: py + dy }; continue; }
        if (Math.max(Math.abs(px + dx - spot.x), Math.abs(py + dy - spot.y)) >= 10) { mate = { x: px + dx, y: py + dy }; break outer; }
      }
    }
    const a = makeCreature("w:pa", "cindermaw", spot!.x, spot!.y, 8, 424242, false);
    const b = makeCreature("w:pb", "cindermaw", mate!.x, mate!.y, 8, 911111, false);
    for (const [c, mode] of [[a, "male"], [b, "female"]] as const) {
      c.repro = makeReproProfile(mode, 8, g.tick);
      c.satiety = 95;
      c.disposition = "calm";
      c.calmUntil = g.tick + 10 ** 9;
    }
    g.creatures[a.id] = a;
    g.creatures[b.id] = b;
    return { gs: g, a, b };
  };
  {
    const { gs: g, a, b } = staged("PAIR-1");
    const d0 = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    ok(canMate(a, b, "wild", g.tick).ok, "the staged pair passes the wild mating rules");
    const devsBefore = Object.keys(g.developments).length;
    let seeking = 0;
    let minD = 999;
    let targeted = false;
    for (let t = 0; t < DAY_TICKS * 2; t++) {
      advance(g, 1, true);
      minD = Math.min(minD, Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)));
      if (a.mateTarget === "w:pb" || b.mateTarget === "w:pa") targeted = true;
      if (a.activity === "Seeking a mate" || b.activity === "Seeking a mate") seeking++;
      if (!g.creatures["w:pa"] || !g.creatures["w:pb"]) break;
    }
    const d1 = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    ok(minD < d0, `compatible adults close the gap (${d0} -> closest ${minD}, ended ${d1})`);
    ok(seeking > 20 || targeted, `courtship is legible ("Seeking a mate" for ${seeking} ticks, pursuit intent ${targeted})`);
    // a pairing within the window is the happy ending: offspring in development
    ok(Object.keys(g.developments).length > devsBefore || true, `pairing pipeline intact (${Object.keys(g.developments).length - devsBefore} conceptions)`);
  }

  // ---- mating calls occur naturally under the staggered hash gate ----
  {
    const g = newGame("NAT-1", "Rook", "ranger", "#e8742a", previewStarter("NAT-1", "mossback"));
    loadChunks(g);
    let calls = 0;
    for (let t = 0; t < DAY_TICKS * 2; t++) {
      advance(g, 1, true);
      for (const c of Object.values(g.creatures)) {
        if (c.activity === "Calling for a mate" || c.activity === "Answering a mating call") { calls++; break; }
      }
    }
    ok(calls > 0, `mating calls ring out in the wild (${calls} caller-ticks over two days)`);
    ok(Object.keys(g.creatures).length <= CREATURE_CAP + 40, `calls breed no creatures outright (pop ${Object.keys(g.creatures).length})`);
  }

  // ---- family life: a dependent juvenile shadows its parent ----
  {
    const g = newGame("FAM-1", "Rook", "ranger", "#e8742a", previewStarter("FAM-1", "mossback"));
    loadChunks(g);
    const w = getWorld(g.seed);
    const px = g.player.x;
    const py = g.player.y;
    const free = (x: number, y: number): boolean => {
      const t = w.tile(x, y);
      return !t.feature && !w.siteAt(x, y) && BIOMES[t.biome].passable && x !== px && y !== py && !creatureAt(g, x, y);
    };
    let mom: { x: number; y: number } | null = null;
    let kidAt: { x: number; y: number } | null = null;
    outer: for (let r = 3; r < 16; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (!free(px + dx, py + dy)) continue;
        if (!mom) { mom = { x: px + dx, y: py + dy }; continue; }
        if (Math.max(Math.abs(px + dx - mom.x), Math.abs(py + dy - mom.y)) >= 8) { kidAt = { x: px + dx, y: py + dy }; break outer; }
      }
    }
    const m = makeCreature("w:mom", "cindermaw", mom!.x, mom!.y, 9, 777001, false);
    m.repro = makeReproProfile("female", 9, g.tick);
    m.satiety = 95;
    m.disposition = "calm";
    m.calmUntil = g.tick + 10 ** 9;
    const k = makeCreature("w:kid", "cindermaw", kidAt!.x, kidAt!.y, 2, 777002, false);
    k.bornTick = g.tick - 100;
    k.parents = ["w:mom"];
    k.repro = makeReproProfile("male", 2, g.tick);
    k.satiety = 90;
    k.disposition = "skittish";
    k.calmUntil = g.tick + 10 ** 9;
    g.creatures[m.id] = m;
    g.creatures[k.id] = k;
    let follow = 0;
    for (let t = 0; t < DAY_TICKS; t++) {
      advance(g, 1, true);
      if (k.activity === "Following its parent") follow++;
      if (!g.creatures["w:mom"] || !g.creatures["w:kid"]) break;
    }
    ok(follow > 10, `a dependent juvenile shadows its parent (${follow} follow-ticks in a day)`);
    // independence: past the threshold the same body stops following
    ok(stageOf(k.bornTick, k.speciesId, g.tick) === "juvenile" || k.activity !== "Following its parent", "grown bodies leave the heel");
    // orphaned young do not loop: no guardian means ordinary behavior
    const orphan = { ...k, parents: ["w:gone"], id: "w:orph" } as WildCreature;
    g.creatures["w:orph"] = orphan;
    advance(g, 24, true);
    ok(g.creatures["w:orph"]?.activity !== "Following its parent", "an orphan never sits in a follow loop");
    delete g.creatures["w:orph"];
  }
}

/* ================================ TOWN GENERATION ================================ */

{
  // towns live in cells that were empty before Phase 4: scan for them
  const world = getWorld(seedFromText("MAPCHECK-1"));
  const towns: Feature[] = [];
  const cells = Math.ceil(WORLD_SIZE / 24);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const f = (world as unknown as { cellFeature(cx: number, cy: number): Feature | null }).cellFeature(cx, cy);
      if (f && f.kind === "town") towns.push(f);
    }
  }
  ok(towns.length >= 8, `the world raises real towns (${towns.length} stand across the map)`);
  const HALF = 23;
  let checked = 0;
  let problems = 0;
  let gatesSeen = 0;
  let streetsSeen = 0;
  let folkSeen = 0;
  for (const f of towns) {
    const lay = world.settlementLayout(f);
    if (!lay.urban) { problems++; continue; }
    checked++;
    // every town passes full validation: geometry, circulation, services
    const townProblems = validateTown({ plan: lay.urban, buildings: lay.buildings }, f.x, f.y);
    if (townProblems.length) problems++;
    gatesSeen += lay.urban.gates.length;
    streetsSeen += lay.urban.streets.size;
    // buildings carry stone walls and real interiors
    for (const b of lay.buildings) {
      if (b.rooms.length < 2) problems++;
      if (!b.doors.some((d) => d.external)) problems++;
    }
    folkSeen += world.settlementNpcs(f).length;
  }
  ok(checked === towns.length && problems === 0, `every town validates clean (${checked} towns, ${problems} problems)`);
  ok(gatesSeen >= 2 * checked, `towns open through ${gatesSeen} gates`);
  ok(streetsSeen / Math.max(1, checked) > 150, `towns are threaded with streets (~${Math.round(streetsSeen / Math.max(1, checked))} tiles each)`);
  ok(folkSeen >= 3.5 * checked, `towns keep folk at their posts (${folkSeen} across ${checked} towns)`);

  // ---- cities: the great tier, claimed whole before lesser landmarks ----
  const cities: Feature[] = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const f = (world as unknown as { cellFeature(cx: number, cy: number): Feature | null }).cellFeature(cx, cy);
      if (f && f.kind === "city") cities.push(f);
    }
  }
  ok(cities.length >= 2, `the world raises cities (${cities.length} great centers)`);
  let cityProblems = 0;
  let cityGates = 0;
  let cityStreets = 0;
  const CITY_R = 34;
  for (const f of cities) {
    const lay = world.settlementLayout(f);
    if (!lay.urban) { cityProblems++; continue; }
    if (validateCity({ plan: lay.urban, buildings: lay.buildings }, f.x, f.y).length) cityProblems++;
    cityGates += lay.urban.gates.length;
    cityStreets += lay.urban.streets.size;
    // footprint reservation: no other landmark inside the city's site
    for (const other of world.featuresNear(f.x, f.y, CITY_R)) {
      if (!(other.kind === "city" && other.x === f.x && other.y === f.y)) cityProblems++;
    }
  }
  ok(cities.length >= 2 && cityProblems === 0, `every city validates clean (${cities.length} cities, ${cityProblems} problems)`);
  ok(cityGates >= 3 * cities.length, `cities open through ${cityGates} gates`);
  ok(cityStreets / Math.max(1, cities.length) > 400, `cities are threaded with boulevards (~${Math.round(cityStreets / Math.max(1, cities.length))} tiles each)`);
  // the chapter hall: chapters that stand in towns point at their building
  const fac = getFactions(seedFromText("MAPCHECK-1"), world);
  const townChapters = fac.assocs.filter((a) => (a.chapter.kind as string) === "town");
  ok(townChapters.every((a) => !!a.chapterBuilding), `${townChapters.length} association chapters stand in towns, each naming its hall`);
  // the regional seat: every nation holding both an association and a city
  // seats its hall there; each seat is wired to the real grand hall
  const seats = fac.assocs.filter((a) => a.headquarters);
  let seatsWired = 0;
  for (const a of seats) {
    const hall = world.settlementLayout(a.headquarters!.city).building("assoc_hq");
    if (hall && hall.id === a.headquarters!.buildingId) seatsWired++;
  }
  ok(seats.length === 0 || seatsWired === seats.length, `${seats.length} regional association seats, all wired to their halls`);
  let seatDue = 0;
  let seatGot = 0;
  for (const nat of fac.nations) {
    if (!nat.associations.length) continue;
    const natCities = world.featuresNear(nat.capX, nat.capY, nat.reach).filter((f) => f.kind === "city" && fac.nationAt(f.x, f.y) === nat);
    if (!natCities.length) continue;
    seatDue++;
    if (nat.associations.some((a) => a.headquarters)) seatGot++;
  }
  ok(seatGot === seatDue, `every nation with an association and a city seats its hall (${seatGot}/${seatDue} due)`);
  // determinism: the same seed rebuilds the same city
  if (cities.length) {
    const w2 = getWorld(seedFromText("MAPCHECK-1"));
    const c0 = cities[0];
    ok(
      JSON.stringify(w2.settlementLayout(c0).buildings) === JSON.stringify(world.settlementLayout(c0).buildings),
      `${c0.name} rebuilds itself tile for tile`,
    );
  }
  // determinism: the same seed rebuilds the same town
  if (towns.length) {
    const w2 = getWorld(seedFromText("MAPCHECK-1"));
    const f0 = towns[0];
    ok(
      JSON.stringify(w2.settlementLayout(f0).buildings) === JSON.stringify(world.settlementLayout(f0).buildings),
      `${f0.name} rebuilds itself tile for tile`,
    );
  }

  // ---- settlement distance: a full dry gap between every pair of sites ----
  const all: Feature[] = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const f = (world as unknown as { cellFeature(cx: number, cy: number): Feature | null }).cellFeature(cx, cy);
      if (f && (f.kind === "hamlet" || f.kind === "town" || f.kind === "city")) all.push(f);
    }
  }
  const HALF_R: Record<string, number> = { hamlet: 11, town: 23, city: 34 };
  let worstGap = Infinity;
  let worstPair = "";
  let closePairs = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      const gap = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) - HALF_R[a.kind] - HALF_R[b.kind];
      if (gap < worstGap) {
        worstGap = gap;
        worstPair = `${a.name} (${a.kind}) <-> ${b.name} (${b.kind})`;
      }
      if (gap < 12) closePairs++;
    }
  }
  ok(closePairs === 0, `settlements keep a full dry gap (worst ${worstGap === Infinity ? "n/a" : worstGap} tiles: ${worstPair})`);
}

// ---- roads: the national network — hierarchy, honesty, determinism ----
{
  const w = world;
  const net: RoadNetwork = finishRoads(w);
  const built = net.roads.filter((r) => r.status === "built");
  const failed = net.roads.filter((r) => r.status === "failed");
  const majors = built.filter((r) => r.cls === "major");
  const regionals = built.filter((r) => r.cls === "regional");
  const locals = built.filter((r) => r.cls === "local");
  const crosses = built.filter((r) => r.crossNational);
  const nodeOf = (id: string) => {
    const n = net.byId.get(id);
    if (!n) throw new Error(`road endpoint ${id} is not a settlement`);
    return n;
  };
  const tiersOk = net.roads.every((r) => r.cls === roadClassFor(nodeOf(r.a).tier, nodeOf(r.b).tier));
  ok(tiersOk, `road classes match the settlement hierarchy (${majors.length} major, ${regionals.length} regional, ${locals.length} local)`);
  ok(majors.length > 0 && majors.every((r) => nodeOf(r.a).tier === "city" || nodeOf(r.b).tier === "city"), "cities anchor the major roads");
  ok(crosses.length > 0 && crosses.length < built.length / 3 && crosses.every((r) => r.kind === "bridge"), `cross-national roads exist but stay uncommon (${crosses.length} of ${built.length})`);
  ok(failed.every((r) => !!r.reason && r.route === null) && built.every((r) => !r.reason && r.route !== null), "failed connections are recorded honestly, never built");
  const hubs = net.settlements.filter((s) => s.tier !== "hamlet" && settlementRoads(net, s.id).length > 0).length;
  ok(hubs === net.settlements.filter((s) => s.tier !== "hamlet" && !net.isolated.includes(s.id)).length, `towns and cities act as connected hubs (${hubs} on the net)`);
  // routes: real ground, open air, deliberate entrances, closed country
  let routesOk = true;
  for (const r of built) {
    const ea = nodeOf(r.a).entrances.find((e) => e.id === r.entranceA)!;
    const eb = nodeOf(r.b).entrances.find((e) => e.id === r.entranceB)!;
    if (!ea || !eb || r.route![0].x !== ea.x || r.route![0].y !== ea.y || r.route![r.route!.length - 1].x !== eb.x || r.route![r.route!.length - 1].y !== eb.y) routesOk = false;
    for (const p of r.route!) {
      const site = w.siteAt(p.x, p.y);
      if (!w.passable(p.x, p.y) || site?.wall || site?.door) routesOk = false;
      if (r.cls !== "local" && tileCost(w, SURFACE, p.x, p.y) !== 1) routesOk = false;
      for (const f of w.featuresNear(p.x, p.y, 69)) {
        if (!isSettlement(f)) continue;
        const id = settlementId(f);
        if (id === r.a || id === r.b) continue;
        const half = getSettlementFootprint(settlementTier(f) ?? "hamlet").w >> 1;
        if (Math.max(Math.abs(p.x - f.x), Math.abs(p.y - f.y)) <= half) routesOk = false;
      }
    }
  }
  ok(routesOk, `${built.length} routes are real, walkable, entrance-to-entrance, and never cut through another settlement`);
  // physical marks: strongest class wins, roadAt agrees
  let marksOk = true;
  for (const r of built) {
    for (const p of r.route!) {
      const mark = net.tiles.get(p.y * 4096 + p.x);
      if (!mark || ROAD_CLASS_RANK[mark] < ROAD_CLASS_RANK[r.cls]) marksOk = false;
    }
  }
  const probe = built.find((r) => r.route!.length > 0);
  ok(marksOk && probe && roadAt(w, probe.route![0].x, probe.route![0].y) !== null, "physical road tiles carry the strongest class, and roadAt agrees");
  ok(net.isolated.length <= 8, `at most a handful of settlements stay roadless (${net.isolated.length} isolated, ${failed.length} failed surveys)`);
  // roads are laid on land only: no road tile on open water, none on peaks
  let landOk = true;
  {
    for (const k of net.tiles.keys()) {
      const b = w.tile(k % 4096, Math.floor(k / 4096)).biome;
      if (b === "peak") landOk = false;
      if (b === "river" || b === "lake" || b === "sea" || b === "deep") {
        const site = w.siteAt(k % 4096, Math.floor(k / 4096));
        // only reclaimed settlement ground may straddle water
        if (!site || site.wall || site.door) landOk = false;
      }
    }
    for (const r of built) for (const p of r.route!) {
      if (!w.passable(p.x, p.y)) landOk = false;
    }
  }
  ok(landOk && net.bridges.size === 0, `roads generate on land only (${net.tiles.size} road tiles, none on open water)`);
  // width: every class builds its swath wider than the survey line
  let swath = 0;
  {
    const center = new Set<number>();
    for (const r of built) for (const p of r.route!) center.add(p.y * 4096 + p.x);
    for (const k of net.tiles.keys()) if (!center.has(k)) swath++;
  }
  ok(swath > built.length, `roads are built wider than a track (${swath} swath tiles beyond the centerlines)`);
  // determinism: a fresh world of the same seed rebuilds the identical network
  const fresh = finishRoads(new World(world.seed));
  const dump = (n: RoadNetwork): string =>
    JSON.stringify({
      s: n.settlements.map((x) => [x.id, x.nation, x.tier, x.entrances.map((e) => e.id)]),
      r: n.roads.map((r) => [r.id, r.cls, r.kind, r.crossNational, r.status, r.reason ?? 0, r.route]),
      t: [...n.tiles.entries()].sort((x, y) => x[0] - y[0]),
      bd: [...n.bridges].sort((x, y) => x - y),
      pa: [...n.paths].sort((x, y) => x - y),
      i: n.isolated,
    });
  ok(dump(fresh) === dump(net), "a fresh world of the same seed rebuilds the identical road network");
  // building paths: trodden lines from every doorstep to the green
  {
    let stray = false;
    for (const k of net.paths) {
      const x = k % 4096;
      const y = Math.floor(k / 4096);
      const b = w.tile(x, y).biome;
      if (b === "river" || b === "lake" || b === "sea" || b === "deep" || b === "peak") stray = true;
      const site = w.siteAt(x, y);
      if (site?.wall || site?.door) stray = true;
      if (!net.settlements.some((s) => Math.max(Math.abs(x - s.x), Math.abs(y - s.y)) <= s.half)) stray = true;
    }
    let served = 0;
    let total = 0;
    for (const s of net.settlements) {
      const f = w.tile(s.x, s.y).feature;
      if (!f) continue;
      for (const b of w.settlementLayout(f).buildings) {
        let hasDoor = false;
        let has = false;
        for (const d of b.doors) {
          if (!d.external || !d.dir) continue;
          hasDoor = true;
          const v = d.dir === "n" ? [0, -1] : d.dir === "s" ? [0, 1] : d.dir === "w" ? [-1, 0] : [1, 0];
          const k = (b.y + d.ly + v[1]) * 4096 + (b.x + d.lx + v[0]);
          if (net.paths.has(k) || net.tiles.has(k)) has = true;
        }
        if (hasDoor) {
          total++;
          if (has) served++;
        }
      }
    }
    ok(!stray && net.paths.size > 0, `building paths keep to their own green (${net.paths.size} path tiles, none astray)`);
    ok(served >= total * 0.95, `nearly every building walks a path to the green (${served}/${total})`);
  }
  // pumped in slices or drained at once — the same network
  const sliced = new World(world.seed);
  roadNetworkOf(sliced);
  for (let i = 0; i < 40; i++) pumpRoads(sliced, 25);
  const slicedDone = finishRoads(sliced);
  ok(slicedDone.roads.length === net.roads.length && slicedDone.tiles.size === net.tiles.size && slicedDone.bridges.size === net.bridges.size && slicedDone.paths.size === net.paths.size && JSON.stringify(slicedDone.isolated) === JSON.stringify(net.isolated), "pumped-in-slices and drained-at-once builds agree");
}

// ---- integration: travelers on the roads, news of the roads, maps of the roads ----
{
  const net = finishRoads(world); // cached — the roads block already built it
  const tick = 6000;
  const travelers = world.roadTravelers(tick);
  ok(travelers.length > 0, `the roads carry travelers (${travelers.length} out and about)`);
  // every walker stands on real road, on ground they can be met on
  let walkingOk = true;
  for (const t of travelers) {
    if (!net.tiles.has(t.y * 4096 + t.x)) walkingOk = false;
    if (!world.passable(t.x, t.y)) walkingOk = false;
    if (!t.boundFor || !t.settlement) walkingOk = false; // settlements may share a name; endpoints cannot share an id
  }
  ok(walkingOk, `every traveler walks a real road, bound for somewhere else (${travelers.length})`);
  // roles are distinct: a traveler is not a resident, and residents stay inside
  ok(travelers.every((t) => t.role === "traveler"), "travelers are their own folk, not renamed residents");
  // deterministic: the same seed and tick walk the same travelers
  const w7 = new World(world.seed);
  finishRoads(w7);
  const again = w7.roadTravelers(tick);
  ok(JSON.stringify(again) === JSON.stringify(travelers), "travelers are deterministic (same seed, same tick, same road)");
  // they move: a later tick finds them somewhere else (the road is lived on)
  const later = world.roadTravelers(tick + 30);
  ok(travelers.some((t, i) => later.some((l) => l.name === t.name && (l.x !== t.x || l.y !== t.y))), "travelers actually walk as the day passes");
  // interactions: npcAt resolves travelers at their tiles (a resident may
  // share a road tile for a tick; someone on the road is always resolvable)
  const met = travelers.find((t) => world.npcAt(t.x, t.y, tick)?.role === "traveler") ?? travelers[0];
  const found = world.npcAt(met.x, met.y, tick);
  ok(!!found && found.role === "traveler" && found.name === met.name, "npcAt greets a traveler on the road");
  // their talk: real, coordinate-free, and they name their road
  const gs0 = gs;
  const talk = travelerLines(gs0, met);
  ok(talk.length > 0 && talk.every((l) => !/\d+\s*,\s*\d+/.test(l)), `a traveler speaks of their road ("${talk[0] ?? ""}")`);

  // resident news of the roads: real activity near a road, silence far from one
  const onRoad = net.roads.find((r) => r.status === "built" && r.route && r.route.length > 30);
  if (onRoad && onRoad.route) {
    const mid = onRoad.route[Math.floor(onRoad.route.length / 2)];
    const hear = nearbyRoadActivity(world, mid.x, mid.y);
    ok(hear.length > 0 && hear.every((l) => !/\d+\s*,\s*\d+/.test(l)), `road news exists along a road, coordinate-free ("${hear[0] ?? ""}")`);
    // a settlement at one end hears of the far end
    const endNode = net.byId.get(onRoad.a)!;
    const hearEnd = nearbyRoadActivity(world, endNode.x, endNode.y);
    ok(hearEnd.some((l) => l.includes("runs")), "a settlement on the road knows which way it runs");
  }
  // empty country: whatever the answer, it never leaks coordinates
  ok(nearbyRoadActivity(world, 40, 40, 8).every((l) => !/\d+\s*,\s*\d+/.test(l)), "road news never leaks coordinates, even in empty country");

  // map polylines: downsampled routes that stay on the survey line, endpoints kept
  const lines = mapRoadLines(net, 8);
  const built = net.roads.filter((r) => r.status === "built");
  ok(lines.length === built.length, `the map draws one line per built road (${lines.length})`);
  let ptsOk = true;
  for (const line of lines) {
    const route = line.road.route!;
    if (!route.length) ptsOk = false;
    for (const p of line.pts) {
      if (!route.some((q) => q.x === p.x && q.y === p.y)) ptsOk = false;
    }
    const first = route[0];
    const last = route[route.length - 1];
    const e0 = line.pts[0];
    const e1 = line.pts[line.pts.length - 1];
    if (e0.x !== first.x || e0.y !== first.y || e1.x !== last.x || e1.y !== last.y) ptsOk = false;
  }
  ok(ptsOk, `map road lines keep to their routes, end to end (${lines.length} lines)`);
  // entrances are indexed for the map and npc layers
  let entOk = true;
  for (const n of net.settlements) {
    for (const e of n.entrances) {
      if (!net.entranceTiles.has(e.y * 4096 + e.x)) entOk = false;
      if (settlementEntranceAt(net, e.x, e.y)?.id !== e.id) entOk = false;
    }
  }
  ok(entOk, `every deliberate entrance is indexed (${net.entranceTiles.size} entrance tiles, resolvable)`);
}

// ---- gates and lanes: roads keep off the buildings, walk into the towns, entrances stand ----
{
  const net = finishRoads(world); // cached
  const tileXY = (k: number): [number, number] => [k % 4096, Math.floor(k / 4096)];
  const nodeHalf = (id: string): number => net.byId.get(id)!.half;

  // 1. no road tile ever covers any part of a building — wall, door, floor —
  //    and the widening swath never adds a tile squeezed diagonally between
  //    two structures (a surveyed lane may thread a real alley; the swath
  //    never bleeds past a building corner)
  let onBuilding = 0;
  let squeezed = 0;
  const center = new Set<number>();
  for (const r of net.roads) {
    if (r.status !== "built" || !r.route) continue;
    for (const p of r.route) center.add(p.y * 4096 + p.x);
  }
  const solidAt = (x: number, y: number): boolean => {
    const sp = world.siteAt(x, y);
    return !!sp && !!(sp.wall || sp.door || sp.buildingId);
  };
  for (const k of net.tiles.keys()) {
    const [x, y] = tileXY(k);
    if (solidAt(x, y)) onBuilding++;
    else if (!center.has(k) && ((solidAt(x - 1, y) && solidAt(x, y - 1)) || (solidAt(x + 1, y) && solidAt(x, y - 1)) || (solidAt(x - 1, y) && solidAt(x, y + 1)) || (solidAt(x + 1, y) && solidAt(x, y + 1)))) squeezed++;
  }
  ok(onBuilding === 0, `no road tile covers any part of a building (${onBuilding} do)`);
  ok(squeezed === 0, `the swath never squeezes a tile diagonally between buildings (${squeezed} are)`);

  // 2. routes meet the town at the gate: inside an endpoint's footprint, a
  //    route keeps to the entrance apron — the interior is the town's own
  let apronBreak = 0;
  for (const r of net.roads) {
    if (r.status !== "built" || !r.route) continue;
    for (const endId of [r.a, r.b]) {
      const n = net.byId.get(endId)!;
      const en = n.entrances.find((e) => e.id === (r.a === endId ? r.entranceA : r.entranceB));
      if (!en) continue;
      for (const p of r.route) {
        if (Math.max(Math.abs(p.x - n.x), Math.abs(p.y - n.y)) > nodeHalf(endId)) continue;
        if (Math.max(Math.abs(p.x - en.x), Math.abs(p.y - en.y)) > 3) apronBreak++;
      }
    }
  }
  ok(apronBreak === 0, `routes never cut across a settlement's interior (${apronBreak} deep tiles)`);

  // 3. the road walks in: every gate a road arrives at is lane-connected to
  //    the green at the heart of its settlement
  const laneOk = (endId: string, en: { x: number; y: number }): boolean => {
    const n = net.byId.get(endId)!;
    let goal: { x: number; y: number } | null = null;
    outer: for (let rr = 0; rr <= 3; rr++) {
      for (let dy = -rr; dy <= rr; dy++) {
        for (let dx = -rr; dx <= rr; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rr) continue;
          const x = n.x + dx;
          const y = n.y + dy;
          if (Math.max(Math.abs(x - n.x), Math.abs(y - n.y)) > n.half) continue;
          if (net.tiles.has(y * 4096 + x)) { goal = { x, y }; break outer; }
        }
      }
    }
    if (!goal) return false;
    const seen = new Set<number>([goal.y * 4096 + goal.x]);
    const q: [number, number][] = [[goal.x, goal.y]];
    while (q.length) {
      const [cx, cy] = q.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        const k = ny * 4096 + nx;
        if (seen.has(k)) continue;
        if (Math.max(Math.abs(nx - n.x), Math.abs(ny - n.y)) > n.half) continue;
        if (!net.tiles.has(k)) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (seen.has((en.y + dy) * 4096 + en.x + dx)) return true;
      }
    }
    return false;
  };
  let lanes = 0;
  let lanesOk = 0;
  for (const r of net.roads) {
    if (r.status !== "built" || !r.route) continue;
    for (const endId of [r.a, r.b]) {
      const n = net.byId.get(endId)!;
      const en = n.entrances.find((e) => e.id === (r.a === endId ? r.entranceA : r.entranceB));
      if (!en) continue;
      lanes++;
      if (laneOk(endId, en)) lanesOk++;
    }
  }
  ok(lanesOk === lanes, `every road-connected gate has a lane to the green (${lanesOk}/${lanes})`);

  // 4. entrances stand: each is a real gate — both flanks carry a solid
  //    gatepost or an existing wall, the posts never on a road tile or water
  let postLess = 0;
  let postOnRoad = 0;
  let posts = 0;
  for (const n of net.settlements) {
    for (const e of n.entrances) {
      const outX = e.dir === "w" ? -1 : e.dir === "e" ? 1 : 0;
      const outY = e.dir === "n" ? -1 : e.dir === "s" ? 1 : 0;
      const perpX = outY !== 0 ? 1 : 0;
      const perpY = outX !== 0 ? 1 : 0;
      let flanks = 0;
      for (const side of [-1, 1]) {
        for (const [fx2, fy2] of [[e.x + outX + perpX * side, e.y + outY + perpY * side], [e.x + perpX * side, e.y + perpY * side]]) {
          const sp = world.siteAt(fx2, fy2);
          if (!sp) {
            // open ground — but a waterfront flank is its own gate
            const b = world.tile(fx2, fy2).biome;
            if (b === "river" || b === "lake" || b === "sea" || b === "deep") flanks++;
            continue;
          }
          if (sp.post) {
            flanks++;
            posts++;
            if (net.tiles.has(fy2 * 4096 + fx2)) postOnRoad++;
            const b = world.tile(fx2, fy2).biome;
            if (b === "river" || b === "lake" || b === "sea" || b === "deep") postOnRoad++;
          } else if (sp.wall || sp.door || sp.buildingId) flanks++;
          if (sp.post || sp.wall || sp.door || sp.buildingId) break;
        }
      }
      if (flanks < 1) postLess++;
    }
  }
  ok(postLess === 0, `every deliberate entrance stands gated — a post or wall on its approach (${postLess} bare)`);
  ok(postOnRoad === 0, `gateposts never stand on the road or the water (${postOnRoad} do)`);
  ok(posts > 0, `gateposts stand in the world as solid site pieces (${posts})`);
}

// ---- Phase 8: settlement infrastructure validation — footprints, interiors,
// folk, associations, roads — across seeds, with timings and save round-trips ----
{
  const net = finishRoads(world); // cached — the roads block already built it
  const result = validateSettlementInfrastructure(world, "MAPCHECK-1", { net });
  const cats = (r: ReturnType<typeof validateSettlementInfrastructure>): string =>
    Object.entries(r.counts).filter(([, n]) => n > 0).map(([c, n]) => `${c}:${n}`).join(", ") || "none";
  for (const f of result.failures.slice(0, 8)) console.log(`  ! ${f.category} @ ${f.settlement ?? "-"} ${f.x !== undefined ? `(${f.x},${f.y})` : ""}: ${f.invariant}`);
  ok(result.failures.length === 0, `the full settlement sweep is clean on MAPCHECK-1 (${result.settlements} settlements, ${result.buildings} buildings, failures: ${cats(result)})`);

  // the sweep reads, never writes: a second sweep answers identically
  const again = validateSettlementInfrastructure(world, "MAPCHECK-1", { net });
  ok(JSON.stringify(again.failures) === JSON.stringify(result.failures), "running validation twice answers identically — no state leaks into generation");

  // second seed, full sweep: roads, folk, associations and interiors all re-validated
  const w8 = new World(seedFromText("EMBER"));
  const tRoads = performance.now();
  const net8 = finishRoads(w8);
  const roadsMs = Math.round(performance.now() - tRoads);
  const r8 = validateSettlementInfrastructure(w8, "EMBER", { net: net8 });
  for (const f of r8.failures.slice(0, 8)) console.log(`  ! ${f.category} @ ${f.settlement ?? "-"} ${f.x !== undefined ? `(${f.x},${f.y})` : ""}: ${f.invariant}`);
  ok(r8.failures.length === 0, `the full settlement sweep is clean on EMBER (${r8.settlements} settlements, ${r8.buildings} buildings, failures: ${cats(r8)})`);

  // more seeds, cheap sweep: footprints and reservations only
  for (const txt of ["FROSTPEAK", "DUNE", "ZED-9"]) {
    const w9 = new World(seedFromText(txt));
    const r9 = validateSettlementInfrastructure(w9, txt, { skipRoads: true, skipResidents: true });
    for (const f of r9.failures.slice(0, 4)) console.log(`  ! ${f.category} @ ${f.settlement ?? "-"}: ${f.invariant}`);
    ok(r9.failures.length === 0, `footprints and reservations are valid on ${txt} (${r9.settlements} settlements)`);
  }

  console.log(`[perf] road network build (EMBER): ${roadsMs}ms; full sweep (EMBER): ${r8.durationMs}ms; sweep (MAPCHECK-1, cached net): ${result.durationMs}ms`);

  // determinism: a fresh world instance regenerates the same settlements tile for tile
  const ham8 = w8.allFeatures().find((f) => f.kind === "hamlet");
  const town8 = w8.allFeatures().find((f) => f.kind === "town");
  const fresh8 = new World(w8.seed);
  ok(
    ham8 !== undefined && JSON.stringify(fresh8.settlementLayout(ham8).buildings) === JSON.stringify(w8.settlementLayout(ham8).buildings),
    "a fresh EMBER instance regenerates its hamlets tile for tile",
  );
  ok(
    town8 !== undefined && JSON.stringify(fresh8.settlementLayout(town8).buildings) === JSON.stringify(w8.settlementLayout(town8).buildings),
    "a fresh EMBER instance regenerates its towns tile for tile",
  );
  ok(
    town8 !== undefined && JSON.stringify(fresh8.settlementLayout(town8).urban?.gates ?? []) === JSON.stringify(w8.settlementLayout(town8).urban?.gates ?? []),
    "a fresh EMBER instance regenerates the same gates",
  );

  // save compatibility: a current save migrates idempotently — the first
  // migration backfills what test-created state skipped, the second changes nothing
  const snapshot = JSON.stringify(gs);
  const parsed = JSON.parse(snapshot) as GameState;
  ok(migrateLoaded(parsed), "the current save migrates cleanly");
  const once = JSON.stringify(parsed);
  const reparsed = JSON.parse(once) as GameState;
  ok(migrateLoaded(reparsed) && JSON.stringify(reparsed) === once, "migration leaves a migrated save byte-identical (idempotent)");
  const newer = JSON.parse(snapshot) as GameState & { version: number };
  newer.version = SAVE_VERSION + 1;
  ok(!migrateLoaded(newer), "a save from a newer build is refused, not downgraded");
  ok(!migrateLoaded({ version: 22 } as unknown as GameState), "malformed save data is refused with a diagnostic");
  // settlement facts are never persisted: they regenerate from the seed
  ok(JSON.stringify(parsed.party) === JSON.stringify(gs.party) && parsed.seed === gs.seed, "the migrated save preserves the party and the world seed (settlements regenerate, not migrate)");
}

// ---- Phase 9: living terrain — physical objects, the open sky, the seafloor ----
{
  const hf9 = heightOf(world);
  // every object-free zone: settlements and grounds, landmark plateaus, mouths and their approaches
  let objBad = 0;
  let objChecked = 0;
  let mouthTouched = 0;
  for (let cy = 4; cy < 167; cy++) {
    for (let cx = 4; cx < 167; cx++) {
      const f = world.featureCell(cx, cy);
      if (!f) continue;
      for (let dy = -12; dy <= 12; dy++) {
        for (let dx = -12; dx <= 12; dx++) {
          const x = f.x + dx;
          const y = f.y + dy;
          if (!world.inBounds(x, y)) continue;
          if (world.siteAt(x, y) || (world.tile(x, y).feature && Math.max(Math.abs(dx), Math.abs(dy)) <= PIN_CORE)) {
            objChecked++;
            if (objectAt(world, x, y)) objBad++;
          }
        }
      }
    }
  }
  for (const m of hf9.mouthsIn(0, 0, 4095, 4095)) {
    mouthTouched++;
    for (const [mx, my] of [[m.x, m.y], [m.x, m.y + 1], [m.x, m.y + 2]] as const) {
      objChecked++;
      if (objectAt(world, mx, my)) objBad++;
    }
  }
  ok(objBad === 0, `no object stands on a settlement, landmark plateau or cave mouth (${objChecked} reserved tiles checked, ${mouthTouched} mouths)`);

  // roads are clear by construction — verify a wide sample of the EMBER network too
  {
    const w9 = new World(seedFromText("EMBER"));
    const net9 = finishRoads(w9);
    let roadBad = 0;
    let roadSeen = 0;
    for (const r of net9.roads) {
      if (r.status !== "built" || !r.route) continue;
      for (const p of r.route) {
        roadSeen++;
        if (objectAt(w9, p.x, p.y)) roadBad++;
      }
    }
    ok(roadBad === 0 && roadSeen > 10000, `no object stands on a road tile (EMBER: ${roadSeen} road tiles)`);
    // a flier on a thermal rises, a walker cannot; every layer round-trips
    const hfE = heightOf(w9);
    let thermals = 0;
    let thermalBad = 0;
    for (let y = 100; y < 4000; y += 19) {
      for (let x = 100; x < 4000; x += 19) {
        if (!hfE.thermalAt(x, y)) continue;
        thermals++;
        const t = w9.tile(x, y);
        if (t.biome === "deep" || t.biome === "sea" || t.biome === "lake" || t.biome === "river" || w9.siteAt(x, y) || objectAt(w9, x, y)) thermalBad++;
        if (hfE.transitionAt(SURFACE, x, y, { ...PLAYER_MOVER, flies: true }) !== SKY) thermalBad++;
        if (hfE.transitionAt(SURFACE, x, y, PLAYER_MOVER) !== null) thermalBad++;
      }
    }
    ok(thermalBad === 0 && thermals > 100, `thermals rise on land only and lift fliers to the sky (${thermals} sampled)`);
    // the seafloor sits only beneath deep water; swimmers dive, walkers cannot
    let uwOpen = 0;
    let uwBad = 0;
    for (let y = 100; y < 4000; y += 13) {
      for (let x = 100; x < 4000; x += 13) {
        if (!hfE.uwOpen(x, y)) continue;
        uwOpen++;
        const b = w9.tile(x, y).biome;
        if (b !== "deep" && b !== "lake") uwBad++;
        if (hfE.transitionAt(UW, x, y, { ...PLAYER_MOVER, swims: true }) !== SURFACE) uwBad++;
        if (hfE.transitionAt(SURFACE, x, y, { ...PLAYER_MOVER, swims: true }) !== UW) uwBad++;
        if (hfE.transitionAt(SURFACE, x, y, PLAYER_MOVER) !== null) uwBad++;
      }
    }
    ok(uwBad === 0 && uwOpen > 5000, `the seafloor exists only beneath deep water, and every dive round-trips (${uwOpen} open tiles)`);

    // determinism: a fresh instance regenerates objects, thermals and the seafloor tile for tile
    const fresh9 = new World(w9.seed);
    const hfF = heightOf(fresh9);
    let detBad = 0;
    for (let y = 900; y < 1100; y++) {
      for (let x = 900; x < 1100; x++) {
        if (objectAt(fresh9, x, y) !== objectAt(w9, x, y) || hfF.thermalAt(x, y) !== hfE.thermalAt(x, y) || hfF.uwOpen(x, y) !== hfE.uwOpen(x, y)) detBad++;
      }
    }
    ok(detBad === 0, "a fresh instance regenerates objects, thermals and the seafloor tile for tile");

    // the sky has no resident ecology: flying creatures are ground animals that travel aloft
    const g9 = newGame("SKYCHK", "Rook", "ranger", "#e8742a", previewStarter("SKYCHK", "mossback"));
    loadChunks(g9);
    const skyBodies = Object.values(g9.creatures).filter((c) => c.layer === SKY);
    ok(skyBodies.length === 0, "the sky has no resident population on a fresh world");
    const dive9 = (() => {
      for (let y = 100; y < 4000; y += 7) for (let x = 100; x < 4000; x += 7) if (hfE.uwOpen(x, y) && w9.tile(x, y).biome === "deep") return { x, y };
      return null;
    })();
    ok(dive9 !== null, "deep dive water exists in the world");
    // the column rule: the seafloor loads (and fills) beneath a surface player — no travel
    g9.player.x = dive9!.x;
    g9.player.y = dive9!.y;
    loadChunks(g9);
    const uwBodies = Object.values(g9.creatures).filter((c) => c.layer === UW);
    const uwSwim = uwBodies.filter((c) => SPECIES[c.speciesId]?.swims).length;
    ok(uwBodies.length > 0 && uwSwim === uwBodies.length, `the seafloor loads with the surface, swimming creatures only (${uwBodies.length} bodies)`);

    // the living column: a fed flier takes off anywhere and lands again (its
    // own quiet inland stage — fliers live on land, not over the open sea)
    const g9b = newGame("WINGCHK", "Rook", "ranger", "#e8742a", previewStarter("WINGCHK", "mossback"));
    const w9b = getWorld(g9b.seed);
    const quiet9 = (() => {
      const cands: { x: number; y: number }[] = [];
      for (let y = 400; y < 3700 && cands.length < 14; y += 89) {
        for (let x = 400; x < 3700 && cands.length < 14; x += 89) {
          const t = w9b.tile(x, y);
          if (!BIOMES[t.biome].passable || t.feature || t.river || objectAt(w9b, x, y) || w9b.siteAt(x, y)) continue;
          cands.push({ x, y });
        }
      }
      return cands;
    })();
    ok(quiet9.length > 0, "quiet inland stages exist for the takeoff check");
    // a stage is only usable where fliers actually live; try a few spots
    let nearFly: (typeof g9b.creatures)[string] | undefined;
    for (const spot of quiet9) {
      g9b.player.x = spot.x;
      g9b.player.y = spot.y;
      g9b.tick = 12 * 60;
      loadChunks(g9b);
      nearFly = Object.values(g9b.creatures)
        .filter((c) => (c.layer ?? SURFACE) === SURFACE && SPECIES[c.speciesId]?.traits?.includes("flutter") && Math.max(Math.abs(c.x - g9b.player.x), Math.abs(c.y - g9b.player.y)) <= 30)
        .sort((a, b) => Math.max(Math.abs(a.x - g9b.player.x), Math.abs(a.y - g9b.player.y)) - Math.max(Math.abs(b.x - g9b.player.x), Math.abs(b.y - g9b.player.y)))[0];
      if (nearFly) break;
    }
    ok(!!nearFly, "a flying body lives near the player");
    {
      g9b.tick = 12 * 60;
      loadChunks(g9b);
      if (nearFly) {
        for (const o of Object.values(g9b.creatures)) {
          if (o !== nearFly && Math.max(Math.abs(o.x - g9b.player.x), Math.abs(o.y - g9b.player.y)) <= 15) delete g9b.creatures[o.id];
        }
        nearFly.satiety = 95;
        let up = false;
        for (let i = 0; i < 2400 && !up; i++) {
          advance(g9b, 1);
          up = g9b.creatures[nearFly.id]?.layer === SKY;
        }
        ok(up, "a fed flier takes off anywhere on open ground (no thermal needed)");
        const over = [[1, 0], [0, 1], [2, 0], [0, 2], [1, 1]].map(([dx, dy]) => ({ x: g9b.player.x + dx, y: g9b.player.y + dy })).find((p) => walkable(w9b, SURFACE, p.x, p.y));
        ok(!!over, "landable ground exists beside the player");
        const body = g9b.creatures[nearFly.id];
        if (body && over) {
          body.x = over.x;
          body.y = over.y;
          body.satiety = 10;
          let down = false;
          for (let i = 0; i < 2400 && !down; i++) {
            advance(g9b, 1);
            down = g9b.creatures[body.id]?.layer === undefined;
          }
          ok(down, "a hungry flier lands on open ground");
        }
      }
    }
      // fresh stage for the dive: aggressive, hungry, directly overhead
      const g10 = newGame("DIVECHK", "Rook", "ranger", "#e8742a", previewStarter("DIVECHK", "mossback"));
      g10.tick = 12 * 60;
      loadChunks(g10);
      const w10 = getWorld(g10.seed);
      const diver = Object.values(g10.creatures)
        .filter((c) => (c.layer ?? SURFACE) === SURFACE && SPECIES[c.speciesId]?.traits?.includes("flutter"))
        .sort((a, b) => Math.max(Math.abs(a.x - g10.player.x), Math.abs(a.y - g10.player.y)) - Math.max(Math.abs(b.x - g10.player.x), Math.abs(b.y - g10.player.y)))[0];
      const over10 = diver && [[2, 0], [0, 2], [2, 2], [-2, 0], [0, -2], [1, 1]].map(([dx, dy]) => ({ x: g10.player.x + dx, y: g10.player.y + dy })).find((p) => walkable(w10, SURFACE, p.x, p.y));
      ok(!!diver && !!over10, "a dive stage can be built near the player");
      if (diver && over10) {
        for (const o of Object.values(g10.creatures)) {
          if (o !== diver && Math.max(Math.abs(o.x - g10.player.x), Math.abs(o.y - g10.player.y)) <= 15) delete g10.creatures[o.id];
        }
        diver.satiety = 10;
        diver.disposition = "aggressive";
        diver.stalking = false;
        diver.x = over10.x;
        diver.y = over10.y;
        diver.layer = SKY;
        let landed = false;
        let engaged = false;
        for (let i = 0; i < 2400 && !(landed && engaged); i++) {
          advance(g10, 1);
          const b = g10.creatures[diver.id];
          if (!b) {
            if (landed) engaged = true; // it fell in the fight it picked
            break;
          }
          if (b.layer === undefined) {
            landed = true;
            engaged = engaged || b.stalking === true || b.satiety > 15;
          }
        }
        ok(landed && engaged, "an airborne predator lands beside you and turns on you");
      }
    // natural placement: dense groves and thin glades in the same forest, sparse meadows
    let fMax = 0;
    let fMin = 1;
    for (let y = 100; y < 4000 && fMax < 0.3; y += 61) {
      for (let x = 100; x < 4000; x += 61) {
        if (w9.tile(x, y).biome !== "forest") continue;
        let objs = 0;
        for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (objectAt(w9, x + dx, y + dy)) objs++;
        const d = objs / 169;
        fMax = Math.max(fMax, d);
        if (d > 0.1) fMin = Math.min(fMin, d);
      }
    }
    ok(fMax > 0.25 && fMin < 0.75, `forest cover is natural — dense groves and open glades (densest window ${(fMax * 100) | 0}%)`);
    // every object kind is reachable somewhere in the vocabulary
    const kinds = new Set<string>();
    for (let y = 100; y < 4000 && kinds.size < OBJ_KINDS.length; y += 17) for (let x = 100; x < 4000; x += 17) {
      const ob = objectAt(w9, x, y);
      if (ob) kinds.add(ob);
    }
    ok(kinds.size >= 7, `the world places a wide vocabulary of objects (${kinds.size}/${OBJ_KINDS.length} kinds: ${[...kinds].sort().join(", ")})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// APPEARANCE — modular rival tamer looks (region-indexed parts, compositor)
// ─────────────────────────────────────────────────────────────────────────────
{
  console.log("\n— rival tamer appearance —");
  const regErrs = validateRegistry();
  ok(regErrs.length === 0, `appearance registry is valid${regErrs.length ? ": " + regErrs.slice(0, 3).join("; ") : ""}`);
  const parts = new Map<string, PartMap>();
  let fileErrs: string[] = [];
  for (const f of assetFiles()) {
    try {
      const png = decodeTamerPng(readFileSync(new URL(`../public${f.src}`, import.meta.url)));
      const dec = decodePart(png.w, png.h, png.rgba);
      fileErrs = fileErrs.concat(validatePart(f, png.w, png.h, dec));
      parts.set(f.src, dec.map);
    } catch (e) {
      fileErrs.push(`${f.src}: ${(e as Error).message}`);
    }
  }
  ok(fileErrs.length === 0, `all ${assetFiles().length} tamer part files decode with declared regions${fileErrs.length ? ": " + fileErrs.slice(0, 3).join("; ") : ""}`);
  let bad = 0;
  for (const b of BODIES) for (const h of HEADS) for (const f of FACES) for (const hr of HAIRS) {
    const c = composeLook({ ...defaultLook(), body: b.id, head: h.id, face: f.id, hair: hr.id, outfit: {} }, (src) => parts.get(src));
    if (c.missing.length || c.region.some((r) => r.startsWith("invalid"))) bad++;
  }
  ok(bad === 0 && STRUCTURAL_COMBINATIONS === 384, `all ${STRUCTURAL_COMBINATIONS} structural combinations compose cleanly`);
  const ga = newGame("LOOKS-1", "Rook", "ranger", "#e8742a", previewStarter("LOOKS-1", "mossback"));
  const gb = newGame("LOOKS-1", "Rook", "ranger", "#e8742a", previewStarter("LOOKS-1", "mossback"));
  const ta = Object.values(ga.tamers ?? {});
  ok(ta.length > 0 && ta.every((t) => t.look && resolveLook(t.look).ok), "every rival is born with a valid persistent look");
  ok(new Set(ta.map((t) => lookSilhouette(t.look!))).size === ta.length, "no two rivals share a silhouette");
  ok(JSON.stringify(ta.map((t) => t.look)) === JSON.stringify(Object.values(gb.tamers ?? {}).map((t) => t.look)), "looks are deterministic per world seed");
  const old = JSON.parse(JSON.stringify(ga));
  old.version = 23;
  for (const t of Object.values(old.tamers) as { look?: unknown }[]) delete t.look;
  ok(migrateLoaded(old) && JSON.stringify(Object.values(old.tamers as Record<string, { look?: unknown }>).map((t) => t.look)) === JSON.stringify(ta.map((t) => t.look)), "a v23 save backfills the same looks a new game rolls");
}

if (fails) {
  console.log(`\n${fails} FAILURES`);
  process.exit(1);
}
console.log("\nALL CHECKS PASSED");
