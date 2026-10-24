/** Dev preview: looks at character-creation scale (like the big panel preview). `bun scripts/tamer-art/player-preview.ts` → player_preview.png */
import { readFileSync, writeFileSync } from "node:fs";
import { decodePng, encodePng } from "./png";
import { composeLook, decodePart, defaultLook, type PartMap, type TamerLook } from "../../src/game/appearance";

const cache = new Map<string, PartMap>();
const get = (s: string) => {
  if (!cache.has(s)) {
    const p = decodePng(readFileSync(new URL(`../../public${s}`, import.meta.url)));
    cache.set(s, decodePart(p.w, p.h, p.rgba).map);
  }
  return cache.get(s)!;
};

// the user's complaint look plus each hair style, dark skin + blonde to stress contrast
const looks: TamerLook[] = (
  [
    ["braid", "ebony", "strawberry"],
    ["braid", "umber", "gold"],
    ["mane", "ebony", "gold"],
    ["bob", "umber", "white"],
    ["shag", "umber", "copper"],
    ["tousled", "ebony", "auburn"],
    ["crop", "umber", "ash"],
    ["braid", "porcelain", "ink"],
  ] as const
).map(([hair, skin, hairColor]) => ({ ...defaultLook(), hair: `hair.${hair}`, skin, hairColor, outfit: {} }));

const K = 6;
const W = looks.length * 64 * K, H = 96 * K;
const out = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const c = ((x / 16 | 0) + (y / 16 | 0)) % 2 ? [38, 32, 48] : [43, 37, 54];
    out.set([...c, 255], (y * W + x) * 4);
  }
looks.forEach((look, n) => {
  const c = composeLook(look, get);
  const ox = n * 64 * K + (64 * K - c.w * K) / 2, oy = H - c.h * K;
  for (let y = 0; y < c.h; y++)
    for (let x = 0; x < c.w; x++) {
      const i = (y * c.w + x) * 4;
      if (!c.rgba[i + 3]) continue;
      for (let d = 0; d < K * K; d++)
        out.set([c.rgba[i], c.rgba[i + 1], c.rgba[i + 2], 255], ((oy + y * K + (d / K | 0)) * W + ox + x * K + (d % K)) * 4);
    }
});
writeFileSync(new URL("./player_preview.png", import.meta.url), encodePng(W, H, out));
console.log(looks.map((l) => `${l.hair} ${l.skin}/${l.hairColor}`).join("\n"));
