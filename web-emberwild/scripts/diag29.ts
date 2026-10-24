import { advance, loadChunks, newGame, previewStarter } from "../src/game/sim";
import { SPECIES } from "../src/game/data";
import { SURFACE, walkable } from "../src/game/height";
import { getWorld } from "../src/game/world";
const gs = newGame("DIVE-1", "Rook", "ranger", "#e8742a", previewStarter("DIVE-1", "mossback"));
gs.tick = 12 * 60;
loadChunks(gs);
const w = getWorld(gs.seed);
const fliers = Object.values(gs.creatures).filter((c) => (c.layer ?? 0) === 0 && SPECIES[c.speciesId].traits.includes("flutter"));
const f = fliers.sort((a, b) => Math.max(Math.abs(a.x - gs.player.x), Math.abs(a.y - gs.player.y)) - Math.max(Math.abs(b.x - gs.player.x), Math.abs(b.y - gs.player.y)))[0];
const over = [[2, 0], [0, 2], [2, 2], [-2, 0], [0, -2], [1, 1]].map(([dx, dy]) => ({ x: gs.player.x + dx, y: gs.player.y + dy })).find((p) => walkable(w, SURFACE, p.x, p.y));
f.satiety = 10;
f.disposition = "aggressive";
f.stalking = false;
f.x = over!.x;
f.y = over!.y;
f.layer = 1;
const keys0 = new Set(Object.keys(gs.creatures));
for (let i = 1; i <= 6; i++) {
  advance(gs, 1);
  const keys = new Set(Object.keys(gs.creatures));
  const lost = [...keys0].filter((k) => !keys.has(k));
  console.log("t", i, "lost:", lost.length, lost.slice(0, 4));
  console.log("  log:", gs.log.slice(-3).map((l: any) => l.text).join(" | "));
  if (lost.length) break;
}
