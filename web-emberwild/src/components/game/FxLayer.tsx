import { memo, useEffect, useRef } from "react";
import { BURST_LIFE, activeBursts, activeProjectiles, mapCamera } from "@/game/fx";
import { SKY, UW, moverOf } from "@/game/height";
import { hash2 } from "@/game/rng";
import { columnBodies } from "@/game/sim";
import type { GameState } from "@/game/types";
import { getWorld, timeOf } from "@/game/world";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
  kind: "rain" | "snow" | "dust" | "smoke";
  phase: number;
}

const MAX_WEATHER = 240;
const MAX_SMOKE = 60;
const FIRE_COLS = ["#f2c14e", "#f2a24e", "#e8742a"] as const;
/** Faint atmosphere washes for the zoomed-out maps, keyed by weather id. */
const SKY_TINTS: Record<string, string> = {
  rain: "rgba(76,120,190,0.10)",
  storm: "rgba(38,36,74,0.16)",
  snow: "rgba(230,240,252,0.10)",
  fog: "rgba(200,202,214,0.12)",
  sandstorm: "rgba(214,178,122,0.13)",
  cloudy: "rgba(20,16,48,0.07)",
};

/** One fog band drifting across the view, drawn twice for seamless wrap. */
function drawFogBand(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, wind: number, i: number): void {
  const bh = h * 0.15;
  const span = w + bh * 2;
  const x = (((t / 1000) * (12 + wind * 24 + i * 6) + i * 430) % span) - bh;
  const y = h * (0.06 + i * 0.2) + Math.sin(t / 1300 + i * 2.1) * h * 0.04;
  ctx.fillStyle = `rgba(206,206,216,${(0.05 + i * 0.014).toFixed(3)})`;
  ctx.fillRect(x, y, bh * 1.7, bh);
  ctx.fillRect(x - span, y, bh * 1.7, bh);
}

/** Render the young burst events: beams, impact sparks, rings, puffs, flashes, motes, ignition and ash. */
function drawBursts(ctx: CanvasRenderingContext2D, tileX: (wx: number) => number, tileY: (wy: number) => number, ts: number): void {
  const now = performance.now();
  for (const b of activeBursts()) {
    if (now < b.at) continue; // scheduled projectile impact — not yet
    const p = Math.min(1, (now - b.at) / BURST_LIFE[b.kind]);
    const a = 1 - p;
    if (b.kind === "beam" && b.x1 !== undefined && b.y1 !== undefined) {
      const x0 = tileX(b.x);
      const y0 = tileY(b.y);
      const x1 = tileX(b.x1);
      const y1 = tileY(b.y1);
      for (let i = 0; i < 8; i++) {
        const q = Math.max(0, p - i * 0.05);
        const x = x0 + (x1 - x0) * q + (Math.random() - 0.5) * 4;
        const y = y0 + (y1 - y0) * q + (Math.random() - 0.5) * 4;
        const s = i === 0 ? 3.5 : 3 - i * 0.25;
        ctx.globalAlpha = 1 - i * 0.12;
        ctx.fillStyle = i === 0 ? "#fff4dc" : b.color;
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;
    } else if (b.kind === "burst") {
      const cx = tileX(b.x) + ts / 2;
      const cy = tileY(b.y) + ts / 2;
      const R = ts * (0.25 + p * 0.85);
      ctx.fillStyle = b.color;
      for (let i = 0; i < 10; i++) {
        const ang = (i / 10) * Math.PI * 2 + b.id;
        const r = R * (0.75 + ((i * 37) % 10) / 40);
        ctx.globalAlpha = a;
        ctx.fillRect(cx + Math.cos(ang) * r - 1.5, cy + Math.sin(ang) * r - 1.5, 3, 3);
      }
      ctx.globalAlpha = p < 0.3 ? 0.9 : a * 0.6;
      ctx.fillStyle = "#fff4dc";
      ctx.fillRect(cx - 2.5, cy - 2.5, 5, 5);
      ctx.globalAlpha = 1;
    } else if (b.kind === "ring") {
      ctx.strokeStyle = b.color;
      ctx.fillStyle = b.color;
      ctx.lineWidth = 1.5;
      for (const [tx, ty] of b.tiles ?? [[b.x, b.y]]) {
        const X = tileX(tx);
        const Y = tileY(ty);
        ctx.globalAlpha = a * 0.3;
        ctx.fillRect(X, Y, ts, ts);
        ctx.globalAlpha = a * 0.9;
        ctx.strokeRect(X + 0.5, Y + 0.5, ts - 1, ts - 1);
      }
      ctx.globalAlpha = 1;
    } else if (b.kind === "puff") {
      const cx = tileX(b.x) + ts / 2;
      const cy = tileY(b.y) + ts / 2;
      const dir = b.id % 2 === 0 ? 1 : -1;
      ctx.fillStyle = b.color;
      for (let i = 0; i < 4; i++) {
        const q = p * ts * 0.5;
        ctx.globalAlpha = a * 0.7;
        ctx.fillRect(cx + dir * q + (i - 1.5) * 3, cy - q * 0.7 - i * 1.5, 3, 3);
      }
      ctx.globalAlpha = 1;
    } else if (b.kind === "flash") {
      const X = tileX(b.x);
      const Y = tileY(b.y);
      ctx.globalAlpha = a * 0.55;
      ctx.fillStyle = b.color;
      ctx.fillRect(X - 1, Y - 1, ts + 2, ts + 2);
      ctx.globalAlpha = 1;
    } else if (b.kind === "motes") {
      const cx = tileX(b.x) + ts / 2;
      const cy = tileY(b.y) + ts * 0.8;
      ctx.fillStyle = b.color;
      for (let i = 0; i < 5; i++) {
        const q = Math.max(0, p - i * 0.08) / (1 - i * 0.08);
        ctx.globalAlpha = (1 - q) * 0.85;
        ctx.fillRect(cx + Math.sin(i * 2.4 + b.id) * ts * 0.22, cy - q * ts * 1.1, 2.5, 2.5);
      }
      ctx.globalAlpha = 1;
    } else if (b.kind === "ignite") {
      const X = tileX(b.x);
      const Y = tileY(b.y);
      ctx.globalAlpha = a * 0.65;
      ctx.fillStyle = p < 0.4 ? "#fff4dc" : b.color;
      ctx.fillRect(X, Y, ts, ts);
      ctx.globalAlpha = 1;
    } else if (b.kind === "ash") {
      const X = tileX(b.x);
      const Y = tileY(b.y);
      ctx.globalAlpha = a * 0.35;
      ctx.fillStyle = "#6b6455";
      ctx.fillRect(X, Y, ts, ts);
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = "#e8742a";
      ctx.fillRect(X + ts * 0.3, Y + ts * 0.55, 2, 2);
      ctx.fillRect(X + ts * 0.6, Y + ts * 0.7, 2, 2);
      ctx.globalAlpha = 1;
    }
  }
}

/**
 * Translucent animated layer over the exploration map: weather, move effects
 * and burning tiles. Runs its own ~30fps loop, caps particles, and reads the
 * map renderer's published camera — it never mutates game state, so the
 * simulation's determinism is untouched.
 */
export const FxLayer = memo(function FxLayer({ gs }: { gs: GameState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const gsRef = useRef(gs);
  gsRef.current = gs;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let last = 0;
    let weatherId = "";
    let flash = 0;
    let nextBolt = 3;
    const wparts: Particle[] = [];
    const smoke: Particle[] = [];

    /** Rebuild the weather pool when the sky changes. */
    const buildWeather = (id: string, wind: number, w: number, h: number): void => {
      wparts.length = 0;
      weatherId = id;
      const n = id === "storm" ? 170 : id === "rain" ? 110 : id === "snow" ? 80 : id === "sandstorm" ? Math.round(70 + wind * 100) : 0;
      for (let i = 0; i < n && wparts.length < MAX_WEATHER; i++) {
        if (id === "rain" || id === "storm") {
          wparts.push({
            kind: "rain", x: Math.random() * (w + 240) - 120, y: Math.random() * h, vx: wind * 220 + (id === "storm" ? 70 : 25), vy: id === "storm" ? 920 : 640,
            life: 0, max: 2, color: id === "storm" ? "rgba(190,214,238,0.5)" : "rgba(168,212,238,0.42)", size: id === "storm" ? 2 : 1, phase: 0,
          });
        } else if (id === "snow") {
          wparts.push({ kind: "snow", x: Math.random() * w, y: Math.random() * h, vx: 0, vy: 32 + Math.random() * 42, life: 0, max: 30, color: "rgba(240,246,252,0.85)", size: Math.random() < 0.3 ? 3 : 2, phase: Math.random() * 6.28 });
        } else {
          wparts.push({
            kind: "dust", x: Math.random() * (w + 180) - 90, y: Math.random() * h, vx: 240 + wind * 420 + Math.random() * 130, vy: (Math.random() - 0.5) * 44,
            life: 0, max: 3, color: `rgba(214,178,122,${(0.22 + Math.random() * 0.26).toFixed(3)})`, size: Math.random() < 0.25 ? 3 : 2, phase: Math.random() * 6.28,
          });
        }
      }
    };

    const frame = (t: number): void => {
      raf = requestAnimationFrame(frame);
      if (t - last < 33) return; // ~30fps is plenty for chunky pixels
      const dt = last === 0 ? 0.033 : Math.min(0.12, (t - last) / 1000);
      last = t;
      const g = gsRef.current;
      const cam = mapCamera;
      const w = cam.w;
      const h = cam.h;
      if (!w || !h || !cv.isConnected) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.floor(w * dpr) || cv.height !== Math.floor(h * dpr)) {
        cv.width = Math.floor(w * dpr);
        cv.height = Math.floor(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (cam.layer < 0) return; // no sky underground

      const wea = getWorld(g.seed).weather(g.player.x, g.player.y, g.tick);
      const wind = wea.wind;
      const tileX = (wx: number): number => Math.round(w / 2 + (wx - (cam.cx + cam.cell / 2)) * (cam.ts / cam.cell));
      const tileY = (wy: number): number => Math.round(h / 2 + (wy - (cam.cy + cam.cell / 2)) * (cam.ts / cam.cell));

      if (cam.scale === "local") {
        const ts = cam.ts;
        if (wea.id !== weatherId) buildWeather(wea.id, wind, w, h);
        for (const p of wparts) {
          if (p.kind === "snow") p.x += Math.sin(t / 700 + p.phase) * (12 + wind * 26) * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.kind === "rain") {
            if (p.y > h + 24) {
              p.y = -14;
              p.x = Math.random() * (w + 240) - 120;
            }
            if (p.x > w + 130) p.x = -110;
          } else if (p.kind === "snow") {
            if (p.y > h + 6) {
              p.y = -6;
              p.x = Math.random() * w;
            }
            if (p.x > w + 4) p.x = -4;
            else if (p.x < -4) p.x = w + 4;
          } else {
            p.x += Math.sin(t / 420 + p.phase) * 22 * dt;
            if (p.x > w + 100) {
              p.x = -90;
              p.y = Math.random() * h;
            }
            if (p.y > h + 6) p.y = -6;
            else if (p.y < -8) p.y = h + 4;
          }
          ctx.fillStyle = p.color;
          if (p.kind === "rain") ctx.fillRect(p.x, p.y, p.size, 9 + p.vy / 110);
          else ctx.fillRect(p.x, p.y, p.size, p.size);
        }
        if (wea.id === "fog") for (let i = 0; i < 5; i++) drawFogBand(ctx, w, h, t, wind, i);
        if (wea.id === "storm") {
          ctx.fillStyle = "rgba(18,14,44,0.15)";
          ctx.fillRect(0, 0, w, h);
          nextBolt -= dt;
          if (nextBolt <= 0) {
            flash = 0.22;
            nextBolt = 3 + Math.random() * 6;
          }
          if (flash > 0) {
            flash -= dt;
            ctx.fillStyle = `rgba(255,252,235,${(Math.max(0, flash) / 0.22) * 0.26})`;
            ctx.fillRect(0, 0, w, h);
          }
        }
        if (wea.id === "cloudy") {
          ctx.fillStyle = "rgba(20,16,48,0.09)";
          ctx.fillRect(0, 0, w, h);
        }
        // the vertical world made visible: every shadow and shape belongs to a
        // real body — an aloft flier's shadow on the ground, a swimmer's shape
        // gliding beneath deep water — moving only when the world ticks
        if (cam.layer === 0) {
          const time = timeOf(g.tick);
          const sun = time.daylight > 0.25 && wea.id !== "storm" && wea.id !== "fog" && wea.id !== "sandstorm";
          for (const b of columnBodies(g, SKY)) {
            if (!sun || !moverOf(b.speciesId).flies) continue;
            const X = tileX(b.x);
            const Y = tileY(b.y);
            if (X < -ts * 2 || X > w + ts * 2 || Y < -ts * 2 || Y > h + ts * 2) continue;
            ctx.fillStyle = "rgba(10,10,26,0.16)";
            ctx.beginPath();
            ctx.ellipse(X + ts / 2, Y + ts / 2, ts * 0.75, ts * 0.32, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          for (const b of columnBodies(g, UW)) {
            const X = tileX(b.x);
            const Y = tileY(b.y);
            if (X < -ts * 2 || X > w + ts * 2 || Y < -ts * 2 || Y > h + ts * 2) continue;
            ctx.fillStyle = "rgba(8,16,30,0.22)";
            ctx.beginPath();
            ctx.ellipse(X + ts / 2, Y + ts / 2, ts * 0.42, ts * 0.2, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        // burning tiles: ember glow, flickering pixel flames, rising smoke
        for (const k in g.ground) {
          const gt = g.ground[k];
          if (!gt.fire) continue;
          const ci = k.indexOf(",");
          const x = Number(k.slice(0, ci));
          const y = Number(k.slice(ci + 1));
          const X = tileX(x);
          const Y = tileY(y);
          if (X < -ts || X > w + ts || Y < -ts * 2 || Y > h + ts) continue;
          const ph = (hash2(g.seed ^ 0x9e37, x, y) % 628) / 100;
          const flick = 0.7 + 0.3 * Math.sin(t / 90 + ph * 7);
          ctx.fillStyle = `rgba(232,116,42,${(0.15 + 0.1 * flick).toFixed(3)})`;
          ctx.fillRect(X, Y, ts, ts);
          const n = Math.max(3, Math.round(ts / 8));
          for (let i = 0; i < n; i++) {
            const fx = X + ((hash2(x * 31 + i, y * 17, 7) % 100) / 100) * (ts - 3);
            const fh = ts * (0.26 + 0.4 * Math.abs(Math.sin(t / 120 + ph + i * 1.7)));
            ctx.fillStyle = FIRE_COLS[i % 3];
            ctx.fillRect(fx, Y + ts - fh, 2.5, fh);
          }
          if (smoke.length < MAX_SMOKE && Math.random() < dt * 3) {
            smoke.push({ kind: "smoke", x: X + Math.random() * ts, y: Y + ts * 0.2, vx: (Math.random() - 0.3) * 9, vy: -13 - Math.random() * 15, life: 0, max: 1.6, color: "rgba(72,68,82,0.32)", size: 2.5, phase: 0 });
          }
        }
      } else {
        // zoomed out: weather is only a faint atmosphere wash
        const tint = SKY_TINTS[wea.id];
        if (tint) {
          ctx.fillStyle = tint;
          ctx.fillRect(0, 0, w, h);
        }
      }

      // flying ranged attacks: glowing bolts with fading trails
      for (const p of activeProjectiles()) {
        const q = Math.min(1, Math.max(0, (t - p.at) / p.fly));
        for (let i = 2; i >= 0; i--) {
          const q2 = Math.max(0, q - i * 0.07);
          const tX = tileX(p.x + (p.x1 - p.x) * q2);
          const tY = tileY(p.y + (p.y1 - p.y) * q2);
          ctx.globalAlpha = i === 0 ? 1 : 0.55 - i * 0.18;
          ctx.fillStyle = i === 0 ? "#fff4dc" : p.color;
          const s = i === 0 ? 4 : 3;
          ctx.fillRect(tX - s / 2, tY - s / 2, s, s);
        }
        ctx.globalAlpha = 1;
      }

      // transient smoke wisps
      for (let i = smoke.length - 1; i >= 0; i--) {
        const p = smoke[i];
        p.life += dt;
        if (p.life >= p.max) {
          smoke.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.globalAlpha = 1 - p.life / p.max;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size);
        ctx.globalAlpha = 1;
      }

      drawBursts(ctx, tileX, tileY, cam.ts);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />;
});
