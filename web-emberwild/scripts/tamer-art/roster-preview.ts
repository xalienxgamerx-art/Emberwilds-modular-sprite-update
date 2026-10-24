/** Dev preview: a world's 12-rival roster at in-game scale on grass. `bun scripts/tamer-art/roster-preview.ts [worldSeed]` → roster.png */
import { readFileSync, writeFileSync } from "node:fs";
import { decodePng, encodePng } from "./png";
import { composeLook, decodePart, ensureRosterLooks, type PartMap, type TamerLook } from "../../src/game/appearance";
const cache = new Map<string, PartMap>();
const get = (s: string) => { if (!cache.has(s)) { const p = decodePng(readFileSync(new URL(`../../public${s}`, import.meta.url))); cache.set(s, decodePart(p.w, p.h, p.rgba).map); } return cache.get(s)!; };
const ros: Record<string, { id: string; look?: TamerLook }> = {};
for (let i = 1; i <= 12; i++) ros[`t${i}`] = { id: `t${i}` };
ensureRosterLooks(Number(process.argv[2] ?? 4242), ros);
const K = 2, TS = Math.round(36 * 1.42) * K; // device px: dpr 2, drawn like a folk on the map
const W = 12 * TS, H = 2 * TS;
const out = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = ((x / 8 | 0) + (y / 8 | 0)) % 2 ? [92, 128, 64] : [98, 136, 68]; out.set([...c, 255], (y * W + x) * 4); }
Object.values(ros).forEach((t, n) => {
  const c = composeLook(t.look!, get);
  const ox = n * TS + (TS - c.w * K) / 2, oy = H - 10 - c.h * K;
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { const i = (y * c.w + x) * 4; if (!c.rgba[i + 3]) continue;
    for (let d = 0; d < K * K; d++) out.set([c.rgba[i], c.rgba[i + 1], c.rgba[i + 2], 255], ((oy + y * K + (d / K | 0)) * W + ox + x * K + (d % K)) * 4); }
});
writeFileSync(new URL("./roster.png", import.meta.url), encodePng(W, H, out));
console.log(Object.values(ros).map((t) => `${t.id}: ${t.look!.body} ${t.look!.head} ${t.look!.face} ${t.look!.hair} ${t.look!.skin}/${t.look!.hairColor}`).join("\n"));
