/** One-off: measure the mannequin face oval in every hair raw (chin, cx, cheek span). */
import { readdirSync, readFileSync } from "node:fs";
import { decodePng } from "./png";
import { hexToRgb, type Rgb } from "../../src/game/appearance";

const SKIN_KEY = hexToRgb("#c8956c");
const dist = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

for (const f of readdirSync(new URL("./raw/", import.meta.url)).filter((n) => n.endsWith("_front.png")).sort()) {
  const im = decodePng(new Uint8Array(readFileSync(new URL(`./raw/${f}`, import.meta.url))));
  // adaptive skin key: median of everything near the reference tone
  const near: Rgb[] = [];
  for (let i = 0; i < im.w * im.h; i++) {
    const o = i * 4;
    if (im.rgba[o + 3] < 100) continue;
    const px: Rgb = [im.rgba[o], im.rgba[o + 1], im.rgba[o + 2]];
    if (dist(px, SKIN_KEY) < 80) near.push(px);
  }
  near.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const key = near[Math.floor(near.length / 2)];
  const skin = new Array(im.w * im.h).fill(false);
  for (let i = 0; i < im.w * im.h; i++) {
    const o = i * 4;
    if (im.rgba[o + 3] < 100) continue;
    if (dist([im.rgba[o], im.rgba[o + 1], im.rgba[o + 2]], key) < 50) skin[i] = true;
  }
  // largest connected component = the mannequin's face (kills stray warm strands)
  const comp = new Array(im.w * im.h).fill(-1);
  let best = -1, bestN = 0, nc = 0;
  for (let s = 0; s < im.w * im.h; s++) {
    if (!skin[s] || comp[s] >= 0) continue;
    const q = [s];
    comp[s] = nc;
    let n = 0;
    while (q.length) {
      const p = q.pop()!;
      n++;
      const px = p % im.w, py = (p / im.w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= im.w || ny >= im.h) continue;
        const j = ny * im.w + nx;
        if (skin[j] && comp[j] < 0) { comp[j] = nc; q.push(j); }
      }
    }
    if (n > bestN) { bestN = n; best = nc; }
    nc++;
  }
  const rows: { y: number; min: number; max: number }[] = [];
  for (let y = 0; y < im.h; y++) {
    let min = Infinity, max = -Infinity, n = 0;
    for (let x = 0; x < im.w; x++) {
      if (comp[y * im.w + x] !== best) continue;
      n++;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    if (n > 0) rows.push({ y, min, max });
  }
  const maxW = Math.max(...rows.map((r) => r.max - r.min));
  const face = rows.filter((r) => r.max - r.min >= maxW * 0.35);
  const chin = face[face.length - 1].y;
  const top = face[0].y;
  const h = chin - top;
  const band = face.filter((r) => r.y >= top + h * 0.35 && r.y <= top + h * 0.75);
  const cheekL = Math.min(...band.map((r) => r.min));
  const cheekR = Math.max(...band.map((r) => r.max));
  console.log(`${f.replace("_front.png", "")}: cx=${Math.round((cheekL + cheekR) / 2)} chin=${chin} cheekL=${cheekL} cheekR=${cheekR} span=${cheekR - cheekL} faceTop=${top}`);
}
