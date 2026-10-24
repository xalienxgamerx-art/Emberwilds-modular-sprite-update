import { memo, useEffect, useRef, useState } from "react";
import { MONSTER_ART, NEST_ART, NPC_ART, RIVAL_ART } from "@/game/assets";
import { carrionStage } from "@/game/carrion";
import { activeFx } from "@/game/combat";
import { BIOMES, DAY_TICKS, SPECIES } from "@/game/data";
import { mapCamera, moveOffset } from "@/game/fx";
import { FACTION_CELL, getFactions } from "@/game/factions";
import { isSettlement, settlementTier, settlementWallTerrain } from "@/game/settlement";
import { bodyFootprint } from "@/game/growth";
import { anyExplored, discoveredList, exploredWorldCells, isExploredOn, isRegionSeen, mouthsSeenList } from "@/game/knowledge";
import { CAVE_DEEP, CAVE_UPPER, SKY, UW, cliffStyle, heightOf, layerOf } from "@/game/height";
import { objectAt } from "@/game/objects";
import { statOf } from "@/game/monster";
import { SCALE_CELL, sampleCell, type MapScale } from "@/game/mapview";
import { computeVisibleFrom, perceptionSources, seesCreature } from "@/game/perception";
import { hash2 } from "@/game/rng";
import { bridgeAt, mapRoadLines, pathAt, roadAt, roadNetworkOf, settlementEntranceAt } from "@/game/roads";
import { getCleanSprite, onCleanSpriteReady } from "@/game/spritebg";
import { getLookSprite, onTamerLookReady } from "@/game/tamerLook";
import {
  biomeTex, bridgeTex, carrionTex, caveExitTex, caveFaceTex, caveFloorTex, caveMouthTex, caveWallTex, cliffFaceTex, featureTex, forageTex, objectTex, pathTex, rampMarkTex, roadTex, shaftTex, skyTex, stairsTex, terrainTex, thermalMarkTex, uwFloorTex, uwWallTex, worldTex,
} from "@/game/tiles";
import type { FeatureId, GameState } from "@/game/types";
import { getWorld, timeOf, type Npc } from "@/game/world";
import { FxLayer } from "./FxLayer";

const FEATURE_GLYPH: Record<FeatureId, { text: string; color: string }> = {
  hamlet: { text: "⌂", color: "#f2c14e" },
  town: { text: "⌂", color: "#e8862b" },
  city: { text: "⌂", color: "#f5f0e6" },
  shrine: { text: "✚", color: "#3fb8a5" },
  ruin: { text: "▲", color: "#efe3c0" },
  lair: { text: "☠", color: "#ff8a7a" },
};

let fogTile: HTMLCanvasElement | null = null;
const fogPatterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();
function fogPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  // patterns are expensive to create and identical for a given tile + ctx:
  // cache one per context instead of rebuilding on every redraw
  const hit = fogPatterns.get(ctx);
  if (hit) return hit;
  if (!fogTile) {
    fogTile = document.createElement("canvas");
    fogTile.width = 12;
    fogTile.height = 12;
    const c = fogTile.getContext("2d");
    if (!c) return null;
    c.fillStyle = "#131022";
    c.fillRect(0, 0, 12, 12);
    c.fillStyle = "#1b1631";
    c.fillRect(2, 3, 2, 1);
    c.fillRect(8, 2, 1, 2);
    c.fillRect(5, 8, 2, 1);
    c.fillRect(10, 9, 1, 1);
    c.fillRect(1, 10, 1, 1);
  }
  const p = ctx.createPattern(fogTile, "repeat");
  if (p) fogPatterns.set(ctx, p);
  return p;
}

export interface MapProps {
  gs: GameState;
  v: number;
  scale: MapScale;
  selected: { x: number; y: number } | null;
  path: [number, number][] | null;
  /** While picking a target: tiles the ordered attack/skill can reach, centered on the ordering monster. */
  reach?: { x: number; y: number; r: number } | null;
  onTap: (x: number, y: number) => void;
}

const REGION_SPAN = 160;
const WORLD_SIZE = 4096;

/**
 * Canvas renderer for the exploration map at all three scales.
 * Renders the player's KNOWLEDGE of the world — never the world itself.
 * LOCAL shows live perception; REGION and WORLD show only what has been
 * explored or discovered, plus transient markers the party can currently see.
 */
export const WorldMap = memo(function WorldMap({ gs, v, scale, selected, path, reach, onTap }: MapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const darkRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [imgTick, setImgTick] = useState<number>(0);
  const [panV, bumpPan] = useState<number>(0);
  const tsRef = useRef<number>(32);
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastPosRef = useRef<{ x: number; y: number }>({ x: gs.player.x, y: gs.player.y });
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    const l = (): void => setImgTick((n) => n + 1);
    const offSprites = onCleanSpriteReady(l);
    const offLooks = onTamerLookReady(l);
    return () => {
      ro.disconnect();
      offSprites();
      offLooks();
    };
  }, []);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !size.w || !size.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.floor(size.w * dpr);
    cv.height = Math.floor(size.h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    const world = getWorld(gs.seed);
    const fac = getFactions(gs.seed, world);
    const net = roadNetworkOf(world);
    const k = gs.knowledge;
    const px = gs.player.x;
    const py = gs.player.y;
    const layer = layerOf(gs);
    const caves = layer < 0;
    const hf = heightOf(world);
    const plv = caves ? 0 : hf.level(px, py);

    if (lastPosRef.current.x !== px || lastPosRef.current.y !== py) {
      lastPosRef.current = { x: px, y: py };
      panRef.current = { x: 0, y: 0 };
    }
    const pan = panRef.current;
    const cell = SCALE_CELL[scale];
    const ts = scale === "local" ? (size.w < 640 ? 34 : 36) : scale === "region" ? (size.w < 640 ? 24 : 28) : size.w < 640 ? 12 : 16;
    tsRef.current = ts;
    const ppu = ts / cell;
    // Center in world TILE coords; region/world loops divide by `cell` to get cell indices.
    const cx = px + pan.x;
    const cy = py + pan.y;
    // publish the camera so the animated effects layer can place particles
    mapCamera.scale = scale;
    mapCamera.w = size.w;
    mapCamera.h = size.h;
    mapCamera.cx = cx;
    mapCamera.cy = cy;
    mapCamera.ts = ts;
    mapCamera.cell = cell;
    mapCamera.layer = layer;
    const halfW = Math.ceil(size.w / 2 / ts) + 1;
    const halfH = Math.ceil(size.h / 2 / ts) + 1;
    const wx2x = (wx: number): number => Math.round(size.w / 2 + (wx - (cx + cell / 2)) * ppu);
    const wy2y = (wy: number): number => Math.round(size.h / 2 + (wy - (cy + cell / 2)) * ppu);

    const vis = computeVisibleFrom(gs, perceptionSources(gs));
    const fp = fogPattern(ctx);
    const drawFog = (X: number, Y: number, w: number, h: number): void => {
      ctx.fillStyle = "#131022";
      ctx.fillRect(X, Y, w, h);
      if (fp) {
        ctx.fillStyle = fp;
        ctx.fillRect(X, Y, w, h);
      }
    };
    /** Pale surf line on land cells that touch water (coastline graphics). */
    const coastEdge = (kind: "world" | "region", tx: number, ty: number, step: number, X: number, Y: number, water: boolean): void => {
      if (water) return;
      const l = sampleCell(kind, world, tx - step, ty);
      const rt = sampleCell(kind, world, tx + step, ty);
      const up = sampleCell(kind, world, tx, ty - step);
      const dn = sampleCell(kind, world, tx, ty + step);
      ctx.fillStyle = "rgba(238,230,200,0.55)";
      if (l.water) ctx.fillRect(X, Y, 1.5, ts);
      if (rt.water) ctx.fillRect(X + ts - 1.5, Y, 1.5, ts);
      if (up.water) ctx.fillRect(X, Y, ts, 1.5);
      if (dn.water) ctx.fillRect(X, Y + ts - 1.5, ts, 1.5);
    };
    const dimMemory = (X: number, Y: number, a: number): void => {
      ctx.fillStyle = `rgba(26,20,48,${a})`;
      ctx.fillRect(X, Y, ts, ts);
    };

    ctx.fillStyle = "#0e0b1d";
    ctx.fillRect(0, 0, size.w, size.h);

    const oob = (tx: number, ty: number): boolean => tx < 0 || ty < 0 || tx >= WORLD_SIZE || ty >= WORLD_SIZE;

    // per-redraw window cache of the heightfield queries the local tile loop
    // makes: one pass over the visible window (+1 tile margin) replaces the
    // ~5 cache lookups every sheer() test needed, ~20 per dressed tile
    let win: { x0: number; y0: number; w: number; h: number; lvl: Int16Array; swim: Uint8Array; ramp: Uint8Array; water: Uint8Array } | null = null;
    if (scale === "local") {
      const x0 = cx - halfW - 1;
      const y0 = cy - halfH - 1;
      const w = 2 * halfW + 3;
      const h = 2 * halfH + 3;
      const lvl = new Int16Array(w * h);
      const swim = new Uint8Array(w * h);
      const ramp = new Uint8Array(w * h);
      const water = new Uint8Array(w * h);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const wx = x0 + xx;
          const wy = y0 + yy;
          const i = yy * w + xx;
          swim[i] = hf.isSwim(wx, wy) ? 1 : 0;
          lvl[i] = hf.level(wx, wy);
          ramp[i] = hf.isRamp(wx, wy) ? 1 : 0;
          water[i] = hf.isWater(wx, wy) ? 1 : 0;
        }
      }
      win = { x0, y0, w, h, lvl, swim, ramp, water };
    }
    const winIdx = (x: number, y: number): number => (y - win!.y0) * win!.w + (x - win!.x0);
    const inWin = (x: number, y: number): boolean => !!win && x >= win.x0 && y >= win.y0 && x < win.x0 + win.w && y < win.y0 + win.h;
    const lvlAt = (x: number, y: number): number => (inWin(x, y) ? win!.lvl[winIdx(x, y)] : hf.level(x, y));
    const swimAt = (x: number, y: number): boolean => (inWin(x, y) ? win!.swim[winIdx(x, y)] === 1 : hf.isSwim(x, y));
    const rampAt = (x: number, y: number): boolean => (inWin(x, y) ? win!.ramp[winIdx(x, y)] === 1 : hf.isRamp(x, y));
    const waterAt = (x: number, y: number): boolean => (inWin(x, y) ? win!.water[winIdx(x, y)] === 1 : hf.isWater(x, y));

    /** A sheer drop from (hx,hy) down to (lx,ly): two+ levels, or one level that is not a slope. */
    const sheer = (hx: number, hy: number, lx: number, ly: number): number => {
      if (swimAt(hx, hy) || swimAt(lx, ly)) return 0;
      const d = lvlAt(hx, hy) - lvlAt(lx, ly);
      return d >= 2 || (d === 1 && !rampAt(hx, hy)) ? d : 0;
    };
    /** 2.5D height dressing for one surface tile: depth tint, slopes, the rock face of higher ground to the north, side shadows, rim highlights. */
    const drawHeight = (x: number, y: number, X: number, Y: number, variant: number): void => {
      if (swimAt(x, y)) return;
      const L = lvlAt(x, y);
      const rel = Math.max(-4, Math.min(4, L - plv));
      if (rel > 0) {
        ctx.fillStyle = `rgba(255,244,214,${(rel * 0.04).toFixed(3)})`;
        ctx.fillRect(X, Y, ts, ts);
      } else if (rel < 0) {
        ctx.fillStyle = `rgba(18,12,40,${(-rel * 0.07).toFixed(3)})`;
        ctx.fillRect(X, Y, ts, ts);
      }
      if (rampAt(x, y)) ctx.drawImage(rampMarkTex(), X, Y, ts, ts);
      // the face of raised ground to the north, standing on this tile
      if (!swimAt(x, y - 1)) {
        const d = lvlAt(x, y - 1) - L;
        if (d >= 1) {
          const style = cliffStyle(world.tile(x, y - 1).biome);
          let frac: number;
          if (d === 1 && rampAt(x, y - 1)) {
            const bank = waterAt(x, y) || waterAt(x, y - 1);
            frac = bank ? 0.26 : 0.44;
            const tex = bank ? cliffFaceTex("earth", variant) : stairsTex(style);
            ctx.drawImage(tex, 0, 0, 16, Math.round(16 * frac), X, Y, ts, ts * frac);
          } else {
            frac = Math.min(0.96, 0.46 + 0.17 * (d - 1));
            ctx.drawImage(cliffFaceTex(style, variant), 0, 0, 16, Math.round(16 * frac), X, Y, ts, ts * frac);
          }
          ctx.fillStyle = "rgba(10,8,20,0.24)";
          ctx.fillRect(X, Y + ts * frac, ts, ts * 0.12);
        }
      }
      const edge = Math.max(2, Math.round(ts * 0.07));
      // higher ground to the west casts a soft shadow; to the east, a dark side wall
      if (sheer(x - 1, y, x, y)) {
        ctx.fillStyle = "rgba(10,8,20,0.26)";
        ctx.fillRect(X, Y, ts * 0.22, ts);
        ctx.fillStyle = "rgba(10,8,20,0.4)";
        ctx.fillRect(X, Y, edge, ts);
      }
      if (sheer(x + 1, y, x, y)) {
        ctx.fillStyle = "rgba(10,8,20,0.34)";
        ctx.fillRect(X + ts - edge, Y, edge, ts);
      }
      // lit rims along the top edge of every cliff this tile crowns
      ctx.fillStyle = "rgba(255,246,220,0.38)";
      if (sheer(x, y, x, y + 1)) ctx.fillRect(X, Y + ts - edge, ts, edge);
      if (sheer(x, y, x - 1, y)) ctx.fillRect(X, Y, edge, ts);
      if (sheer(x, y, x + 1, y)) ctx.fillRect(X + ts - edge, Y, edge, ts);
      if (hf.isMouth(x, y)) ctx.drawImage(caveMouthTex(), X, Y, ts, ts);
    };
    /** One sky tile: high air with cloud banks, wisps, and thermal updrafts. */
    const drawSky = (x: number, y: number, X: number, Y: number, variant: number): void => {
      ctx.drawImage(skyTex(hf.skyDecor(x, y), variant), X, Y, ts, ts);
    };
    /** One underwater tile: seafloor where deep water sits above, pressed rock elsewhere. */
    const drawUw = (x: number, y: number, X: number, Y: number, variant: number): void => {
      if (!hf.uwOpen(x, y)) {
        ctx.drawImage(uwWallTex(variant), X, Y, ts, ts);
        return;
      }
      ctx.drawImage(uwFloorTex(hf.uwFresh(x, y), hf.uwDecor(x, y), variant), X, Y, ts, ts);
      if (!hf.uwOpen(x, y - 1)) {
        ctx.fillStyle = "rgba(6,16,28,0.55)";
        ctx.fillRect(X, Y, ts, ts * 0.3);
      }
    };
    /** One underground tile: rock, or floor with the north wall's face, side shadows, exits and shafts. */
    const drawCave = (x: number, y: number, X: number, Y: number, variant: number): void => {
      if (!hf.caveOpen(layer, x, y)) {
        ctx.drawImage(caveWallTex(layer, variant), X, Y, ts, ts);
        return;
      }
      ctx.drawImage(caveFloorTex(layer, hf.caveDecor(layer, x, y)), X, Y, ts, ts);
      if (!hf.caveOpen(layer, x, y - 1)) ctx.drawImage(caveFaceTex(layer, variant), 0, 0, 16, 7, X, Y, ts, (ts * 7) / 16);
      const edge = Math.max(2, Math.round(ts * 0.1));
      if (!hf.caveOpen(layer, x - 1, y)) {
        ctx.fillStyle = "rgba(4,3,10,0.5)";
        ctx.fillRect(X, Y, edge, ts);
      }
      if (!hf.caveOpen(layer, x + 1, y)) {
        ctx.fillStyle = "rgba(4,3,10,0.34)";
        ctx.fillRect(X + ts - edge, Y, edge, ts);
      }
      if (layer === CAVE_UPPER && hf.isMouth(x, y)) ctx.drawImage(caveExitTex(), X, Y, ts, ts);
      else if (hf.isShaft(x, y)) ctx.drawImage(shaftTex(layer === CAVE_DEEP), X, Y, ts, ts);
    };

    if (scale === "local") {
      for (let y = cy - halfH; y <= cy + halfH; y++) {
        for (let x = cx - halfW; x <= cx + halfW; x++) {
          const X = wx2x(x);
          const Y = wy2y(y);
          if (oob(x, y)) {
            drawFog(X, Y, ts, ts);
            continue;
          }
          const visHere = vis.has(y * WORLD_SIZE + x);
          const mem = !visHere && isExploredOn(k, layer, x, y);
          if (!visHere && !mem) {
            drawFog(X, Y, ts, ts);
            continue;
          }
          const variant = hash2(gs.seed, x, y) % 4;
          if (layer === SKY) {
            drawSky(x, y, X, Y, variant);
            if (mem) dimMemory(X, Y, 0.58);
            continue;
          }
          if (layer === UW) {
            drawUw(x, y, X, Y, variant);
            if (mem) dimMemory(X, Y, 0.58);
            continue;
          }
          if (caves) {
            drawCave(x, y, X, Y, variant);
            if (mem) dimMemory(X, Y, 0.58);
            continue;
          }
          const t = world.tile(x, y);
          ctx.drawImage(biomeTex(t.biome, variant), X, Y, ts, ts);
          const sp = world.siteAt(x, y);
          if (sp) {
            const stier = settlementTier(sp);
            if (sp.post) {
              // a gatepost is a structure, not a texture: solid footing, a lit
              // face, a cap — timber in a hamlet, stonework in a town or city
              const stone = stier !== null && stier !== "hamlet";
              ctx.fillStyle = "rgba(10,8,20,0.3)";
              ctx.fillRect(X + ts * 0.18, Y + ts * 0.84, ts * 0.64, ts * 0.14);
              ctx.fillStyle = stone ? "#8f8577" : "#6a4a2c";
              ctx.fillRect(X + ts * 0.32, Y + ts * 0.1, ts * 0.36, ts * 0.78);
              ctx.fillStyle = stone ? "#b3a894" : "#8a6238";
              ctx.fillRect(X + ts * 0.32, Y + ts * 0.1, ts * 0.13, ts * 0.78);
              ctx.fillStyle = stone ? "#5c554a" : "#4a331e";
              ctx.fillRect(X + ts * 0.24, Y + ts * 0.02, ts * 0.52, ts * 0.14);
            } else {
              const st = sp.wall ? (stier ? settlementWallTerrain(stier) : "wall") : sp.door ? "door" : sp.rubble ? "rubble" : "floor";
              const sv = st === "floor" ? (isSettlement(sp) ? 1 : sp.kind === "lair" ? 2 : 0) : 0;
              ctx.drawImage(terrainTex(st, sv), X, Y, ts, ts);
            }
          }
          // the road and the building paths run over open ground, under cliffs and feature glyphs
          const road = !caves ? roadAt(world, x, y) : null;
          const path = !road && !caves && pathAt(world, x, y);
          if (road) ctx.drawImage(bridgeAt(world, x, y) ? bridgeTex(variant) : roadTex(road, variant), X, Y, ts, ts);
          else if (path) ctx.drawImage(pathTex(variant), X, Y, ts, ts);
          // a settlement's deliberate entrances read as real gates: the solid
          // gateposts (site layer — they block the walker and the bolt alike)
          // flank the approach, and a lintel spans the entrance tile above the
          // road — timber in a hamlet, stonework in a town or city
          if (!caves) {
            const ent = settlementEntranceAt(net, x, y);
            const node = ent ? net.byId.get(ent.settlement) : null;
            if (ent && node && (visHere || k.discovered[`f:${node.x}:${node.y}`])) {
              ctx.fillStyle = node.tier === "hamlet" ? "#4a331e" : "#5c554a";
              const beam = Math.max(2, Math.round(ts * 0.13));
              if (ent.dir === "n" || ent.dir === "s") {
                ctx.fillRect(X + ts * 0.18, ent.dir === "n" ? Y + ts * 0.03 : Y + ts * 0.84, ts * 0.64, beam);
              } else {
                ctx.fillRect(ent.dir === "w" ? X + ts * 0.03 : X + ts * 0.84, Y + ts * 0.18, beam, ts * 0.64);
              }
            }
          }
          drawHeight(x, y, X, Y, variant);
          // a rising thermal a flier could catch — marked only where visible
          if (visHere && hf.thermalAt(x, y)) ctx.drawImage(thermalMarkTex(), X, Y, ts, ts);
          // physical objects stand up from the ground, canopies overlapping the tile behind them
          const ob = objectAt(world, x, y);
          if (ob) ctx.drawImage(objectTex(ob, variant), X, Y - ts * 0.25, ts, ts);
          // forage plants are physical: ripe where food grows, a grazed stub where picked clean
          if (visHere && !ob && !t.feature && !world.siteAt(x, y)?.wall) {
            const fi = world.forage(x, y, gs.tick, gs.depleted);
            if (fi) ctx.drawImage(forageTex(fi, 0), X, Y, ts, ts);
            else {
              const dep = gs.depleted[`${x},${y}`];
              if (dep !== undefined && gs.tick - dep < DAY_TICKS * 2) ctx.drawImage(forageTex("berries", 1), X, Y, ts, ts);
            }
          }
          const known = t.feature && (visHere || k.discovered[`f:${t.feature.x}:${t.feature.y}`]);
          // the lair's alpha body replaces the center icon on visible tiles
          if (t.feature && known && !(t.feature.kind === "lair" && visHere)) ctx.drawImage(featureTex(t.feature.kind), X, Y, ts, ts);
          if (mem) dimMemory(X, Y, 0.52);
        }
      }

      for (const d of caves ? [] : discoveredList(k)) {
        if (Math.abs(d.x - cx) > halfW || Math.abs(d.y - cy) > halfH) continue;
        if (vis.has(d.y * WORLD_SIZE + d.x)) continue;
        const X = wx2x(d.x);
        const Y = wy2y(d.y);
        ctx.globalAlpha = 0.55;
        ctx.drawImage(featureTex(d.kind), X, Y, ts, ts);
        ctx.globalAlpha = 1;
      }

      // targeting reach: tint every tile the ordered attack or skill can reach
      if (reach) {
        for (let y = reach.y - reach.r; y <= reach.y + reach.r; y++) {
          for (let x = reach.x - reach.r; x <= reach.x + reach.r; x++) {
            if (oob(x, y) || !vis.has(y * WORLD_SIZE + x)) continue;
            const ring = Math.max(Math.abs(x - reach.x), Math.abs(y - reach.y)) === reach.r;
            ctx.fillStyle = ring ? "rgba(242,140,42,0.38)" : "rgba(242,140,42,0.18)";
            ctx.fillRect(wx2x(x), wy2y(y), ts, ts);
          }
        }
      }

      if (path && path.length) {
        ctx.fillStyle = "rgba(242,193,78,0.85)";
        for (const [x, y] of path) ctx.fillRect(wx2x(x) + ts / 2 - 2, wy2y(y) + ts / 2 - 2, 4, 4);
      }

      // nests: persistent world objects — a developing clutch shows through
      for (const nest of Object.values(gs.nests)) {
        if (nest.state === "destroyed" || (nest.layer ?? 0) !== layer) continue;
        if (Math.abs(nest.x - px) > halfW + 2 || Math.abs(nest.y - py) > halfH + 2) continue;
        if (!vis.has(nest.y * WORLD_SIZE + nest.x)) continue;
        const hasClutch = nest.developmentIds.some((id) => gs.developments[id]?.state === "developing");
        const im = getCleanSprite(hasClutch ? NEST_ART.nest_eggs : NEST_ART.nest);
        if (!im) continue;
        const nw = ts * 1.3;
        const nh = (nw * im.height) / im.width;
        const NX = wx2x(nest.x);
        const NY = wy2y(nest.y);
        ctx.globalAlpha = nest.state === "abandoned" ? 0.55 : 1;
        ctx.drawImage(im, NX + (ts - nw) / 2, NY + ts - nh - ts * 0.06, nw, nh);
        ctx.globalAlpha = 1;
      }

      // remembered nests: ones you have charted before, dimmed under the fog
      for (const nest of Object.values(gs.nests)) {
        if (nest.state === "destroyed" || (nest.layer ?? 0) !== layer) continue;
        if (vis.has(nest.y * WORLD_SIZE + nest.x)) continue;
        if (!k.nestsSeen?.[nest.id]) continue;
        if (Math.abs(nest.x - px) > halfW + 2 || Math.abs(nest.y - py) > halfH + 2) continue;
        const im = getCleanSprite(NEST_ART.nest);
        if (!im) continue;
        const nw = ts * 1.3;
        const nh = (nw * im.height) / im.width;
        ctx.globalAlpha = 0.42;
        ctx.drawImage(im, wx2x(nest.x) + (ts - nw) / 2, wy2y(nest.y) + ts - nh - ts * 0.06, nw, nh);
        ctx.globalAlpha = 1;
      }

      const shadow = (X: number, Y: number, w: number): void => {
        ctx.fillStyle = "rgba(10,8,20,0.35)";
        ctx.beginPath();
        ctx.ellipse(X + ts / 2, Y + ts * 0.88, w, ts * 0.11, 0, 0, Math.PI * 2);
        ctx.fill();
      };

      // the fallen feed the living: carrion lies where a body died
      for (const item of Object.values(gs.carrion ?? {})) {
        if ((item.layer ?? 0) !== layer) continue;
        if (Math.abs(item.x - px) > halfW + 2 || Math.abs(item.y - py) > halfH + 2) continue;
        if (!vis.has(item.y * WORLD_SIZE + item.x)) continue;
        const CX = wx2x(item.x);
        const CY = wy2y(item.y);
        shadow(CX, CY, ts * 0.18);
        const cw = ts * 0.62;
        ctx.drawImage(carrionTex(carrionStage(gs, item)), CX + (ts - cw) / 2, CY + ts * 0.36, cw, cw);
      }

      // the real party — monsters are bodies on the map, trailing the player
      for (const m of gs.party) {
        const pos = gs.field[m.uid];
        if (!pos) continue;
        if (Math.abs(pos.x - px) > halfW + 2 || Math.abs(pos.y - py) > halfH + 2) continue;
        const pf = bodyFootprint(m, gs.tick);
        const moff = moveOffset(`p:${m.uid}`);
        const X = wx2x(pos.x + moff.dx);
        const Y = wy2y(pos.y + moff.dy);
        const pw = pf >= 4 ? ts * 3.4 : pf === 3 ? ts * 2.5 : pf === 2 ? ts * 1.6 : ts * 0.78;
        shadow(X + (pf - 1) * ts * 0.5, Y + (pf - 1) * ts, pw * 0.38);
        const im = getCleanSprite(MONSTER_ART[m.speciesId]);
        ctx.globalAlpha = m.hp > 0 ? 1 : 0.42;
        if (im) ctx.drawImage(im, X + (pf * ts - pw) / 2, Y + pf * ts - pw - ts * 0.06, pw, pw);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = m.hp > 0 ? "rgba(63,184,165,0.85)" : "rgba(150,150,165,0.8)";
        ctx.lineWidth = 2;
        ctx.strokeRect(X + 1, Y + 1, pf * ts - 2, pf * ts - 2);
        const hpMax = statOf(m, "hp");
        const frac = Math.max(0, Math.min(1, m.hp / hpMax));
        const bw = pf * ts - 8;
        ctx.fillStyle = "rgba(10,8,20,0.75)";
        ctx.fillRect(X + 4, Y - 5, bw, 3);
        ctx.fillStyle = frac > 0.55 ? "#7be08a" : frac > 0.25 ? "#f2c14e" : "#ff6b5a";
        ctx.fillRect(X + 4, Y - 5, bw * frac, 3);
      }

      for (const id in gs.creatures) {
        const c = gs.creatures[id];
        if (Math.abs(c.x - px) > halfW + 2 || Math.abs(c.y - py) > halfH + 2) continue;
        if (!seesCreature(gs, c)) continue;
        const im = getCleanSprite(MONSTER_ART[c.speciesId]);
        const coff = moveOffset(c.id);
        const X = wx2x(c.x + coff.dx);
        const Y = wy2y(c.y + coff.dy);
        const f = bodyFootprint(c, gs.tick);
        const sc = (c.alpha ? 1.05 : 0.82) * (0.85 + SPECIES[c.speciesId].size * 0.07);
        const w = f >= 4 ? ts * (c.alpha ? 3.55 : 3.4) : f === 3 ? ts * (c.alpha ? 2.7 : 2.55) : f === 2 ? ts * (c.alpha ? 1.8 : 1.66) : ts * sc;
        shadow(X + (f - 1) * ts * 0.5, Y + (f - 1) * ts, w * 0.38);
        if (gs.tracked === c.id) {
          ctx.strokeStyle = "#b478ff";
          ctx.lineWidth = 3;
          ctx.strokeRect(X - 1, Y - 1, f * ts + 2, f * ts + 2);
        }
        if (c.stalking) {
          ctx.strokeStyle = "rgba(255,90,80,0.9)";
          ctx.lineWidth = 2;
          ctx.strokeRect(X + 1, Y + 1, f * ts - 2, f * ts - 2);
        }
        if (im) {
          ctx.globalAlpha = c.activity === "Sleeping" ? 0.8 : 1;
          ctx.drawImage(im, X + (f * ts - w) / 2, Y + f * ts - w - ts * 0.06, w, w);
          ctx.globalAlpha = 1;
        }
        ctx.font = `bold ${Math.round(ts * 0.36)}px "Pixelify Sans", monospace`;
        ctx.textAlign = "center";
        if (c.activity === "Sleeping") {
          ctx.fillStyle = "#e7eef2";
          ctx.fillText("z", X + ts * 0.86, Y + ts * 0.3);
        } else if (c.stalking) {
          ctx.fillStyle = "#ff5a50";
          ctx.fillText("!", X + ts * 0.86, Y + ts * 0.32);
        }
        if (c.alpha) {
          ctx.fillStyle = "#f2c14e";
          ctx.fillText("♛", X + ts * 0.18, Y + ts * 0.32);
        }
        if (c.stalking || c.hpFrac < 1) {
          const frac = Math.max(0, Math.min(1, c.hpFrac));
          const bw = f * ts - 8;
          ctx.fillStyle = "rgba(10,8,20,0.75)";
          ctx.fillRect(X + 4, Y - 5, bw, 3);
          ctx.fillStyle = frac > 0.55 ? "#7be08a" : frac > 0.25 ? "#f2c14e" : "#ff6b5a";
          ctx.fillRect(X + 4, Y - 5, bw * frac, 3);
        }
      }

      // the folk of the road and the green share one body: shadow, art (or
      // the fallback pixel person), and a name when selected
      const drawFolk = (n: Npc): void => {
        const X = wx2x(n.x);
        const Y = wy2y(n.y);
        shadow(X, Y, ts * 0.24);
        const im = getCleanSprite(NPC_ART[n.role]);
        if (im) {
          const h = ts * 1.42;
          const w = (h * im.width) / im.height;
          ctx.drawImage(im, X + (ts - w) / 2, Y + ts * 1.04 - h, w, h);
        } else {
          const roleCol = n.role === "innkeep" ? "#b23a48" : n.role === "trader" ? "#e8a02b" : n.role === "recruiter" ? "#c9a227" : n.role === "resident" ? "#8a7a5a" : n.role === "traveler" ? "#6b7a8a" : "#3fb8a5";
          ctx.fillStyle = "#3a2c20";
          ctx.fillRect(X + ts * 0.37, Y + ts * 0.64, ts * 0.1, ts * 0.2);
          ctx.fillRect(X + ts * 0.53, Y + ts * 0.64, ts * 0.1, ts * 0.2);
          ctx.fillStyle = roleCol;
          ctx.fillRect(X + ts * 0.32, Y + ts * 0.36, ts * 0.36, ts * 0.32);
          ctx.fillStyle = "#e8c49a";
          ctx.fillRect(X + ts * 0.36, Y + ts * 0.16, ts * 0.28, ts * 0.22);
        }
        if (selected && selected.x === n.x && selected.y === n.y) {
          ctx.font = `bold ${Math.round(ts * 0.34)}px "Pixelify Sans", monospace`;
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(10,8,20,0.85)";
          ctx.strokeText(n.name, X + ts / 2, Y - ts * 0.06);
          ctx.fillStyle = "#fff4dc";
          ctx.fillText(n.name, X + ts / 2, Y - ts * 0.06);
        }
      };
      // hamlet folk at their posts
      ctx.textAlign = "center";
      for (const f of caves ? [] : world.featuresNear(px, py, 40)) {
        if (!isSettlement(f)) continue;
        if (!k.discovered[`f:${f.x}:${f.y}`] && !vis.has(f.y * WORLD_SIZE + f.x)) continue;
        for (const n of world.settlementPopulation(f, gs.tick)) {
          if (!vis.has(n.y * WORLD_SIZE + n.x)) continue;
          drawFolk(n);
        }
      }

      // travelers on the roads between settlements — transient bodies, seen
      // only while in sight, like every other living thing
      for (const n of caves ? [] : world.roadTravelers(gs.tick)) {
        if (Math.abs(n.x - px) > halfW + 2 || Math.abs(n.y - py) > halfH + 2) continue;
        if (!vis.has(n.y * WORLD_SIZE + n.x)) continue;
        drawFolk(n);
      }

      // rival tamers — persistent world participants drawn from their own
      // illustrated sprite, exactly like the folk: shadow, art, and a name
      // when you stand close enough to trade glares. Feet sit on the tile.
      ctx.textAlign = "center";
      for (const t of caves ? [] : Object.values(gs.tamers ?? {})) {
        if (t.layer !== layer) continue;
        if (Math.abs(t.x - px) > halfW + 2 || Math.abs(t.y - py) > halfH + 2) continue;
        const X = wx2x(t.x);
        const Y = wy2y(t.y);
        shadow(X, Y, ts * 0.28);
        const n = Number(t.id.slice(1));
        const im = Number.isInteger(n) && n >= 1 && n <= RIVAL_ART.length ? getCleanSprite(RIVAL_ART[n - 1]) : null;
        if (im) {
          const h = ts * 1.42;
          const w = (h * im.width) / im.height;
          ctx.drawImage(im, X + (ts - w) / 2, Y + ts * 1.04 - h, w, h);
        } else {
          // fallback figure while parts load (or if an asset is unavailable)
          ctx.fillStyle = "#3a2c20";
          ctx.fillRect(X + ts * 0.3, Y + ts * 0.66, ts * 0.4, ts * 0.22);
          ctx.fillStyle = t.scarf;
          ctx.fillRect(X + ts * 0.3, Y + ts * 0.56, ts * 0.4, ts * 0.12);
          ctx.fillStyle = "#e8c49a";
          ctx.fillRect(X + ts * 0.34, Y + ts * 0.3, ts * 0.32, ts * 0.26);
          ctx.fillStyle = "#3a2c20";
          ctx.fillRect(X + ts * 0.3, Y + ts * 0.22, ts * 0.4, ts * 0.12);
        }
        if (Math.max(Math.abs(t.x - px), Math.abs(t.y - py)) <= 12) {
          ctx.font = `bold ${Math.round(ts * 0.3)}px "Pixelify Sans", monospace`;
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(10,8,20,0.85)";
          ctx.strokeText(t.name, X + ts / 2, Y - ts * 0.44);
          ctx.fillStyle = t.scarf;
          ctx.fillText(t.name, X + ts / 2, Y - ts * 0.44);
        }
      }

      {
        const X = wx2x(px);
        const Y = wy2y(py);
        shadow(X, Y, ts * 0.32);
        const im = getLookSprite(gs.player.look);
        if (im) {
          // same in-world height as the rivals: the composed look, feet at the tile
          const h = ts * 1.42;
          const w = (im.width / im.height) * h;
          ctx.drawImage(im, X + (ts - w) / 2, Y + ts * 1.02 - h, w, h);
        } else {
          // parts still loading or unavailable: a simple hooded figure
          ctx.fillStyle = "#3a3450";
          ctx.beginPath();
          ctx.roundRect(X + ts * 0.28, Y + ts * 0.3, ts * 0.44, ts * 0.72, ts * 0.18);
          ctx.fill();
        }
      }

      if (selected) {
        const X = wx2x(selected.x);
        const Y = wy2y(selected.y);
        const L = Math.round(ts * 0.32);
        ctx.strokeStyle = "#fff4dc";
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (const [cx2, cy2, dx, dy] of [[X, Y, 1, 1], [X + ts, Y, -1, 1], [X, Y + ts, 1, -1], [X + ts, Y + ts, -1, -1]]) {
          ctx.moveTo(cx2 + dx * L, cy2);
          ctx.lineTo(cx2, cy2);
          ctx.lineTo(cx2, cy2 + dy * L);
        }
        ctx.stroke();
      }

      // party target reticle
      const tgt = gs.target ? gs.creatures[gs.target] : null;
      if (tgt && Math.abs(tgt.x - px) <= halfW + 2 && Math.abs(tgt.y - py) <= halfH + 2) {
        const tf = bodyFootprint(tgt, gs.tick);
        const TX = wx2x(tgt.x);
        const TY = wy2y(tgt.y);
        const L = Math.round(ts * 0.36);
        ctx.strokeStyle = "#ff5a50";
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (const [cx2, cy2, dx, dy] of [[TX, TY, 1, 1], [TX + tf * ts, TY, -1, 1], [TX, TY + tf * ts, 1, -1], [TX + tf * ts, TY + tf * ts, -1, -1]]) {
          ctx.moveTo(cx2 + dx * L, cy2);
          ctx.lineTo(cx2, cy2);
          ctx.lineTo(cx2, cy2 + dy * L);
        }
        ctx.stroke();
      }

      // damage / heal / status popups
      ctx.textAlign = "center";
      for (const f of activeFx(gs.tick)) {
        if (Math.abs(f.x - px) > halfW || Math.abs(f.y - py) > halfH) continue;
        const age = gs.tick - f.tick;
        const X = wx2x(f.x) + ts / 2;
        const Y = wy2y(f.y) - age * ts * 0.55;
        ctx.font = `bold ${Math.round(ts * 0.42)}px "Pixelify Sans", monospace`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(10,8,20,0.9)";
        ctx.strokeText(f.text, X, Y);
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, X, Y);
      }

      const time = timeOf(gs.tick);
      // underground it is always dark beyond your own small circle of light
      const darkness = caves ? 1 : 1 - time.daylight;
      if (darkness > 0.04) {
        if (!darkRef.current) darkRef.current = document.createElement("canvas");
        const dk = darkRef.current;
        // only resize when the viewport changed — reassigning width/height
        // reallocates the backing store on every redraw
        if (dk.width !== size.w || dk.height !== size.h) {
          dk.width = size.w;
          dk.height = size.h;
        }
        const d = dk.getContext("2d");
        if (d) {
          const a = caves ? 0.8 : Math.min(0.7, darkness * 0.66);
          d.fillStyle = `rgba(14,10,38,${a})`;
          d.fillRect(0, 0, size.w, size.h);
          d.globalCompositeOperation = "destination-out";
          const ccx = size.w / 2;
          const ccy = size.h / 2;
          const g = d.createRadialGradient(ccx, ccy, ts * 0.8, ccx, ccy, ts * 4.4);
          g.addColorStop(0, "rgba(0,0,0,0.92)");
          g.addColorStop(0.7, "rgba(0,0,0,0.6)");
          g.addColorStop(1, "rgba(0,0,0,0)");
          d.fillStyle = g;
          d.fillRect(0, 0, size.w, size.h);
          d.globalCompositeOperation = "source-over";
          ctx.drawImage(dk, 0, 0);
          if (caves || time.phase === "Night" || time.phase === "Dusk") {
            const warm = ctx.createRadialGradient(ccx, ccy, 0, ccx, ccy, ts * 2.4);
            warm.addColorStop(0, "rgba(255,160,70,0.16)");
            warm.addColorStop(1, "rgba(255,160,70,0)");
            ctx.fillStyle = warm;
            ctx.fillRect(0, 0, size.w, size.h);
          }
        }
      }
      if (!caves && (time.phase === "Dusk" || time.phase === "Dawn")) {
        ctx.fillStyle = time.phase === "Dusk" ? "rgba(232,116,42,0.10)" : "rgba(255,200,170,0.08)";
        ctx.fillRect(0, 0, size.w, size.h);
      }
    } else {
      /* ------------------------------ REGION / WORLD ------------------------------ */
      const isWorld = scale === "world";
      const exploredW = isWorld ? exploredWorldCells(k) : null;
      const ccx = cx / cell;
      const ccy = cy / cell;

      for (let gy = Math.floor(ccy) - halfH; gy <= Math.floor(ccy) + halfH; gy++) {
        for (let gx = Math.floor(ccx) - halfW; gx <= Math.floor(ccx) + halfW; gx++) {
          const tx = gx * cell;
          const ty = gy * cell;
          const X = wx2x(tx);
          const Y = wy2y(ty);
          if (oob(tx, ty)) {
            drawFog(X, Y, ts, ts);
            continue;
          }
          const off = cell >> 1;
          const visHere = vis.has((ty + off) * WORLD_SIZE + tx + off);
          const mem = !visHere && (isWorld ? exploredW!.has(gy * 128 + gx) : anyExplored(k, tx, ty, tx + cell - 1, ty + cell - 1));
          if (!visHere && !mem) {
            drawFog(X, Y, ts, ts);
            continue;
          }
          const kind = isWorld ? ("world" as const) : ("region" as const);
          const s = sampleCell(kind, world, tx, ty);
          if (s.water) {
            ctx.fillStyle = BIOMES[s.biome].color;
            ctx.fillRect(X, Y, ts, ts);
          } else if (isWorld) {
            ctx.drawImage(worldTex(s.biome, hash2(gs.seed, gx, gy) % 4), X, Y, ts, ts);
            // terrace bands: low ground darker, high ground brighter, a hard line where a band steps up
            const tint = (s.level - 4) * 0.035;
            ctx.fillStyle = tint > 0 ? `rgba(255,244,220,${Math.min(0.32, tint).toFixed(3)})` : `rgba(18,12,40,${Math.min(0.22, -tint).toFixed(3)})`;
            ctx.fillRect(X, Y, ts, ts);
            const north = sampleCell(kind, world, tx, ty - cell);
            if (!north.water && north.level >= s.level + 2) {
              ctx.fillStyle = "rgba(40,28,24,0.55)";
              ctx.fillRect(X, Y, ts, Math.max(2, ts * 0.18));
            }
            if (s.canyon) {
              ctx.fillStyle = "rgba(70,40,30,0.7)";
              ctx.fillRect(X + ts * 0.3, Y + ts * 0.3, ts * 0.4, ts * 0.4);
            }
            if (s.river) {
              ctx.fillStyle = "rgba(76,147,201,0.9)";
              ctx.fillRect(X + 1, Y + ts * 0.38, ts - 2, ts * 0.26);
              ctx.fillStyle = "rgba(168,212,238,0.55)";
              ctx.fillRect(X + 1, Y + ts * 0.46, ts - 2, ts * 0.08);
            }
            coastEdge(kind, tx, ty, cell, X, Y, s.water);
          } else {
            ctx.drawImage(biomeTex(s.biome, hash2(gs.seed, gx, gy) % 4), X, Y, ts, ts);
            if (s.river) {
              ctx.fillStyle = "rgba(76,147,201,0.9)";
              ctx.fillRect(X + ts * 0.34, Y, ts * 0.32, ts);
            } else {
              // same terraces as the local map: depth tint, a rock face where the cell to the north stands higher, canyon floors
              const n = sampleCell("region", world, tx, ty - cell);
              const tint = (s.level - plv) * 0.045;
              if (tint > 0) ctx.fillStyle = `rgba(255,244,214,${Math.min(0.26, tint).toFixed(3)})`;
              else ctx.fillStyle = `rgba(18,12,40,${Math.min(0.3, -tint).toFixed(3)})`;
              ctx.fillRect(X, Y, ts, ts);
              const d = n.water ? 0 : n.level - s.level;
              if (d >= 1) {
                const frac = Math.min(0.6, 0.18 + d * 0.12);
                ctx.drawImage(cliffFaceTex(cliffStyle(n.biome), hash2(gs.seed, gx, gy) % 4), 0, 0, 16, Math.round(16 * frac), X, Y, ts, ts * frac);
              }
              if (s.canyon) {
                ctx.fillStyle = "rgba(60,34,26,0.32)";
                ctx.fillRect(X, Y, ts, ts);
              }
            }
            coastEdge(kind, tx, ty, cell, X, Y, s.water);
          }
          // heraldic wash over learned territory (terrain still reads through)
          const nat = fac.nationAt(tx + off, ty + off);
          if (nat && k.nationsSeen[nat.id]) {
            ctx.globalAlpha = 0.16;
            ctx.fillStyle = nat.color;
            ctx.fillRect(X, Y, ts, ts);
            ctx.globalAlpha = 1;
          }
          if (!visHere && mem) dimMemory(X, Y, isWorld ? 0.34 : 0.42);
        }
      }

      // charted cave mouths: a dark opening pinned inside their cell
      if (!caves && k.mouthsSeen) {
        for (const m of Object.values(k.mouthsSeen)) {
          const gx = Math.floor(m.x / cell);
          const gy = Math.floor(m.y / cell);
          if (gx < Math.floor(ccx) - halfW || gx > Math.floor(ccx) + halfW) continue;
          if (gy < Math.floor(ccy) - halfH || gy > Math.floor(ccy) + halfH) continue;
          const X = wx2x(m.x) - ts / 2;
          const Y = wy2y(m.y) - ts / 2;
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = "#120c16";
          ctx.fillRect(X + ts * 0.28, Y + ts * 0.42, ts * 0.44, ts * 0.34);
          ctx.fillStyle = "rgba(226,200,150,0.5)";
          ctx.fillRect(X + ts * 0.36, Y + ts * 0.42, ts * 0.28, ts * 0.07);
          ctx.globalAlpha = 1;
        }
      }

      // borders: crisp lines only where territories (or a frontier) change hands
      const fc0x = Math.floor((cx - halfW * cell) / FACTION_CELL) - 1;
      const fc1x = Math.floor((cx + halfW * cell) / FACTION_CELL) + 1;
      const fc0y = Math.floor((cy - halfH * cell) / FACTION_CELL) - 1;
      const fc1y = Math.floor((cy + halfH * cell) / FACTION_CELL) + 1;
      ctx.lineWidth = isWorld ? 2 : 1.5;
      for (let fy = fc0y; fy <= fc1y; fy++) {
        for (let fx = fc0x; fx <= fc1x; fx++) {
          const nat = fac.nationAtCell(fx, fy);
          if (!nat || !k.nationsSeen[nat.id]) continue;
          const X0 = wx2x(fx * FACTION_CELL);
          const Y0 = wy2y(fy * FACTION_CELL);
          const X1 = wx2x((fx + 1) * FACTION_CELL);
          const Y1 = wy2y((fy + 1) * FACTION_CELL);
          const right = fac.nationAtCell(fx + 1, fy);
          const left = fac.nationAtCell(fx - 1, fy);
          const up = fac.nationAtCell(fx, fy - 1);
          const down = fac.nationAtCell(fx, fy + 1);
          const foreign = (o: typeof nat, ox: number, oy: number): boolean => (o ? o.id !== nat.id : fac.claimableCell(ox, oy));
          ctx.strokeStyle = nat.color;
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          if (foreign(right, fx + 1, fy)) { ctx.moveTo(X1, Y0); ctx.lineTo(X1, Y1); }
          if (foreign(left, fx - 1, fy)) { ctx.moveTo(X0, Y0); ctx.lineTo(X0, Y1); }
          if (foreign(down, fx, fy + 1)) { ctx.moveTo(X0, Y1); ctx.lineTo(X1, Y1); }
          if (foreign(up, fx, fy - 1)) { ctx.moveTo(X0, Y0); ctx.lineTo(X1, Y0); }
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // roads on the small maps: built routes between settlements the tamer
      // has found, drawn only across country they have charted — the network
      // never paints through the fog on its own
      {
        const ROAD_LINE: Record<string, string> = { local: "#a58a5f", regional: "#8f7d63", major: "#9a938a" };
        const ROAD_W: Record<string, number> = { local: 1, regional: 1.5, major: 2.5 };
        for (const line of mapRoadLines(net, isWorld ? 16 : 4)) {
          const na = net.byId.get(line.road.a);
          const nb2 = net.byId.get(line.road.b);
          if (!na || !nb2) continue;
          if (!k.discovered[`f:${na.x}:${na.y}`] || !k.discovered[`f:${nb2.x}:${nb2.y}`]) continue;
          ctx.strokeStyle = ROAD_LINE[line.road.cls];
          ctx.lineWidth = ROAD_W[line.road.cls];
          ctx.beginPath();
          let started = false;
          for (const p of line.pts) {
            // charted country only: an unexplored stretch stays unexplored
            const seen = isWorld
              ? exploredW!.has(Math.floor(p.y / 32) * 128 + Math.floor(p.x / 32))
              : anyExplored(k, p.x - cell + 1, p.y - cell + 1, p.x + cell - 1, p.y + cell - 1);
            if (!seen) {
              started = false;
              continue;
            }
            const X = wx2x(p.x + 0.5);
            const Y = wy2y(p.y + 0.5);
            if (!started) {
              ctx.moveTo(X, Y);
              started = true;
            } else ctx.lineTo(X, Y);
          }
          ctx.stroke();
        }
      }

      ctx.textAlign = "center";

      if (isWorld) {
        ctx.strokeStyle = "rgba(242,193,78,0.45)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        k.route.forEach(([rx, ry], i) => {
          const X = wx2x(rx + 0.5);
          const Y = wy2y(ry + 0.5);
          if (i === 0) ctx.moveTo(X, Y);
          else ctx.lineTo(X, Y);
        });
        ctx.stroke();
      } else {
        ctx.fillStyle = "rgba(242,193,78,0.75)";
        for (const [rx, ry] of k.route) {
          const gx = Math.floor(rx / cell);
          const gy = Math.floor(ry / cell);
          if (Math.abs(gx - ccx) > halfW || Math.abs(gy - ccy) > halfH) continue;
          ctx.beginPath();
          ctx.arc(wx2x(gx * cell) + ts / 2, wy2y(gy * cell) + ts / 2, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        if (path && path.length) {
          ctx.fillStyle = "rgba(255,244,220,0.9)";
          for (const [x, y] of path) {
            const gx = Math.floor(x / cell);
            const gy = Math.floor(y / cell);
            if (Math.abs(gx - ccx) > halfW || Math.abs(gy - ccy) > halfH) continue;
            ctx.fillRect(wx2x(gx * cell) + ts / 2 - 2, wy2y(gy * cell) + ts / 2 - 2, 4, 4);
          }
        }
      }

      const labelFont = Math.max(10, Math.round(ts * (isWorld ? 0.8 : 0.58)));
      ctx.font = `bold ${labelFont}px "Pixelify Sans", monospace`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(10,8,20,0.85)";
      const r0x = Math.floor((cx - halfW * cell) / REGION_SPAN) - 1;
      const r1x = Math.floor((cx + halfW * cell) / REGION_SPAN) + 1;
      const r0y = Math.floor((cy - halfH * cell) / REGION_SPAN) - 1;
      const r1y = Math.floor((cy + halfH * cell) / REGION_SPAN) + 1;
      for (let ry = r0y; ry <= r1y; ry++) {
        for (let rx = r0x; rx <= r1x; rx++) {
          if (rx < 0 || ry < 0) continue;
          if (!isRegionSeen(k, rx * REGION_SPAN + 4, ry * REGION_SPAN + 4)) continue;
          const X = wx2x(rx * REGION_SPAN + REGION_SPAN / 2);
          const Y = wy2y(ry * REGION_SPAN + REGION_SPAN / 2);
          ctx.strokeText(`${world.regionName(rx * REGION_SPAN + 4, ry * REGION_SPAN + 4)} lands`, X, Y);
          ctx.fillStyle = "rgba(242,193,78,0.8)";
          ctx.fillText(`${world.regionName(rx * REGION_SPAN + 4, ry * REGION_SPAN + 4)} lands`, X, Y);
        }
      }

      ctx.font = `bold ${Math.max(12, Math.round(ts * 0.9))}px "Pixelify Sans", monospace`;
      for (const d of discoveredList(k)) {
        const gx = Math.floor(d.x / cell);
        const gy = Math.floor(d.y / cell);
        if (Math.abs(gx - ccx) > halfW || Math.abs(gy - ccy) > halfH) continue;
        const X = wx2x(gx * cell) + ts / 2;
        const Y = wy2y(gy * cell) + ts * 0.88;
        if (isWorld) {
          const g = FEATURE_GLYPH[d.kind];
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(10,8,20,0.9)";
          ctx.strokeText(g.text, X, Y);
          ctx.fillStyle = g.color;
          ctx.fillText(g.text, X, Y);
        } else {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = "#0a0814";
          ctx.beginPath();
          ctx.ellipse(X, Y + 1, ts * 0.3, ts * 0.09, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.drawImage(featureTex(d.kind), X - ts * 0.42, Y - ts * 0.8, ts * 0.84, ts * 0.84);
        }
      }

      // nests you have charted: small markers on the region and world maps
      for (const nest of Object.values(gs.nests)) {
        if ((nest.layer ?? 0) !== 0 || !k.nestsSeen?.[nest.id]) continue;
        const gx = Math.floor(nest.x / cell);
        const gy = Math.floor(nest.y / cell);
        if (Math.abs(gx - ccx) > halfW || Math.abs(gy - ccy) > halfH) continue;
        const NX = wx2x(gx * cell) + ts / 2;
        const NY = wy2y(gy * cell) + ts * 0.88;
        ctx.lineWidth = Math.max(2, Math.round(ts * 0.08));
        ctx.strokeStyle = "rgba(10,8,20,0.9)";
        ctx.fillStyle = "#cbb27a";
        ctx.beginPath();
        ctx.ellipse(NX, NY - ts * 0.18, ts * 0.2, ts * 0.13, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // capitals fly their banners; discovered chapters show the scales
      for (const nat of fac.nations) {
        if (!k.nationsSeen[nat.id]) continue;
        const gx = Math.floor(nat.capX / cell);
        const gy = Math.floor(nat.capY / cell);
        if (Math.abs(gx - ccx) > halfW || Math.abs(gy - ccy) > halfH) continue;
        const X = wx2x(gx * cell) + ts / 2;
        const Y = wy2y(gy * cell) + ts * 0.88;
        ctx.font = `bold ${Math.max(12, Math.round(ts * 0.9))}px "Pixelify Sans", monospace`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(240,230,207,0.85)";
        ctx.strokeText("⚑", X, Y - ts * 0.5);
        ctx.fillStyle = nat.color;
        ctx.fillText("⚑", X, Y - ts * 0.5);
        ctx.font = `bold ${Math.max(10, Math.round(ts * (isWorld ? 0.62 : 0.5)))}px "Pixelify Sans", monospace`;
        ctx.strokeStyle = "rgba(10,8,20,0.85)";
        ctx.strokeText(nat.title, X, Y - ts * 0.74);
        ctx.fillStyle = "#f0e6cf";
        ctx.fillText(nat.title, X, Y - ts * 0.74);
      }
      for (const a of fac.assocs) {
        if (!k.assocSeen[a.id] || !k.discovered[`f:${a.chapter.x}:${a.chapter.y}`]) continue;
        const gx = Math.floor(a.chapter.x / cell);
        const gy = Math.floor(a.chapter.y / cell);
        if (Math.abs(gx - ccx) > halfW || Math.abs(gy - ccy) > halfH) continue;
        const X = wx2x(gx * cell) + ts / 2;
        const Y = wy2y(gy * cell) + ts * 0.88 - ts * 0.5;
        ctx.font = `bold ${Math.max(10, Math.round(ts * 0.7))}px "Pixelify Sans", monospace`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(240,230,207,0.85)";
        ctx.strokeText("⚖", X, Y);
        ctx.fillStyle = "#c9b7e6";
        ctx.fillText("⚖", X, Y);
      }

      if (isWorld) {
        const rx = Math.floor(px / REGION_SPAN);
        const ry = Math.floor(py / REGION_SPAN);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(242,193,78,0.55)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(wx2x(rx * REGION_SPAN), wy2y(ry * REGION_SPAN), REGION_SPAN * ppu, REGION_SPAN * ppu);
        ctx.setLineDash([]);
      }

      {
        const X = wx2x(px + 0.5);
        const Y = wy2y(py + 0.5);
        const r = Math.max(5, ts * 0.3);
        ctx.beginPath();
        ctx.arc(X, Y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#0e0b1d";
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#fff4dc";
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(X, Y, Math.max(2.5, r * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = gs.player.scarf;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(X, Y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(242,193,78,0.45)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (X < -8 || X > size.w + 8 || Y < -8 || Y > size.h + 8) {
          const ex = Math.max(14, Math.min(size.w - 14, X));
          const ey = Math.max(14, Math.min(size.h - 14, Y));
          ctx.save();
          ctx.translate(ex, ey);
          ctx.rotate(Math.atan2(Y - ey, X - ex) + Math.PI / 2);
          ctx.fillStyle = "#f2c14e";
          ctx.beginPath();
          ctx.moveTo(0, -7);
          ctx.lineTo(5, 4);
          ctx.lineTo(-5, 4);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }

      if (selected) {
        const sxx = selected.x - (selected.x % cell);
        const syy = selected.y - (selected.y % cell);
        ctx.strokeStyle = "#fff4dc";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(wx2x(sxx) + 1, wy2y(syy) + 1, ts - 2, ts - 2);
      }

      ctx.textAlign = "left";
      ctx.font = `bold 12px "Pixelify Sans", monospace`;
      ctx.fillStyle = "rgba(242,193,78,0.85)";
      ctx.fillText("N ▲", 8, 18);
    }
  }, [gs, v, scale, selected, path, reach, size, imgTick, panV]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: panRef.current.x, py: panRef.current.y, moved: false };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragRef.current;
    if (!d || scale === "local") return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 8) return;
    d.moved = true;
    panRef.current = { x: d.px - dx / tsRef.current, y: d.py - dy / tsRef.current };
    bumpPan((n) => n + 1);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = tsRef.current;
    const pan = scale === "local" ? { x: 0, y: 0 } : panRef.current;
    const cell = SCALE_CELL[scale];
    const dX = e.clientX - rect.left - size.w / 2;
    const dY = e.clientY - rect.top - size.h / 2;
    const x = Math.max(0, Math.min(WORLD_SIZE - 1, Math.floor(gs.player.x + pan.x + (dX * cell) / t + cell / 2)));
    const y = Math.max(0, Math.min(WORLD_SIZE - 1, Math.floor(gs.player.y + pan.y + (dY * cell) / t + cell / 2)));
    onTap(x, y);
  };

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="pixel block h-full w-full cursor-pointer touch-none"
        style={{ width: size.w, height: size.h }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />
      <FxLayer gs={gs} />
    </div>
  );
});
