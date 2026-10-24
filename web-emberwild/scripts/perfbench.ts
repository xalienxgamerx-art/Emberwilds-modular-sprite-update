/* Headless performance harness for the simulation.
 *
 *   bun scripts/perfbench.ts bench [ticks]   — wall-clock ms per advance()
 *   bun scripts/perfbench.ts hash [ticks]    — deterministic state checksum
 *
 * The checksum mode exists so a performance change can prove it is lossless:
 * same seed → same checksum before and after the optimization.
 */
import { advance, loadChunks, newGame, previewStarter } from "../src/game/sim";
import { WORLD_SIZE } from "../src/game/data";
import { getWorld } from "../src/game/world";
import { BIOMES } from "../src/game/data";
import { objectAt } from "../src/game/objects";
import { performance } from "node:perf_hooks";

const SEED = "PERF-1";
const TICKS = process.argv[3] ? Number(process.argv[3]) : 600;

function freshGame() {
  const gs = newGame(SEED, "Perf", "ranger", "#e8742a", previewStarter(SEED, "mossback"));
  const world = getWorld(gs.seed);
  // park the player in open inland country so a realistic ecology loads
  outer: for (let y = 600; y < WORLD_SIZE; y += 3) {
    for (let x = 600; x < WORLD_SIZE; x += 3) {
      const t = world.tile(x, y);
      if (!BIOMES[t.biome].passable || t.feature || t.river || objectAt(world, x, y)) continue;
      gs.player.x = x;
      gs.player.y = y;
      break outer;
    }
  }
  loadChunks(gs);
  return gs;
}

/** Stable FNV-1a over the sim-visible state — any behavioral drift shows up here. */
function checksum(gs: ReturnType<typeof newGame>): string {
  let h = 0x811c9dc5;
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  feed(`tick:${gs.tick}`);
  feed(`player:${gs.player.x},${gs.player.y}`);
  for (const id of Object.keys(gs.creatures).sort()) {
    const c = gs.creatures[id];
    feed(`${id}:${c.speciesId}:${c.x},${c.y}:${c.layer ?? "g"}:${c.satiety.toFixed(3)}:${c.hpFrac.toFixed(4)}:${c.activity}:${c.alpha ? 1 : 0}:${c.stalking ? 1 : 0}`);
  }
  feed(`nests:${Object.keys(gs.nests).length}`);
  feed(`territories:${Object.keys(gs.territories).length}`);
  feed(`carrion:${Object.keys(gs.carrion ?? {}).length}`);
  feed(`bodies:${Object.keys(gs.creatures).length}`);
  return h.toString(16);
}

const mode = process.argv[2] ?? "bench";
const gs = freshGame();
if (mode === "hash") {
  advance(gs, TICKS, false);
  console.log(checksum(gs));
} else if (mode === "profile") {
  // node-only: profile JUST the steady-state advance loop (setup excluded)
  const inspector = await import("node:inspector");
  const fs = await import("node:fs");
  advance(gs, 120, false);
  const session = new inspector.Session();
  session.connect();
  const post = <T>(m: string, p: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r as T))));
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 200 });
  await post("Profiler.start");
  const t0 = performance.now();
  advance(gs, TICKS, false);
  const dt = performance.now() - t0;
  const { profile } = await post<{ profile: object }>("Profiler.stop");
  fs.writeFileSync("/tmp/sim.cpuprofile", JSON.stringify(profile));
  console.log(`advanced ${TICKS} ticks in ${dt.toFixed(1)}ms — ${(dt / TICKS).toFixed(3)}ms/tick, bodies=${Object.keys(gs.creatures).length}`);
} else {
  // warm caches once, then measure steady state
  advance(gs, 60, false);
  const t0 = performance.now();
  advance(gs, TICKS, false);
  const dt = performance.now() - t0;
  console.log(`advanced ${TICKS} ticks in ${dt.toFixed(1)}ms — ${(dt / TICKS).toFixed(3)}ms/tick, bodies=${Object.keys(gs.creatures).length}`);
}
