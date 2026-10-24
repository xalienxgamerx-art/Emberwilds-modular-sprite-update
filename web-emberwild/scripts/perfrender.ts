/* Headless benchmark for render-path queries — the pure game functions the
 * canvas renderers and React panels call on every store change.
 *
 *   bun scripts/perfrender.ts
 */
import { newGame, loadChunks, previewStarter } from "../src/game/sim";
import { computeVisibleFrom, perceptionSources, seesCreature } from "../src/game/perception";
import { getWorld, findPath, timeOf } from "../src/game/world";
import { sampleCell } from "../src/game/mapview";
import { roadNetworkOf, mapRoadLines, roadAt } from "../src/game/roads";
import { getFactions } from "../src/game/factions";
import { engagedNear } from "../src/game/combat";
import { contextActions } from "../src/game/sim";
import { performance } from "node:perf_hooks";

const SEED = "PERF-1";

function bench(label: string, n: number, fn: () => void): void {
  fn(); // warm
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  const dt = performance.now() - t0;
  console.log(`${label.padEnd(46)} ${(dt / n).toFixed(3)}ms/call  (${(n / (dt / 1000)).toFixed(0)}/s)`);
}

const gs = newGame(SEED, "Perf", "ranger", "#e8742a", previewStarter(SEED, "mossback"));
const world = getWorld(gs.seed);
gs.player.x = 2048;
gs.player.y = 2048;
loadChunks(gs);

const sources = perceptionSources(gs);
console.log(`sources=${sources.length} player=(${gs.player.x},${gs.player.y}) bodies=${Object.keys(gs.creatures).length}`);

bench("perceptionSources", 1000, () => {
  perceptionSources(gs);
});
bench("computeVisibleFrom (local, day)", 200, () => {
  computeVisibleFrom(gs, sources);
});
bench("sightRadius", 5000, () => {
  const s = perceptionSources(gs);
});
bench("world.weather", 5000, () => {
  world.weather(gs.player.x, gs.player.y, gs.tick);
});
bench("timeOf", 200000, () => {
  timeOf(gs.tick);
});
bench("roadNetworkOf (warm)", 200, () => {
  roadNetworkOf(world);
});
bench("mapRoadLines", 50, () => {
  mapRoadLines(roadNetworkOf(world), 4);
});
bench("sampleCell region x200", 200, () => {
  for (let i = 0; i < 200; i++) sampleCell("region", world, 2040 + (i % 20), 2040 + ((i / 20) | 0));
});
bench("roadAt x200", 2000, () => {
  for (let i = 0; i < 200; i++) roadAt(world, 2040 + (i % 20), 2040 + ((i / 20) | 0));
});
bench("findPath 40 tiles", 20, () => {
  findPath(world, gs.player.x, gs.player.y, gs.player.x + 30, gs.player.y + 26, 6000, 0);
});
bench("engagedNear + contextActions", 500, () => {
  engagedNear(gs);
  contextActions(gs);
});
bench("npcAt", 500, () => {
  world.npcAt(gs.player.x + 2, gs.player.y, gs.tick);
});
bench("roadTravelers", 200, () => {
  world.roadTravelers(gs.tick);
});
bench("featuresNear r40", 500, () => {
  world.featuresNear(gs.player.x, gs.player.y, 40);
});
bench("seesCreature x all bodies", 50, () => {
  let n = 0;
  for (const id in gs.creatures) {
    if (seesCreature(gs, gs.creatures[id])) n++;
  }
});
