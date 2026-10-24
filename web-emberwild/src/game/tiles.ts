import { rngNext } from "./rng";
import type { BiomeId, FeatureId, ItemId, Terrain } from "./types";
import type { RoadClass } from "./roads";

/** Procedural 16×16 pixel-art textures for biomes, features and battle terrain. */
const PX = 16;
const cache = new Map<string, HTMLCanvasElement>();

type Ctx = CanvasRenderingContext2D;
type R = () => number;

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number): number => Math.min(255, Math.max(0, Math.round(v * k)));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

const px = (ctx: Ctx, x: number, y: number, col: string): void => {
  if (x < 0 || y < 0 || x >= PX || y >= PX) return;
  ctx.fillStyle = col;
  ctx.fillRect(x, y, 1, 1);
};

function make(key: string, seed: number, paint: (ctx: Ctx, r: R) => void): HTMLCanvasElement {
  const c = cache.get(key);
  if (c) return c;
  const cv = document.createElement("canvas");
  cv.width = PX;
  cv.height = PX;
  const ctx = cv.getContext("2d") as Ctx;
  let s = seed;
  const r: R = () => {
    const [v, n] = rngNext(s);
    s = n;
    return v;
  };
  paint(ctx, r);
  cache.set(key, cv);
  return cv;
}

function base(ctx: Ctx, r: R, col: string, spread = 0.07): void {
  const a = shade(col, 1 - spread);
  const b = shade(col, 1 + spread * 0.8);
  ctx.fillStyle = col;
  ctx.fillRect(0, 0, PX, PX);
  for (let y = 0; y < PX; y++) {
    for (let x = 0; x < PX; x++) {
      const v = r();
      if (v < 0.16) px(ctx, x, y, a);
      else if (v > 0.88) px(ctx, x, y, b);
    }
  }
}

function tufts(ctx: Ctx, r: R, col: string, n: number, tall = false): void {
  const d = shade(col, 0.72);
  const l = shade(col, 1.18);
  for (let i = 0; i < n; i++) {
    const x = 1 + Math.floor(r() * 14);
    const y = 2 + Math.floor(r() * 13);
    px(ctx, x, y, d);
    px(ctx, x - 1, y - 1, d);
    px(ctx, x + 1, y - 1, d);
    if (tall) {
      px(ctx, x, y - 1, l);
      px(ctx, x - 1, y - 2, l);
      px(ctx, x + 1, y - 2, d);
    }
  }
}

function flowers(ctx: Ctx, r: R, n: number): void {
  const cols = ["#f2c14e", "#e05a8a", "#fff4dc", "#9fd3e6"];
  for (let i = 0; i < n; i++) {
    const x = 1 + Math.floor(r() * 14);
    const y = 1 + Math.floor(r() * 14);
    px(ctx, x, y, cols[Math.floor(r() * cols.length)]);
  }
}

function oak(ctx: Ctx, r: R, cx: number, cy: number, leaf: string): void {
  const trunk = "#5a3b22";
  for (let y = cy + 3; y <= cy + 6; y++) {
    px(ctx, cx, y, trunk);
    px(ctx, cx + 1, y, shade(trunk, 0.8));
  }
  const rad = 4.6 + r() * 0.6;
  for (let y = -5; y <= 4; y++) {
    for (let x = -5; x <= 5; x++) {
      const d = Math.hypot(x, y * 1.08);
      if (d > rad + (r() - 0.5) * 0.8) continue;
      const lit = x + y < -2 ? 1.25 : x + y > 3 ? 0.72 : 1;
      px(ctx, cx + x, cy + y, shade(leaf, lit * (r() < 0.15 ? 0.88 : 1)));
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = r() * Math.PI * 2;
    px(ctx, Math.round(cx + Math.cos(a) * (rad + 0.4)), Math.round(cy + Math.sin(a) * (rad + 0.4)), "#1d2e1a");
  }
  ctx.fillStyle = "rgba(10,20,10,0.25)";
  ctx.fillRect(cx - 3, cy + 6, 7, 1);
}

function pine(ctx: Ctx, r: R, cx: number, top: number, leaf: string, snowy = false): void {
  const trunk = "#4a3020";
  px(ctx, cx, top + 11, trunk);
  px(ctx, cx, top + 12, trunk);
  for (let y = 0; y < 11; y++) {
    const w = Math.floor((y % 4) + y / 3);
    for (let x = -w; x <= w; x++) {
      const lit = x < 0 ? 1.18 : x > 0 ? 0.78 : 1;
      px(ctx, cx + x, top + y, shade(leaf, lit));
    }
    if (snowy && y % 4 === 0 && y > 0) {
      for (let x = -w; x <= 0; x++) px(ctx, cx + x, top + y, "#eef4f6");
    }
  }
  if (snowy) px(ctx, cx, top, "#ffffff");
  void r;
}

function treeDot(ctx: Ctx, cx: number, cy: number, dark: string, lit: string): void {
  px(ctx, cx, cy, dark);
  px(ctx, cx + 1, cy, dark);
  px(ctx, cx - 1, cy, dark);
  px(ctx, cx, cy - 1, lit);
  px(ctx, cx, cy + 1, dark);
}

function ridge(ctx: Ctx, cx: number, by: number, w: number, h: number, col: string, cap: string | null): void {
  for (let y = 0; y < h; y++) {
    const half = Math.round(((y + 1) / h) * w);
    for (let x = -half; x <= half; x++) px(ctx, cx + x, by - y, x < 0 ? shade(col, 1.2) : shade(col, 0.78));
  }
  if (cap) {
    px(ctx, cx, by - h, cap);
    px(ctx, cx - 1, by - h + 1, cap);
    px(ctx, cx, by - h + 1, shade(cap, 0.88));
  }
}

function stoneFloor(ctx: Ctx, r: R): void {
  base(ctx, r, "#9b948a", 0.05);
  const line = "#7e786d";
  for (let y = 0; y < PX; y++) if (y % 5 === 4) for (let x = 0; x < PX; x++) px(ctx, x, y, line);
  for (let row = 0; row < 3; row++) {
    const off = row % 2 ? 2 : 5;
    for (let x = off; x < PX; x += 6) for (let y = row * 5; y < row * 5 + 4; y++) px(ctx, x, y, line);
  }
  px(ctx, 3 + Math.floor(r() * 10), 3 + Math.floor(r() * 10), "#b3ada1");
}

function planks(ctx: Ctx, r: R, baseCol: string, gapCol: string): void {
  base(ctx, r, baseCol, 0.07);
  for (let x = 1; x < PX; x += 4) for (let y = 0; y < PX; y++) px(ctx, x, y, gapCol);
  for (let i = 0; i < 4; i++) px(ctx, Math.floor(r() * 15), Math.floor(r() * 16), shade(baseCol, 0.8));
}

function deadTree(ctx: Ctx, r: R, cx: number): void {
  const c = "#1f1629";
  for (let y = 4; y < 15; y++) px(ctx, cx + (y < 8 ? Math.round(Math.sin(y) * 0.8) : 0), y, c);
  for (let i = 0; i < 4; i++) {
    const y = 4 + i * 2;
    const dir = i % 2 ? 1 : -1;
    for (let k = 1; k < 4; k++) px(ctx, cx + dir * k, y - Math.floor(k / 2), c);
  }
  if (r() < 0.8) {
    px(ctx, cx + 3, 13, "#c58cf0");
    px(ctx, cx + 3, 12, "#e2c2ff");
    px(ctx, cx - 4, 14, "#c58cf0");
  }
}

function waves(ctx: Ctx, r: R, col: string, n: number): void {
  const l = shade(col, 1.3);
  for (let i = 0; i < n; i++) {
    const x = Math.floor(r() * 13);
    const y = 1 + Math.floor(r() * 14);
    px(ctx, x, y, l);
    px(ctx, x + 1, y - 1, l);
    px(ctx, x + 2, y, l);
  }
}

function rock(ctx: Ctx, cx: number, cy: number, col: string, size = 3): void {
  for (let y = -size; y <= size - 1; y++) {
    for (let x = -size - 1; x <= size + 1; x++) {
      if (Math.hypot(x / 1.3, y) > size) continue;
      const lit = y < -1 ? 1.25 : y > 0 ? 0.75 : 1;
      px(ctx, cx + x, cy + y, shade(col, x < 0 ? lit * 1.05 : lit * 0.92));
    }
  }
  for (let x = -size - 1; x <= size + 1; x++) px(ctx, cx + x, cy + size, "rgba(0,0,0,0.25)");
}

function mountain(ctx: Ctx, col: string, cap: string | null, h = 12): void {
  const top = PX - h - 2;
  for (let y = 0; y < h; y++) {
    const w = Math.floor((y + 1) * 0.72);
    for (let x = -w; x <= w; x++) {
      const c = x < 0 ? shade(col, 1.15) : shade(col, 0.78);
      px(ctx, 8 + x, top + y, cap && y < h * 0.36 ? (x < 0 ? cap : shade(cap, 0.85)) : c);
    }
  }
  px(ctx, 8, top - 1, cap ?? shade(col, 1.2));
}

const BIOME_PAINT: Record<BiomeId, (ctx: Ctx, r: R, v: number) => void> = {
  deep: (ctx, r) => {
    base(ctx, r, "#1d3a63", 0.05);
    waves(ctx, r, "#1d3a63", 2);
  },
  sea: (ctx, r) => {
    base(ctx, r, "#2f6aa0", 0.05);
    waves(ctx, r, "#2f6aa0", 3);
  },
  lake: (ctx, r) => {
    base(ctx, r, "#3a7fb5", 0.04);
    waves(ctx, r, "#3a7fb5", 2);
  },
  river: (ctx, r) => {
    base(ctx, r, "#4c93c9", 0.05);
    waves(ctx, r, "#4c93c9", 4);
    if (r() < 0.5) px(ctx, Math.floor(r() * 16), Math.floor(r() * 16), "#e8f6ff");
  },
  beach: (ctx, r) => {
    base(ctx, r, "#e3cf8f", 0.06);
    if (r() < 0.5) px(ctx, Math.floor(r() * 14) + 1, Math.floor(r() * 14) + 1, "#f6ece0");
    if (r() < 0.3) px(ctx, Math.floor(r() * 14) + 1, Math.floor(r() * 14) + 1, "#c97b5a");
  },
  meadow: (ctx, r, v) => {
    base(ctx, r, "#7fb34a");
    tufts(ctx, r, "#7fb34a", 5);
    if (v < 2) flowers(ctx, r, 3 + v * 2);
  },
  forest: (ctx, r, v) => {
    base(ctx, r, "#4f8a3c");
    tufts(ctx, r, "#4f8a3c", 3);
    oak(ctx, r, 7 + (v % 2), 6, v === 3 ? "#3f7d2e" : "#2f6b2e");
  },
  taiga: (ctx, r, v) => {
    base(ctx, r, "#3f6b4a");
    if (v % 2) px(ctx, Math.floor(r() * 16), Math.floor(r() * 16), "#dfe8e4");
    pine(ctx, r, 7 + (v % 3), 2, "#24503a", v === 0);
  },
  gloomwood: (ctx, r) => {
    base(ctx, r, "#3b2f4f", 0.09);
    for (let i = 0; i < 3; i++) px(ctx, Math.floor(r() * 16), Math.floor(r() * 16), "#5d4a7a");
    deadTree(ctx, r, 6 + Math.floor(r() * 4));
  },
  marsh: (ctx, r) => {
    base(ctx, r, "#5d7a4a", 0.08);
    const x = 2 + Math.floor(r() * 9);
    const y = 4 + Math.floor(r() * 8);
    for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 2; dy++) px(ctx, x + dx, y + dy, "#3a6b6a");
    px(ctx, x + 1, y, "#6aa0a0");
    for (let i = 0; i < 3; i++) {
      const rx = Math.floor(r() * 15);
      const ry = 6 + Math.floor(r() * 8);
      px(ctx, rx, ry, "#8a9a4a");
      px(ctx, rx, ry - 1, "#8a9a4a");
      px(ctx, rx, ry - 2, "#7a4a2a");
    }
  },
  steppe: (ctx, r) => {
    base(ctx, r, "#b7a95a");
    tufts(ctx, r, "#b7a95a", 6, true);
  },
  desert: (ctx, r, v) => {
    base(ctx, r, "#d9b46a", 0.05);
    const d = shade("#d9b46a", 0.86);
    for (let i = 0; i < 2; i++) {
      const y = 3 + Math.floor(r() * 10);
      const x0 = Math.floor(r() * 6);
      for (let x = x0; x < x0 + 7; x++) px(ctx, x, y + Math.round(Math.sin(x * 0.8) * 0.6), d);
    }
    if (v === 0) {
      const c = "#4f8a3c";
      for (let y = 5; y < 14; y++) px(ctx, 8, y, c);
      for (let y = 7; y < 10; y++) px(ctx, 6, y, c);
      px(ctx, 7, 10, c);
      for (let y = 6; y < 9; y++) px(ctx, 10, y, c);
      px(ctx, 9, 9, c);
      px(ctx, 8, 4, "#e05a8a");
    }
  },
  tundra: (ctx, r) => {
    base(ctx, r, "#9fae9a", 0.08);
    for (let i = 0; i < 5; i++) px(ctx, Math.floor(r() * 16), Math.floor(r() * 16), "#6f8a6a");
    if (r() < 0.6) rock(ctx, 4 + Math.floor(r() * 8), 9 + Math.floor(r() * 4), "#8d8d8d", 1);
  },
  snow: (ctx, r) => {
    base(ctx, r, "#e7eef2", 0.04);
    for (let i = 0; i < 4; i++) {
      const x = Math.floor(r() * 14);
      const y = Math.floor(r() * 16);
      px(ctx, x, y, "#c7d6e2");
      px(ctx, x + 1, y, "#c7d6e2");
    }
  },
  hills: (ctx, r) => {
    base(ctx, r, "#8f9b55");
    const cx = 5 + Math.floor(r() * 6);
    for (let x = -6; x <= 6; x++) {
      const h = Math.round(Math.sqrt(36 - x * x) * 0.6);
      for (let y = 0; y < h; y++) px(ctx, cx + x, 12 - y, shade("#8f9b55", y === h - 1 ? 1.25 : x > 2 ? 0.85 : 1.05));
    }
    tufts(ctx, r, "#8f9b55", 2);
  },
  mountain: (ctx, r, v) => {
    base(ctx, r, "#857a6e", 0.08);
    mountain(ctx, "#8c8079", v === 0 ? "#f0f0f0" : null, 12 + (v % 2));
  },
  peak: (ctx, r) => {
    base(ctx, r, "#a8a29c", 0.06);
    mountain(ctx, "#9a938c", "#f6f8fa", 14);
  },
};

export function biomeTex(biome: BiomeId, variant: number): HTMLCanvasElement {
  return make(`b:${biome}:${variant}`, 1000 + variant * 97 + biome.length * 13 + biome.charCodeAt(0), (ctx, r) => BIOME_PAINT[biome](ctx, r, variant));
}

export function featureTex(kind: FeatureId): HTMLCanvasElement {
  return make(`f:${kind}`, 42, (ctx, r) => {
    if (kind === "hamlet") {
      // Low ground marker: a plaza well with a pennant. The buildings are the
      // actual walls on the local map; this only marks remembered hamlets.
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(3, 14, 10, 1);
      for (let a = 0; a < 10; a++) {
        const ang = (a / 10) * Math.PI * 2;
        px(ctx, Math.round(8 + Math.cos(ang) * 3.2), Math.round(10 + Math.sin(ang) * 2.2), a % 2 ? "#9a948a" : "#6f6a60");
      }
      for (let y = 9; y <= 11; y++) for (let x = 7; x <= 9; x++) px(ctx, x, y, "#2e4a5a");
      px(ctx, 8, 10, "#4a7a8a");
      for (let y = 5; y <= 8; y++) { px(ctx, 4, y, "#6b4a2b"); px(ctx, 12, y, "#6b4a2b"); }
      for (let x = 4; x <= 12; x++) px(ctx, x, 5, "#7d5836");
      px(ctx, 8, 2, "#6b4a2b");
      px(ctx, 8, 3, "#6b4a2b");
      for (let x = 9; x <= 12; x++) px(ctx, x, 2 + (x > 10 ? 1 : 0), x > 10 ? "#8f2c38" : "#b23a48");
    } else if (kind === "town") {
      // Town marker: a cluster of rooftops around a walled hall with a banner
      // — the map reads it as clearly bigger than a hamlet's well.
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(2, 14, 12, 1);
      const roofs: [number, number][] = [[4, 9], [11, 9], [7, 12], [4, 12], [11, 12]];
      for (const [rx, ry] of roofs) {
        for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) px(ctx, rx + x, ry + y, "#8a6a45");
        px(ctx, rx + 1, ry - 1, "#6b4a2b");
      }
      // the chapter hall, center, stone with a banner
      for (let y = 7; y <= 11; y++) for (let x = 7; x <= 9; x++) px(ctx, x, y, "#9a948a");
      for (let x = 6; x <= 10; x++) px(ctx, x, 6, "#7d7a72");
      px(ctx, 8, 10, "#3a2c20");
      for (let y = 2; y <= 4; y++) { px(ctx, 8, y, "#6b4a2b"); }
      for (let y = 2; y <= 3; y++) px(ctx, 9, y, "#b23a48");
    } else if (kind === "city") {
      // City marker: a walled skyline around a tall keep — reads as the
      // region's great center, well above a town's rooftop cluster.
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(2, 15, 12, 1);
      // outer walls
      for (let x = 2; x <= 14; x++) { px(ctx, x, 13, "#8d877d"); px(ctx, x, 14, "#6f6a60"); }
      // city blocks: rooftops at two heights
      const blocks: [number, number, number][] = [[3, 10, 2], [7, 10, 2], [11, 10, 2], [4, 12, 1], [9, 12, 1]];
      for (const [bx, by, bh] of blocks) {
        for (let y = 0; y < bh + 2; y++) for (let x = 0; x < 3; x++) px(ctx, bx + x, by - y, x === 0 ? "#7a6f66" : "#9a948a");
        px(ctx, bx + 1, by - bh - 1, "#b23a48");
      }
      // the great keep at center
      for (let y = 4; y <= 9; y++) for (let x = 7; x <= 9; x++) px(ctx, x, y, y > 8 ? "#3a2c20" : "#a39d92");
      for (let x = 6; x <= 10; x++) px(ctx, x, 4, "#8d877d");
      for (let y = 1; y <= 3; y++) px(ctx, 8, y, "#6b4a2b");
      for (let y = 1; y <= 2; y++) px(ctx, 9, y, "#e8a02b");
    } else if (kind === "ruin") {
      const c = "#a39d92";
      for (let y = 4; y < 14; y++) {
        px(ctx, 3, y, c);
        px(ctx, 4, y, shade(c, 0.8));
      }
      for (let y = 7; y < 14; y++) {
        px(ctx, 11, y, c);
        px(ctx, 12, y, shade(c, 0.8));
      }
      for (let x = 3; x < 9; x++) px(ctx, x, 4 - (x > 5 ? 1 : 0), c);
      rock(ctx, 8, 13, "#8a857c", 1);
      for (let i = 0; i < 4; i++) px(ctx, Math.floor(r() * 16), 8 + Math.floor(r() * 7), "#4f8a3c");
    } else if (kind === "shrine") {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        px(ctx, Math.round(8 + Math.cos(a) * 6), Math.round(9 + Math.sin(a) * 5), "#7be08a");
      }
      for (let y = 8; y < 13; y++) for (let x = 5; x < 11; x++) px(ctx, x, y, x < 8 ? "#b5afa5" : "#8d877d");
      for (let x = 4; x < 12; x++) px(ctx, x, 8, "#d8d2c8");
      px(ctx, 7, 6, "#7be08a");
      px(ctx, 8, 5, "#c8ffd0");
      px(ctx, 8, 6, "#7be08a");
      px(ctx, 9, 6, "#7be08a");
      for (let y = 9; y < 14; y++) {
        px(ctx, 4 + (y % 2), y, "#6b4a2b");
        px(ctx, 11 - (y % 2), y, "#6b4a2b");
      }
    } else {
      for (let y = 0; y < 8; y++) {
        for (let x = -7; x <= 7; x++) {
          const d = Math.hypot(x, (7 - y) * 1.1);
          if (d < 7.5) px(ctx, 8 + x, 6 + y, d < 5 ? "#1a1420" : shade("#7a6f66", x < 0 ? 1.1 : 0.85));
        }
      }
      px(ctx, 4, 14, "#f6ece0");
      px(ctx, 5, 14, "#f6ece0");
      px(ctx, 12, 13, "#f6ece0");
      px(ctx, 6, 10, "#e8742a");
      px(ctx, 10, 10, "#e8742a");
    }
  });
}

export function terrainTex(t: Terrain, variant: number): HTMLCanvasElement {
  return make(`t:${t}:${variant}`, 500 + variant * 31 + t.charCodeAt(0) * 7 + t.length, (ctx, r) => {
    switch (t) {
      case "grass":
        base(ctx, r, "#6f9f45");
        tufts(ctx, r, "#6f9f45", 4);
        break;
      case "tallgrass":
        base(ctx, r, "#5f9a3f");
        tufts(ctx, r, "#5f9a3f", 11, true);
        break;
      case "flowers":
        base(ctx, r, "#76a84a");
        tufts(ctx, r, "#76a84a", 3);
        flowers(ctx, r, 8);
        break;
      case "water":
        BIOME_PAINT.river(ctx, r, variant);
        break;
      case "mud":
        base(ctx, r, "#6b5233", 0.1);
        for (let i = 0; i < 3; i++) px(ctx, Math.floor(r() * 16), Math.floor(r() * 16), "#4a6a6a");
        break;
      case "rock":
        base(ctx, r, "#6f9045");
        rock(ctx, 8, 9, "#8d877d", 5);
        break;
      case "tree":
        base(ctx, r, "#5a8a3c");
        oak(ctx, r, 8, 6, "#2f6b2e");
        break;
      case "sand":
        BIOME_PAINT.desert(ctx, r, 1);
        break;
      case "snow":
        BIOME_PAINT.snow(ctx, r, variant);
        break;
      case "ash":
        base(ctx, r, "#3d3633", 0.12);
        for (let i = 0; i < 3; i++) px(ctx, Math.floor(r() * 16), Math.floor(r() * 16), r() < 0.4 ? "#e8742a" : "#6a625c");
        break;
      case "gloom":
        base(ctx, r, "#3b2f4f", 0.12);
        for (let i = 0; i < 5; i++) px(ctx, Math.floor(r() * 16), Math.floor(r() * 16), "#6a5590");
        break;
      case "wall": {
        base(ctx, r, "#8d8779", 0.05);
        const mortar = "#67624f";
        for (let y = 3; y < PX; y += 4) for (let x = 0; x < PX; x++) px(ctx, x, y, mortar);
        for (let row = 0; row < 4; row++) {
          const off = row % 2 ? 2 : 5;
          for (let x = off; x < PX; x += 5) for (let y = row * 4; y < Math.min(PX, row * 4 + 3); y++) px(ctx, x, y, mortar);
        }
        for (let x = 0; x < PX; x++) if (x % 5 !== 0) px(ctx, x, 0, "#a8a296");
        px(ctx, Math.floor(r() * 14) + 1, 5 + Math.floor(r() * 9), "#5f5a4e");
        break;
      }
      case "woodwall": {
        planks(ctx, r, "#7d5c36", "#5c4023");
        for (let x = 0; x < PX; x++) {
          px(ctx, x, 1, "#96703f");
          px(ctx, x, 14, shade("#5c4023", 0.9));
        }
        break;
      }
      case "floor": {
        if (variant % 3 === 1) {
          base(ctx, r, "#8f7248", 0.09);
          for (let i = 0; i < 5; i++) {
            const x = Math.floor(r() * 15);
            const y = Math.floor(r() * 15);
            px(ctx, x, y, r() < 0.5 ? "#7a6238" : "#a08554");
          }
        } else if (variant % 3 === 2) {
          base(ctx, r, "#4a4354", 0.11);
          for (let i = 0; i < 4; i++) {
            const x = Math.floor(r() * 15);
            const y = Math.floor(r() * 15);
            px(ctx, x, y, "#3a3444");
            px(ctx, x + 1, y, "#3a3444");
          }
          if (r() < 0.5) {
            px(ctx, Math.floor(r() * 15), Math.floor(r() * 15), "#cfc8b8");
            px(ctx, Math.floor(r() * 15), Math.floor(r() * 15), "#b8b0a0");
          }
        } else stoneFloor(ctx, r);
        break;
      }
      case "door": {
        planks(ctx, r, "#84633c", "#63481f");
        for (let i = 0; i < PX; i++) {
          px(ctx, i, 0, "#4a3218");
          px(ctx, i, 15, "#4a3218");
          px(ctx, 0, i, "#4a3218");
          px(ctx, 15, i, "#4a3218");
        }
        px(ctx, 12, 8, "#f2c14e");
        px(ctx, 12, 7, "#c99a2e");
        break;
      }
      case "rubble": {
        stoneFloor(ctx, r);
        rock(ctx, 4, 5, "#8a857c", 2);
        rock(ctx, 11, 10, "#7f7a70", 2);
        rock(ctx, 9, 13, "#908b80", 1);
        for (let i = 0; i < 4; i++) px(ctx, Math.floor(r() * 16), Math.floor(r() * 16), "#5f5a4e");
        break;
      }
    }
  });
}

/** Painterly world-scale (one cell = 32 tiles) terrain for the WORLD zoom. */
const WORLD_PAINT: Record<BiomeId, (ctx: Ctx, r: R, v: number) => void> = {
  deep: (ctx, r) => {
    base(ctx, r, "#1a3557", 0.04);
    for (let i = 0; i < 2; i++) {
      const y = 3 + Math.floor(r() * 10);
      const x = Math.floor(r() * 10);
      px(ctx, x, y, "#22436b");
      px(ctx, x + 1, y, "#22436b");
      px(ctx, x + 2, y - 1, "#22436b");
    }
  },
  sea: (ctx, r) => {
    base(ctx, r, "#2f6aa0", 0.05);
    for (let i = 0; i < 3; i++) {
      const y = 2 + Math.floor(r() * 11);
      const x = Math.floor(r() * 10);
      px(ctx, x, y, "#4c88bd");
      px(ctx, x + 1, y, "#4c88bd");
      px(ctx, x + 2, y + 1, "#4c88bd");
    }
  },
  lake: (ctx, r) => {
    base(ctx, r, "#3a7fb5", 0.05);
    px(ctx, Math.floor(r() * 12), Math.floor(r() * 12), "#6aa8d4");
    px(ctx, Math.floor(r() * 12), Math.floor(r() * 12), "#6aa8d4");
  },
  river: (ctx, r) => {
    base(ctx, r, "#4c93c9", 0.05);
    px(ctx, Math.floor(r() * 12), Math.floor(r() * 12), "#a8d4ee");
  },
  beach: (ctx, r) => {
    base(ctx, r, "#e3cf8f", 0.05);
    for (let x = 2; x < 14; x += 3) px(ctx, x, 12 + (x % 2), "#f2ece0");
  },
  meadow: (ctx, r, v) => {
    base(ctx, r, "#7fb34a", 0.06);
    tufts(ctx, r, "#7fb34a", 4);
    if (v < 2) flowers(ctx, r, 2);
  },
  forest: (ctx, r) => {
    base(ctx, r, "#4a7d38", 0.06);
    for (let i = 0; i < 5; i++) {
      const x = 2 + Math.floor(r() * 12);
      const y = 2 + Math.floor(r() * 12);
      treeDot(ctx, x, y, "#2f5c28", "#699a4a");
    }
  },
  taiga: (ctx, r) => {
    base(ctx, r, "#46684e", 0.06);
    for (let i = 0; i < 4; i++) {
      const x = 2 + Math.floor(r() * 12);
      const y = 3 + Math.floor(r() * 11);
      px(ctx, x, y, "#2c4a38");
      px(ctx, x, y - 1, "#2c4a38");
      px(ctx, x, y - 2, r() < 0.4 ? "#dfe8e4" : "#3a5c44");
    }
  },
  gloomwood: (ctx, r) => {
    base(ctx, r, "#332a45", 0.08);
    for (let i = 0; i < 4; i++) {
      const x = 2 + Math.floor(r() * 12);
      const y = 2 + Math.floor(r() * 12);
      treeDot(ctx, x, y, "#241d33", "#5d4a7a");
    }
    if (r() < 0.3) px(ctx, Math.floor(r() * 14) + 1, Math.floor(r() * 14) + 1, "#c58cf0");
  },
  marsh: (ctx, r) => {
    base(ctx, r, "#5d7a4a", 0.08);
    for (let i = 0; i < 2; i++) {
      const x = 2 + Math.floor(r() * 11);
      const y = 2 + Math.floor(r() * 11);
      px(ctx, x, y, "#3a6b6a");
      px(ctx, x + 1, y, "#3a6b6a");
      px(ctx, x, y + 1, "#3a6b6a");
    }
    px(ctx, Math.floor(r() * 14) + 1, Math.floor(r() * 14) + 1, "#8a9a4a");
  },
  steppe: (ctx, r) => {
    base(ctx, r, "#b7a95a", 0.06);
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(r() * 15);
      const y = 3 + Math.floor(r() * 12);
      px(ctx, x, y, "#9a8c46");
      px(ctx, x, y - 1, "#cbbd76");
    }
  },
  desert: (ctx, r) => {
    base(ctx, r, "#d9b46a", 0.05);
    for (let i = 0; i < 2; i++) {
      const y = 3 + Math.floor(r() * 9);
      const x0 = Math.floor(r() * 6);
      for (let x = x0; x < x0 + 8; x++) px(ctx, x, y + Math.round(Math.sin(x * 0.9) * 0.7), "#c4a057");
    }
  },
  tundra: (ctx, r) => {
    base(ctx, r, "#9fae9a", 0.07);
    for (let i = 0; i < 4; i++) px(ctx, Math.floor(r() * 15), Math.floor(r() * 15), "#6f8a6a");
    rock(ctx, 3 + Math.floor(r() * 10), 8 + Math.floor(r() * 5), "#8d8d8d", 1);
  },
  snow: (ctx, r) => {
    base(ctx, r, "#e7eef2", 0.04);
    for (let i = 0; i < 3; i++) {
      const x = Math.floor(r() * 14);
      const y = Math.floor(r() * 15);
      px(ctx, x, y, "#c7d6e2");
      px(ctx, x + 1, y, "#c7d6e2");
    }
  },
  hills: (ctx, r) => {
    base(ctx, r, "#8f9b55", 0.06);
    for (let i = 0; i < 2; i++) {
      const cx = 3 + Math.floor(r() * 9);
      const cy = 6 + Math.floor(r() * 7);
      for (let x = -3; x <= 3; x++) {
        const h = Math.round(Math.sqrt(9 - x * x) * 0.55);
        for (let y = 0; y < h; y++) px(ctx, cx + x, cy - y, y === h - 1 ? "#a8b468" : "#7c8746");
      }
    }
  },
  mountain: (ctx, r, v) => {
    base(ctx, r, "#857a6e", 0.07);
    ridge(ctx, 4 + Math.floor(r() * 3), 13, 3, 5, "#8c8079", v === 0 ? "#f0f0f0" : null);
    ridge(ctx, 10 + Math.floor(r() * 3), 14, 4, 6, "#7f7469", v < 2 ? "#e4e6e8" : null);
  },
  peak: (ctx, r) => {
    base(ctx, r, "#a8a29c", 0.06);
    ridge(ctx, 8, 15, 6, 12, "#9a938c", "#f8fafc");
  },
};

export function worldTex(biome: BiomeId, variant: number): HTMLCanvasElement {
  return make(`w:${biome}:${variant}`, 7000 + variant * 53 + biome.length * 29 + biome.charCodeAt(0) * 3, (ctx, r) =>
    WORLD_PAINT[biome](ctx, r, variant),
  );
}

/* ------------------------------ Height & caves ------------------------------- */

export type RockStyle = "moss" | "sand" | "ice" | "basalt" | "granite" | "earth";

/** Rock palettes per cliff style: base, light band, dark seam, top accent (overhang). */
const ROCK: Record<RockStyle, { base: string; light: string; dark: string; cap: string; fleck: string }> = {
  moss: { base: "#7d7466", light: "#9a917f", dark: "#544d44", cap: "#4f8a3c", fleck: "#6aa04a" },
  sand: { base: "#c4945a", light: "#e0b878", dark: "#93683c", cap: "#e8cf8f", fleck: "#a8763f" },
  ice: { base: "#93a8b8", light: "#d6e4ee", dark: "#647a8c", cap: "#f6fafc", fleck: "#bfe4f6" },
  basalt: { base: "#40374f", light: "#5d5174", dark: "#251f34", cap: "#4a3d62", fleck: "#c58cf0" },
  granite: { base: "#867b6f", light: "#ab9f91", dark: "#5a5148", cap: "#cfc6ba", fleck: "#efe8de" },
  earth: { base: "#7a5a3a", light: "#9a7650", dark: "#4e3722", cap: "#5f9a3f", fleck: "#3a6b2e" },
};

/**
 * The south-facing rock face of raised ground: layered strata, cracks, an
 * overhanging lip of the ground above, and a darker foot. Drawn on the lower
 * tile just south of a ledge, cropped to the drop height.
 */
export function cliffFaceTex(style: RockStyle, variant: number): HTMLCanvasElement {
  return make(`cf:${style}:${variant}`, 9100 + variant * 41 + style.charCodeAt(0) * 7 + style.length, (ctx, r) => {
    const p = ROCK[style];
    base(ctx, r, p.base, 0.06);
    // strata: a dark seam with a lit band under it, offset per variant
    for (let y = 3 + (variant % 2); y < PX; y += 4) {
      for (let x = 0; x < PX; x++) {
        if (r() < 0.9) px(ctx, x, y, p.dark);
        if (r() < 0.75) px(ctx, x, y + 1, p.light);
      }
    }
    // vertical cracks and chips
    for (let i = 0; i < 2 + (variant % 2); i++) {
      let x = 1 + Math.floor(r() * 14);
      for (let y = 2 + Math.floor(r() * 4); y < PX - 1; y++) {
        px(ctx, x, y, shade(p.dark, 0.85));
        if (r() < 0.25) x += r() < 0.5 ? -1 : 1;
        if (r() < 0.12) break;
      }
    }
    for (let i = 0; i < 4; i++) px(ctx, Math.floor(r() * 16), 3 + Math.floor(r() * 12), p.fleck);
    // overhanging lip of the ground above (grass, sand, snow…)
    for (let x = 0; x < PX; x++) {
      px(ctx, x, 0, p.cap);
      px(ctx, x, 1, r() < 0.55 ? p.cap : shade(p.cap, 0.8));
      if (r() < 0.3) px(ctx, x, 2, shade(p.cap, 0.72));
    }
    // darker foot where the face meets the ground below
    ctx.fillStyle = "rgba(10,8,20,0.28)";
    ctx.fillRect(0, PX - 2, PX, 2);
  });
}

/** Worn stairs cut into a ledge: the way up, drawn where a slope meets the lower ground. */
export function stairsTex(style: RockStyle): HTMLCanvasElement {
  return make(`st:${style}`, 9300 + style.charCodeAt(0) * 5, (ctx, r) => {
    const p = ROCK[style];
    ctx.fillStyle = shade(p.base, 1.05);
    ctx.fillRect(0, 0, PX, PX);
    for (let s = 0; s < 4; s++) {
      const y = s * 4;
      for (let x = 2; x < PX - 2; x++) {
        px(ctx, x, y, shade(p.light, 1.08));
        px(ctx, x, y + 1, p.light);
        px(ctx, x, y + 2, p.base);
        px(ctx, x, y + 3, p.dark);
        if (r() < 0.12) px(ctx, x, y + 1, p.fleck);
      }
    }
    // rough banks either side of the stair
    for (let y = 0; y < PX; y++) {
      for (const x of [0, 1, PX - 2, PX - 1]) px(ctx, x, y, r() < 0.5 ? p.cap : shade(p.cap, 0.8));
    }
  });
}

/** Transparent step marks laid over a slope tile so the way up always reads. */
export function rampMarkTex(): HTMLCanvasElement {
  return make("rm", 9400, (ctx, r) => {
    for (const y of [4, 9, 14]) {
      for (let x = 2; x < PX - 2; x++) {
        if (r() < 0.14) continue;
        px(ctx, x, y - 1, "rgba(255,246,220,0.55)");
        px(ctx, x, y, "rgba(30,20,40,0.45)");
      }
    }
  });
}

interface CavePalette {
  floor: string;
  wall: string;
  facet: string;
  light: string;
  glow: string;
  glowHi: string;
}
const CAVE_UPPER_PAL: CavePalette = { floor: "#3b3447", wall: "#1d1829", facet: "#2e2740", light: "#4c4360", glow: "#7be0c8", glowHi: "#d4fff4" };
const CAVE_DEEP_PAL: CavePalette = { floor: "#2a2b40", wall: "#14131f", facet: "#232339", light: "#3a3c5a", glow: "#6fc3ff", glowHi: "#e2f6ff" };
const cavePal = (layer: number): CavePalette => (layer <= -2 ? CAVE_DEEP_PAL : CAVE_UPPER_PAL);

/** Damp cave floor: bare stone, moss, puddles, glowcaps (upper) or crystals (deep). */
export function caveFloorTex(layer: number, decor: number): HTMLCanvasElement {
  return make(`cv:${layer}:${decor}`, 9500 + decor * 17 - layer * 101, (ctx, r) => {
    const p = cavePal(layer);
    base(ctx, r, p.floor, 0.1);
    for (let i = 0; i < 3; i++) {
      const x = Math.floor(r() * 14);
      const y = Math.floor(r() * 15);
      px(ctx, x, y, p.light);
      px(ctx, x + 1, y, shade(p.floor, 0.7));
    }
    if (decor === 2) {
      for (let i = 0; i < 9; i++) px(ctx, 3 + Math.floor(r() * 10), 3 + Math.floor(r() * 10), r() < 0.5 ? "#3f6b4a" : "#2f5a3e");
    } else if (decor === 3) {
      const cx = 4 + Math.floor(r() * 7);
      const cy = 5 + Math.floor(r() * 6);
      for (let y = -1; y <= 1; y++) for (let x = -2; x <= 2; x++) if (Math.abs(x) + Math.abs(y) < 3) px(ctx, cx + x, cy + y, "#27405e");
      px(ctx, cx - 1, cy - 1, "#5c86ad");
    } else if (decor === 4) {
      for (let i = 0; i < 3; i++) {
        const x = 3 + Math.floor(r() * 10);
        const y = 6 + Math.floor(r() * 7);
        if (layer <= -2) {
          px(ctx, x, y, p.glow);
          px(ctx, x, y - 1, p.glow);
          px(ctx, x, y - 2, p.glowHi);
          px(ctx, x + 1, y, shade(p.glow, 0.7));
        } else {
          px(ctx, x, y, "#cfc8b8");
          px(ctx, x - 1, y - 1, p.glow);
          px(ctx, x, y - 1, p.glowHi);
          px(ctx, x + 1, y - 1, p.glow);
        }
      }
    }
  });
}

/** Solid cave rock seen from above. */
export function caveWallTex(layer: number, variant: number): HTMLCanvasElement {
  return make(`cw:${layer}:${variant}`, 9700 + variant * 23 - layer * 61, (ctx, r) => {
    const p = cavePal(layer);
    base(ctx, r, p.wall, 0.12);
    for (let i = 0; i < 4; i++) {
      const x = Math.floor(r() * 13);
      const y = Math.floor(r() * 13);
      for (let k = 0; k < 3; k++) px(ctx, x + k, y + (k === 1 ? 1 : 0), p.facet);
    }
  });
}

/** The rock face of a cave wall seen from the passage south of it. */
export function caveFaceTex(layer: number, variant: number): HTMLCanvasElement {
  return make(`cff:${layer}:${variant}`, 9800 + variant * 29 - layer * 37, (ctx, r) => {
    const p = cavePal(layer);
    base(ctx, r, p.facet, 0.1);
    for (let y = 3 + (variant % 2); y < PX; y += 5) for (let x = 0; x < PX; x++) if (r() < 0.85) px(ctx, x, y, p.wall);
    // stalactite teeth along the lip
    for (let x = 0; x < PX; x++) {
      px(ctx, x, 0, p.wall);
      if (r() < 0.3) {
        px(ctx, x, 1, p.wall);
        px(ctx, x, 2, shade(p.wall, 1.3));
      }
    }
    if (r() < 0.6) px(ctx, Math.floor(r() * 16), 6 + Math.floor(r() * 8), cavePal(layer).glow);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(0, PX - 2, PX, 2);
  });
}

/** A cave mouth set into the foot of a cliff: dark arch, rock rim, hanging teeth. */
export function caveMouthTex(): HTMLCanvasElement {
  return make("mouth", 9900, (ctx, r) => {
    for (let y = 0; y < PX; y++) {
      for (let x = 0; x < PX; x++) {
        const dx = (x - 7.5) / 6.5;
        const dy = (y - 15) / 13;
        const d = dx * dx + dy * dy;
        if (d < 1) px(ctx, x, y, d < 0.55 ? "#07060c" : d < 0.8 ? "#14101e" : "#2a2236");
        else if (d < 1.35) px(ctx, x, y, r() < 0.5 ? "#6b6257" : "#544c43");
      }
    }
    for (const x of [5, 7, 9, 11]) {
      px(ctx, x, 3, "#544c43");
      if (x % 4 === 1) px(ctx, x, 4, "#3a332c");
    }
    px(ctx, 6, 11, "#e8742a");
    px(ctx, 9, 11, "#e8742a");
  });
}

/** Inside the caves: daylight spilling down from the mouth above. */
export function caveExitTex(): HTMLCanvasElement {
  return make("exit", 9910, (ctx) => {
    for (let y = 0; y < PX; y++) {
      for (let x = 0; x < PX; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        if (d < 7.5) {
          const a = (1 - d / 7.5) * 0.85;
          ctx.fillStyle = `rgba(255,236,190,${a.toFixed(3)})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    for (let y = 2; y < 14; y += 3) for (let x = 5; x <= 10; x++) px(ctx, x, y, "#8f7248");
    for (let y = 1; y < 15; y++) {
      px(ctx, 5, y, "#6b4a2b");
      px(ctx, 10, y, "#6b4a2b");
    }
  });
}

/** A deep shaft: a ringed pit with a rope ladder (down), or the ladder foot glowing from above (up). */
export function shaftTex(up: boolean): HTMLCanvasElement {
  return make(`shaft:${up ? 1 : 0}`, 9920 + (up ? 7 : 0), (ctx) => {
    for (let y = 0; y < PX; y++) {
      for (let x = 0; x < PX; x++) {
        const d = Math.hypot((x - 7.5) / 1.05, y - 8);
        if (d < 6) px(ctx, x, y, up ? (d < 3 ? "#6c7aa0" : "#3a4262") : d < 4.5 ? "#030207" : "#120f1c");
        else if (d < 7.3) px(ctx, x, y, d < 6.6 ? "#5a5168" : "#3a3346");
      }
    }
    for (let y = 2; y < 15; y += 2) {
      px(ctx, 6, y, "#a08554");
      px(ctx, 9, y, "#a08554");
      if (y % 4 === 0) for (let x = 6; x <= 9; x++) px(ctx, x, y, "#c9a36a");
    }
  });
}

/* ------------------------------ Forage & carrion ------------------------------ */

/**
 * A forageable plant (stage 0) or its grazed stub (stage 1), drawn on the
 * ground of any biome that grows it.
 */
export function forageTex(item: ItemId, stage: 0 | 1): HTMLCanvasElement {
  return make(`fd:${item}:${stage}`, 61 + item.length * 7 + stage * 13, (ctx, r) => {
    if (stage === 1) {
      for (const [x, h] of [[5, 3], [7, 4], [9, 2], [11, 3]] as const) {
        for (let y = 0; y < h; y++) px(ctx, x, 14 - y, y === h - 1 ? "#9a8a54" : "#6f6a45");
      }
      px(ctx, 6, 12, "#55613a");
      px(ctx, 10, 13, "#55613a");
      return;
    }
    switch (item) {
      case "berries": {
        for (let y = 9; y <= 14; y++) {
          for (let x = 4; x <= 11; x++) {
            if (Math.hypot(x - 7.5, (y - 12.4) * 1.15) < 3.6) px(ctx, x, y, x < 7 ? "#3e7a34" : shade("#3e7a34", 0.82));
          }
        }
        for (const [bx, by] of [[5, 10], [8, 9], [10, 11], [6, 12], [9, 13], [4, 12]] as const) {
          px(ctx, bx, by, "#c2334a");
          px(ctx, bx, by - 1, shade("#c2334a", 1.3));
        }
        break;
      }
      case "nuts": {
        px(ctx, 6, 10, "#6b4a2b"); px(ctx, 7, 9, "#6b4a2b"); px(ctx, 8, 10, "#6b4a2b");
        for (const [nx, ny] of [[5, 13], [8, 12], [10, 14]] as const) {
          px(ctx, nx, ny, "#a0723a");
          px(ctx, nx + 1, ny, shade("#a0723a", 1.2));
          px(ctx, nx, ny - 1, "#5c3d20");
        }
        break;
      }
      case "mushroom": {
        const cap = "#cdb7e6";
        const capD = shade(cap, 0.8);
        for (let x = 5; x <= 10; x++) { px(ctx, x, 10, x < 8 ? cap : capD); px(ctx, x, 11, x < 8 ? capD : cap); }
        px(ctx, 6, 9, cap); px(ctx, 9, 9, capD);
        px(ctx, 7, 12, "#e8e2f2"); px(ctx, 8, 12, "#e8e2f2"); px(ctx, 7, 13, "#cfc8dd"); px(ctx, 8, 13, "#cfc8dd");
        px(ctx, 11, 12, cap); px(ctx, 12, 12, capD);
        px(ctx, 11, 13, "#e8e2f2"); px(ctx, 12, 13, "#cfc8dd");
        px(ctx, 4, 13, "#3e7a34");
        break;
      }
      case "herb": {
        for (const [lx, ly] of [[6, 12], [8, 11], [10, 13]] as const) {
          px(ctx, lx, ly, "#5fae4e");
          px(ctx, lx - 1, ly - 1, "#4c8f3f");
          px(ctx, lx + 1, ly - 1, "#6fc25e");
          px(ctx, lx, ly - 2, "#4c8f3f");
        }
        break;
      }
      case "fish": {
        ctx.fillStyle = "rgba(230,244,252,0.5)";
        ctx.fillRect(3, 9, 10, 5);
        for (let x = 4; x <= 11; x++) {
          px(ctx, x, 11, x % 2 ? "#7fb7d6" : "#b8dcf0");
          px(ctx, x, 12, "#5e97ba");
        }
        px(ctx, 4, 11, "#4d7f9e"); px(ctx, 3, 10, "#b8dcf0"); px(ctx, 3, 12, "#b8dcf0");
        px(ctx, 12, 10, "#7fb7d6"); px(ctx, 12, 12, "#7fb7d6");
        px(ctx, 8, 11, "#314b5c");
        break;
      }
      case "honeycomb": {
        for (let y = 10; y <= 14; y++) for (let x = 5; x <= 10; x++) if (y < 13 || (x > 5 && x < 10)) px(ctx, x, y, x < 8 ? "#f2c14e" : shade("#f2c14e", 0.82));
        px(ctx, 7, 11, "#b8862e"); px(ctx, 9, 12, "#b8862e");
        px(ctx, 6, 10, "#ffe08a");
        break;
      }
      case "cactus_fruit": {
        for (let y = 9; y <= 14; y++) for (let x = 6; x <= 9; x++) px(ctx, x, y, x < 8 ? "#4f8a3c" : shade("#4f8a3c", 0.8));
        px(ctx, 7, 8, "#e05a8a"); px(ctx, 8, 8, "#e05a8a"); px(ctx, 7, 7, "#f08ab0"); px(ctx, 8, 9, "#b03a6a");
        px(ctx, 5, 11, "#d9b46a"); px(ctx, 10, 12, "#d9b46a");
        break;
      }
      case "ore": {
        for (const [ox, oy, s] of [[6, 12, 1], [9, 13, 0.8], [8, 10, 0.6]] as const) {
          px(ctx, ox, oy, "#a7b4c2");
          px(ctx, ox + 1, oy, shade("#a7b4c2", s));
          px(ctx, ox, oy - 1, shade("#a7b4c2", 1.25));
        }
        px(ctx, 7, 13, "#6d7a88"); px(ctx, 10, 11, "#6d7a88");
        break;
      }
      default:
        tufts(ctx, r, "#5fae4e", 4, true);
    }
  });
}

/** Fallen remains: fresh (stage 0) or aging (stage 1). */
export function carrionTex(stage: 0 | 1): HTMLCanvasElement {
  return make(`cr:${stage}`, 91 + stage * 7, (ctx) => {
    const body = stage === 0 ? "#a34336" : "#71403a";
    const dark = stage === 0 ? "#7e2f28" : "#4e2b26";
    ctx.fillStyle = "rgba(10,8,20,0.22)";
    ctx.fillRect(3, 14, 10, 1);
    for (let x = 5; x <= 11; x++) {
      const h = x > 6 && x < 10 ? 2 : 1;
      for (let y = 0; y <= h; y++) px(ctx, x, 13 - y, x < 9 ? body : dark);
    }
    px(ctx, 7, 11, dark); px(ctx, 9, 11, dark);
    px(ctx, 3, 13, "#e7e0d0"); px(ctx, 2, 12, "#e7e0d0"); px(ctx, 3, 12, "#c9bfae");
    if (stage === 1) {
      px(ctx, 6, 10, "#8a9a6a"); px(ctx, 10, 11, "#8a9a6a"); px(ctx, 8, 12, "#a5b478");
    } else {
      px(ctx, 6, 11, "#c96a54"); px(ctx, 10, 12, "#c96a54");
    }
  });
}

/* --------------------------------- roads ------------------------------------ */

/** Chunky road plates per class: a packed-dirt footpath (local), a gravel
 *  wagonway (regional), and a cobbled highway (major) — ragged edged so the
 *  land shows through, full-bleed when the road is paved. */
export function roadTex(cls: RoadClass, variant: number): HTMLCanvasElement {
  return make(`rd:${cls}:${variant}`, 3300 + variant * 71 + cls.length * 29, (ctx, r) => {
    const inset = cls === "local" ? 3 : cls === "regional" ? 1 : 0;
    const speckle = (edge: string, mid: string, n: number): void => {
      for (let i = 0; i < n; i++) {
        const x = inset + Math.floor(r() * (PX - inset * 2));
        const y = inset + Math.floor(r() * (PX - inset * 2));
        px(ctx, x, y, r() < 0.5 ? edge : mid);
      }
    };
    if (cls === "major") {
      // cobbles: slabs with dark joints, a wheel-worn pair of ruts
      base(ctx, r, "#9a938a", 0.05);
      for (let y = 0; y < PX; y += 4) {
        for (let x = 0; x < PX; x++) px(ctx, x, y, "#7d766e");
        for (let x = (y % 8 === 0 ? 0 : 2); x < PX; x += 4) px(ctx, x, y + 1, "#8b847b");
      }
      for (const x of [4, 11]) for (let y = 2; y < PX; y += 5) px(ctx, x, y + ((x + y) % 3 === 0 ? 1 : 0), "#847d74");
      speckle("#b0a89d", "#736c64", 14);
    } else if (cls === "regional") {
      // gravel wagonway
      base(ctx, r, "#8f7d63", 0.09);
      speckle("#a8946f", "#6f6049", 30);
      speckle("#7a6a52", "#a3936f", 18);
    } else {
      // packed dirt footpath: the biome bleeds in at the ragged edge
      base(ctx, r, "#a58a5f", 0.08);
      speckle("#b89c6e", "#8a7250", 22);
      // grass intrudes where the walkers stray
      for (let i = 0; i < 7; i++) {
        const x = Math.floor(r() * PX);
        const y = Math.floor(r() * PX);
        if (x < inset || x >= PX - inset || y < inset || y >= PX - inset) px(ctx, x, y, "#7d9a4d");
      }
    }
  });
}

/** A trodden building path: worn earth from a doorstep to the village green —
 *  humbler than a lane, with grass reseeding wherever feet stray. */
export function pathTex(variant: number): HTMLCanvasElement {
  return make(`pt:${variant}`, 5077 + variant * 53, (ctx, r) => {
    base(ctx, r, "#a3895e", 0.1);
    for (let i = 0; i < 14; i++) {
      const x = Math.floor(r() * PX);
      const y = Math.floor(r() * PX);
      px(ctx, x, y, r() < 0.5 ? "#b39a6c" : "#8a7350");
    }
    for (let i = 0; i < 9; i++) {
      const x = Math.floor(r() * PX);
      const y = Math.floor(r() * PX);
      px(ctx, x, y, "#7d9a4d");
    }
  });
}

/** A bridge span: wooden decking on twin edge beams, laid over open water.
 *  Planks run across the lane; a few boards are mossy or missing a nail. */
export function bridgeTex(variant: number): HTMLCanvasElement {
  return make(`br:${variant}`, 4417 + variant * 37, (ctx, r) => {
    base(ctx, r, "#7d5e3a", 0.05);
    for (let y = 0; y < PX; y += 3) {
      for (let x = 0; x < PX; x++) px(ctx, x, y, "#63482c");
      for (let x = 0; x < PX; x++) px(ctx, x, y + 1, "#8f6e46");
    }
    // twin edge beams carry the span
    for (let x = 0; x < PX; x++) {
      px(ctx, x, 0, "#513a24");
      px(ctx, x, 1, "#5f462c");
      px(ctx, x, PX - 2, "#5f462c");
      px(ctx, x, PX - 1, "#513a24");
    }
    // nail heads and weathered boards
    for (let i = 0; i < 6; i++) {
      const x = 2 + Math.floor(r() * (PX - 4));
      const y = 3 + Math.floor(r() * (PX - 6));
      px(ctx, x, y, r() < 0.5 ? "#4e3a25" : "#9c7c52");
    }
  });
}

/* ------------------- Objects, thermals, sky and seafloor --------------------- */

import type { ObjKind } from "./objects";

const OBJ_PAINT: Record<ObjKind, (ctx: Ctx, r: R, v: number) => void> = {
  tree: (ctx, r, v) => oak(ctx, r, 8, 6, v === 2 ? "#3f7d2e" : "#2f6b2e"),
  pine: (ctx, r, v) => pine(ctx, r, 8, 0, v === 2 ? "#2d5c40" : "#24503a", false),
  gloomtree: (ctx, r) => {
    oak(ctx, r, 8, 6, "#6d6484");
    for (let i = 0; i < 3; i++) px(ctx, 3 + Math.floor(r() * 10), 2 + Math.floor(r() * 8), "#9a8fc0");
  },
  deadtree: (ctx, r) => deadTree(ctx, r, 8),
  shrub: (ctx, r) => {
    for (let i = 0; i < 7; i++) treeDot(ctx, 4 + Math.floor(r() * 8), 9 + Math.floor(r() * 4), "#2f5c28", "#699a4a");
    for (let y = 0; y < 3; y++) for (let x = 5; x < 11; x++) if (r() < 0.7) px(ctx, x, 8 + y, y === 0 ? "#699a4a" : "#3e6b2e");
  },
  boulder: (ctx, r) => {
    rock(ctx, 8, 10, "#8d877d", 5);
    for (let i = 0; i < 3; i++) px(ctx, 4 + Math.floor(r() * 8), 6 + Math.floor(r() * 6), "#a89f8f");
  },
  rocks: (ctx, r) => {
    rock(ctx, 5, 11, "#8d877d", 2);
    rock(ctx, 10, 12, "#7f7a70", 1);
    rock(ctx, 9, 9, "#8a857c", 2);
  },
  reeds: (ctx, r) => {
    for (let i = 0; i < 6; i++) {
      const x = 3 + i * 2 + (r() < 0.5 ? 0 : 1);
      const top = 3 + Math.floor(r() * 4);
      for (let y = 14; y >= top; y--) px(ctx, x + (y % 3 === 0 ? (r() < 0.5 ? 1 : 0) : 0), y, y < 7 ? "#8a9a4a" : "#5d7a4a");
      if (r() < 0.5) px(ctx, x, top - 1, "#7a4a2a");
    }
  },
  cactus: (ctx, r, v) => {
    for (let y = 6; y <= 14; y++) for (let x = 7; x <= 9; x++) px(ctx, x, y, x === 7 ? "#6a9a4a" : "#4a7a3a");
    for (let y = 9; y <= 11; y++) px(ctx, 5, y, "#4a7a3a");
    px(ctx, 6, 9, "#4a7a3a");
    px(ctx, 6, 10, "#4a7a3a");
    for (let y = 8; y <= 10; y++) px(ctx, 11, y, "#4a7a3a");
    px(ctx, 10, 8, "#4a7a3a");
    for (let i = 0; i < 5; i++) px(ctx, 7 + Math.floor(r() * 3), 6 + Math.floor(r() * 8), "#e8f0d0");
    if (v === 1) {
      px(ctx, 8, 5, "#e05a8a");
      px(ctx, 8, 4, "#f2c14e");
    }
  },
};

/** A physical map object — tree, boulder, reeds — drawn standing up from the
 *  ground with a soft shadow at its foot. Transparent background: the ground
 *  texture shows through around the sprite. */
export function objectTex(kind: ObjKind, variant: number): HTMLCanvasElement {
  return make(`ob:${kind}:${variant}`, 7700 + variant * 61 + kind.length * 13 + kind.charCodeAt(0) * 5, (ctx, r) => {
    OBJ_PAINT[kind](ctx, r, variant);
    ctx.fillStyle = "rgba(10,20,10,0.22)";
    ctx.fillRect(4, 14, 8, 1);
    ctx.fillStyle = "rgba(10,20,10,0.14)";
    ctx.fillRect(5, 15, 6, 1);
  });
}

/** A rising thermal, seen from the ground: faint warm motes climbing. */
export function thermalMarkTex(): HTMLCanvasElement {
  return make("th", 9601, (ctx, r) => {
    for (let i = 0; i < 7; i++) {
      const x = 2 + Math.floor(r() * 12);
      const y = 2 + Math.floor(r() * 12);
      px(ctx, x, y, "rgba(255,244,200,0.5)");
      if (r() < 0.5) px(ctx, x, y - 1, "rgba(255,244,200,0.3)");
    }
  });
}

/** One tile of the open sky: 0 clear high air, 1 wispy cloud, 2 cloud bank, 3 a thermal updraft. */
export function skyTex(decor: number, variant: number): HTMLCanvasElement {
  return make(`sk:${decor}:${variant}`, 9800 + decor * 71 + variant * 17, (ctx, r) => {
    // high-altitude blue, lighter toward the top of the tile
    for (let y = 0; y < PX; y++) {
      const k = 1 + 0.14 * (1 - y / PX);
      for (let x = 0; x < PX; x++) px(ctx, x, y, shade("#6ea8dc", k * (r() < 0.12 ? 1.04 : 1)));
    }
    if (decor === 1 || decor === 2) {
      const n = decor === 2 ? 4 : 2;
      for (let i = 0; i < n; i++) {
        const cx = 2 + Math.floor(r() * 12);
        const cy = 3 + Math.floor(r() * 10);
        const w = 3 + Math.floor(r() * 4);
        for (let dx = -w; dx <= w; dx++) {
          const hh = Math.round(Math.cos((dx / (w + 1)) * Math.PI * 0.9) * 2);
          for (let dy = 0; dy <= hh; dy++) px(ctx, cx + dx, cy + dy, dy === 0 ? "#f2f7fc" : "#dceaf6");
        }
      }
    }
    if (decor === 3) {
      // a thermal: a shimmering column of rising air
      const cx = 4 + Math.floor(r() * 8);
      for (let y = 1; y < PX; y++) {
        px(ctx, cx + (y % 2), y, "rgba(255,255,240,0.4)");
        if (y % 3 === 0) px(ctx, cx - 1, y, "rgba(255,255,240,0.25)");
      }
    }
  });
}

const UW_SAND = "#8f8468";
const UW_SAND_FRESH = "#7d7a5e";

/** The underwater floor: 0 sand, 1 kelp, 2 reef rock, 3 murk, 4 sunken log (salt) or lily roots (fresh). */
export function uwFloorTex(fresh: boolean, decor: number, variant: number): HTMLCanvasElement {
  return make(`uw:${fresh ? 1 : 0}:${decor}:${variant}`, 9900 + decor * 83 + variant * 19 + (fresh ? 5 : 0), (ctx, r) => {
    const sand = fresh ? UW_SAND_FRESH : UW_SAND;
    base(ctx, r, sand, 0.08);
    if (decor === 1) {
      for (let i = 0; i < 4; i++) {
        const x = 3 + Math.floor(r() * 10);
        const top = 2 + Math.floor(r() * 5);
        for (let y = 15; y >= top; y--) px(ctx, x + (y % 4 === 0 ? 1 : 0), y, y < 8 ? "#3a6b4a" : "#2f5a3e");
        px(ctx, x, top, "#4a7a4a");
      }
    } else if (decor === 2) {
      rock(ctx, 5 + Math.floor(r() * 6), 9 + Math.floor(r() * 4), fresh ? "#6a6e62" : "#6a5a6e", 3);
      for (let i = 0; i < 4; i++) px(ctx, 3 + Math.floor(r() * 10), 6 + Math.floor(r() * 8), fresh ? "#8a9a6a" : "#c58ca0");
    } else if (decor === 3) {
      ctx.fillStyle = "rgba(20,40,50,0.42)";
      ctx.fillRect(0, 0, PX, PX);
      for (let i = 0; i < 3; i++) {
        const x = 2 + Math.floor(r() * 12);
        for (let y = 1 + Math.floor(r() * 4); y < PX; y += 3) px(ctx, x, y, "rgba(200,230,220,0.2)");
      }
    } else if (decor === 4) {
      if (fresh) {
        // lily roots: pads on the surface above, pale roots reaching down
        for (let i = 0; i < 3; i++) {
          const x = 3 + Math.floor(r() * 9);
          const y = 4 + Math.floor(r() * 6);
          for (let dx = -2; dx <= 2; dx++) px(ctx, x + dx, y, "#4a8a5a");
          px(ctx, x, y + 1, "#2f5a3e");
          for (let dy = 1; dy < 4; dy++) px(ctx, x, y + dy, "#8a9a7a");
        }
      } else {
        // a sunken log, half-buried
        const y0 = 7 + Math.floor(r() * 3);
        for (let x = 1; x < PX - 1; x++) {
          px(ctx, x, y0, "#5a442e");
          px(ctx, x, y0 + 1, "#4a3624");
          px(ctx, x, y0 + 2, "#3a2a1c");
        }
        for (let i = 0; i < 3; i++) px(ctx, 3 + Math.floor(r() * 10), y0, "#6a543a");
      }
    }
    // everything dims a little under fathoms of water
    ctx.fillStyle = "rgba(12,30,52,0.3)";
    ctx.fillRect(0, 0, PX, PX);
  });
}

/** Rock where the seafloor does not exist — land under the water table, drawn like pressed-down cave wall. */
export function uwWallTex(variant: number): HTMLCanvasElement {
  return make(`uww:${variant}`, 9970 + variant * 23, (ctx, r) => {
    base(ctx, r, "#1d2836", 0.1);
    for (let i = 0; i < 4; i++) {
      const x = Math.floor(r() * 14);
      const y = Math.floor(r() * 14);
      px(ctx, x, y, "#2c3a4c");
      px(ctx, x + 1, y, "#141c28");
    }
    if (r() < 0.4) px(ctx, Math.floor(r() * 16), Math.floor(r() * 16), "#4a6a7a");
  });
}
