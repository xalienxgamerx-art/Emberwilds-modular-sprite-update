import { Rng, hash2 } from "./rng";
import {
  BUILDING_TEMPLATES,
  DIR_DELTA,
  generateBuilding,
  validateBuilding,
  type Building,
  type BuildingType,
  type Dir,
} from "./buildings";
import { getSettlementFootprint, type SettlementTier } from "./settlement";

/**
 * The generalized urban generator behind towns and cities — one pipeline,
 * two scales:
 *
 *   footprint → districts → streets & gates → plots → buildings → interiors
 *
 * Streets and gates are reserved before anything stands on them; the ground
 * between street columns and rows is zoned into districts; districts are
 * carved into plots; and only then does the Phase-2 multi-room building
 * generator fill a plot, raising grand halls where the plot allows. Rejection
 * and retry are part of the deterministic seed sequence — never uncontrolled
 * randomness, never silent overlap.
 *
 * A town is one avenue pair (four districts); a city is two (nine or more),
 * with grander halls and more gates. Everything else is configuration.
 */

export type UrbanZone = "market" | "homes" | "beasts" | "association" | "civic" | "public";

/** Feature-local key of an urban tile. Footprints span at most 69 tiles; 128-wide rows are safe. */
export const urbanKey = (lx: number, ly: number): number => (ly + 64) * 128 + (lx + 64);

export interface UrbanGate {
  /** Feature-local tile of the gate (a ring-road tile). */
  lx: number;
  ly: number;
  dir: Dir;
}

/** The reserved plan of an urban settlement: streets, green, gates, districts. */
export interface UrbanPlan {
  /** Reserved street tiles, feature-local, as urbanKey(lx, ly) set entries. */
  streets: Set<number>;
  /** The open green at the heart of the settlement. */
  plaza: { x: number; y: number; r: number };
  /** Settlement entrances on the ring road, feature-local. */
  gates: UrbanGate[];
  zoneAt(lx: number, ly: number): UrbanZone | null;
  isStreet(lx: number, ly: number): boolean;
}

/** The generated settlement: its reserved plan plus the buildings that fill it. */
export interface UrbanLayout {
  plan: UrbanPlan;
  buildings: Building[];
  /** Empty when the settlement is sound; otherwise human-readable problems — never silent. */
  problems: string[];
}

/** Inclusive one-dimensional band. */
export interface Band {
  lo: number;
  hi: number;
}

/** A reserved building plot, feature-local. */
export interface Plot {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  block: number;
}

export const inside = (p: Plot, lx: number, ly: number): boolean => lx >= p.x0 && lx <= p.x1 && ly >= p.y0 && ly <= p.y1;

/**
 * Split a span into plot bands of `size` with a street-width gap between
 * them, working inward from the street-facing edge (`fromHi`). A street line
 * cutting the span (`cut`) splits it so plots never straddle a street. Leftover
 * ground narrower than a plot stays open — expansion space, not waste.
 */
export function bands(lo: number, hi: number, fromHi: boolean, cut: number | null, size: number): Band[] {
  const spans: Band[] = [];
  if (cut !== null && lo < cut && cut < hi) {
    spans.push({ lo, hi: cut - 1 }, { lo: cut + 1, hi });
  } else spans.push({ lo, hi });
  const out: Band[] = [];
  for (const s of spans) {
    let a = s.lo;
    let b = s.hi;
    while (b - a + 1 >= size) {
      if (fromHi) {
        out.push({ lo: b - size + 1, hi: b });
        b -= size + 1;
      } else {
        out.push({ lo: a, hi: a + size - 1 });
        a += size + 1;
      }
    }
  }
  return out;
}

/** One required service: which building, how many, on what kind of plot, in which district zone. */
export interface UrbanService {
  type: BuildingType;
  tag: string;
  count: number;
  /** "double" plots join two plots across their gap for a grand hall. */
  plot: "double" | "single";
  /** District zone this service prefers; fallbacks may go anywhere. */
  zone: UrbanZone;
}

export interface UrbanConfig {
  tier: SettlementTier;
  /** Half-extent of the whole settlement footprint. */
  half: number;
  /** The ring road's Chebyshev distance from the heart. */
  ring: number;
  plazaR: number;
  /** Plot cell edge: building + breathing room. */
  plot: number;
  /** Avenue offsets per axis, in deterministic pick order. */
  avenues: number[];
  /** Fewest gates a valid settlement may open. */
  minGates: number;
  /** How many districts get each zoned use; the rest are homes. */
  zones: { zone: UrbanZone; blocks: number }[];
  /** Home composition. */
  homes: { min: number; skip: number };
  /** Required services, in placement-priority order. */
  services: UrbanService[];
  /** Optional extras placed by hash after the requirements (never more than min(count, chance lots)). */
  optional?: UrbanService[];
}

const GATE_DIRS: { dir: Dir; dx: number; dy: number }[] = [
  { dir: "n", dx: 0, dy: -1 },
  { dir: "s", dx: 0, dy: 1 },
  { dir: "w", dx: -1, dy: 0 },
  { dir: "e", dx: 1, dy: 0 },
];

/**
 * Generate an urban settlement. Deterministic: same config/seed/origin/
 * exterior terrain → same place. `exteriorOk` reports whether a world tile
 * can serve as the approach to a gate (dry, passable ground); ground inside
 * the footprint is always settlement ground, so gates look outward and doors
 * look inward.
 */
/**
 * The settlement pipeline. A scrappy site can leave a required service
 * without a fitting lot; rather than ship an invalid place, the whole
 * settlement re-founds itself on a nudged seed — up to a bounded handful of
 * tries. Still a pure function of the seed: the same world always grows the
 * same town.
 */
export function generateUrban(cfg: UrbanConfig, opts: { seed: number; fx: number; fy: number; exteriorOk(x: number, y: number): boolean }): UrbanLayout {
  let layout = generateUrbanOnce(cfg, opts);
  for (let nudge = 1; nudge <= 8; nudge++) {
    const short = cfg.services.some((svc) => layout.buildings.filter((b) => b.type === svc.type).length < svc.count);
    if (!short) return layout;
    layout = generateUrbanOnce(cfg, { ...opts, seed: opts.seed + nudge * 0x9e3779b9 });
  }
  return layout;
}

function generateUrbanOnce(cfg: UrbanConfig, opts: { seed: number; fx: number; fy: number; exteriorOk(x: number, y: number): boolean }): UrbanLayout {
  const { seed, fx, fy } = opts;
  const rng = new Rng(hash2(seed ^ 0x703d, fx, fy));
  const problems: string[] = [];
  const HALF = cfg.half;
  const RING = cfg.ring;

  /* ---------------- 1. avenues and gates: reserved before anything ---------------- */
  // Each combination of avenue offsets is scored by how many gates the
  // outside world allows; ties break by the deterministic rotation, so no two
  // settlements agree on where their main streets run.
  // Gates stand where an avenue meets the ring; the two tiles beyond must be
  // real approach ground. Avenues west/north of center are drawn from the
  // negative offsets, east/south from the positive, so districts stay balanced.
  const colGates = (col: number, axis: "v" | "h"): UrbanGate[] => {
    const out: UrbanGate[] = [];
    for (const { dir, dx, dy } of GATE_DIRS) {
      const vertical = dy !== 0;
      if ((axis === "v") !== vertical) continue;
      const g1x = vertical ? fx + col : fx + dx * (RING + 1);
      const g1y = vertical ? fy + dy * (RING + 1) : fy + col;
      const g2x = vertical ? fx + col : fx + dx * (RING + 2);
      const g2y = vertical ? fy + dy * (RING + 2) : fy + col;
      if (opts.exteriorOk(g1x, g1y) && opts.exteriorOk(g2x, g2y)) {
        out.push(vertical ? { lx: col, ly: dir === "n" ? -RING : RING, dir } : { lx: dir === "w" ? -RING : RING, ly: col, dir });
      }
    }
    return out;
  };
  const neg = cfg.avenues.filter((a) => a < 0);
  const pos = cfg.avenues.filter((a) => a > 0);
  const center = cfg.avenues.filter((a) => a === 0);
  const pickOne = (pool: number[], axis: "v" | "h"): { at: number; gates: UrbanGate[] } => {
    const at = pool[rng.int(0, pool.length - 1)];
    return { at, gates: colGates(at, axis) };
  };
  const pickAxis = (axis: "v" | "h"): { cols: number[]; gates: UrbanGate[] } => {
    if (center.length) {
      const one = pickOne([0], axis);
      return { cols: [0], gates: one.gates };
    }
    if (neg.length === 0 || pos.length === 0) {
      const one = pickOne([...neg, ...pos], axis);
      return { cols: [one.at], gates: one.gates };
    }
    const west = pickOne(neg, axis);
    const east = pickOne(pos, axis);
    return { cols: [west.at, east.at].sort((a, b) => a - b), gates: [...west.gates, ...east.gates] };
  };
  const v = pickAxis("v");
  const h = pickAxis("h");
  const vx = v.cols;
  const hy = h.cols;
  const gates: UrbanGate[] = [...v.gates, ...h.gates];

  /* ---------------- 2. the street network ---------------- */
  const streets = new Set<number>();
  const addStreet = (lx: number, ly: number): void => {
    if (Math.abs(lx) <= RING && Math.abs(ly) <= RING) streets.add(urbanKey(lx, ly));
  };
  for (let i = -RING; i <= RING; i++) {
    addStreet(i, -RING);
    addStreet(i, RING);
    addStreet(-RING, i);
    addStreet(RING, i);
  }
  for (const col of vx) for (let i = -RING; i <= RING; i++) addStreet(col, i);
  for (const row of hy) for (let i = -RING; i <= RING; i++) addStreet(i, row);
  // spurs tie the green into the grid so the heart is walked, not bypassed
  const hasCol = (c: number): boolean => vx.includes(c) || hy.includes(c);
  if (!hasCol(0)) {
    const vSpan = vx.length ? [Math.min(...vx), Math.max(...vx)] : [0, 0];
    const hSpan = hy.length ? [Math.min(...hy), Math.max(...hy)] : [0, 0];
    for (let i = Math.min(0, vSpan[0], hSpan[0]); i <= Math.max(0, vSpan[1], hSpan[1]); i++) {
      addStreet(i, 0);
      addStreet(0, i);
    }
  }
  for (let ly = -cfg.plazaR; ly <= cfg.plazaR; ly++) {
    for (let lx = -cfg.plazaR; lx <= cfg.plazaR; lx++) {
      if (lx * lx + ly * ly <= cfg.plazaR * cfg.plazaR) addStreet(lx, ly);
    }
  }

  /* ---------------- 3. districts: spans between the street lines ---------------- */
  const colSpans = (streetCols: number[]): Band[] => {
    const out: Band[] = [];
    let prev = -RING;
    for (const c of [...streetCols, RING].sort((a, b) => a - b)) {
      const lo = prev + 2;
      const hi = c - 2;
      if (hi - lo + 1 >= 4) out.push({ lo, hi });
      prev = c;
    }
    return out;
  };
  const colBands = colSpans([...vx, ...(hasCol(0) ? [] : [0])]);
  const rowBands = colSpans([...hy, ...(hasCol(0) ? [] : [0])]);
  // zoned districts: seeded shuffle of the block grid
  const blocks: { id: number; x: Band; y: Band; zone: UrbanZone }[] = [];
  for (const y of rowBands) {
    for (const x of colBands) blocks.push({ id: blocks.length, x, y, zone: "homes" });
  }
  {
    const order = blocks.map((b, i) => ({ i, k: rng.next() })).sort((a, b) => a.k - b.k);
    let cursor = 0;
    for (const { zone, blocks: want } of cfg.zones) {
      let placed = 0;
      for (let n = 0; n < want && cursor < order.length; n++) {
        blocks[order[cursor++].i].zone = zone;
        placed++;
      }
    }
  }

  /* ---------------- 4. plots, carved per district ---------------- */
  const plots: Plot[] = [];
  for (const b of blocks) {
    const cutX = b.x.lo < 0 && b.x.hi > 0 ? 0 : null;
    const cutY = b.y.lo < 0 && b.y.hi > 0 ? 0 : null;
    const cols = bands(b.x.lo, b.x.hi, b.x.lo < 0, cutX, cfg.plot);
    const rows = bands(b.y.lo, b.y.hi, b.y.lo < 0, cutY, cfg.plot);
    for (const r of rows) {
      for (const c of cols) plots.push({ x0: c.lo, y0: r.lo, x1: c.hi, y1: r.hi, block: b.id });
    }
  }
  const zoneOfBlock = (id: number): UrbanZone => blocks[id].zone;
  const streetFacing = (p: Plot): boolean => {
    const b = blocks[p.block];
    return p.x1 === b.x.hi || p.x0 === b.x.lo || p.y1 === b.y.hi || p.y0 === b.y.lo;
  };
  const plotOrder = plots
    .slice()
    .sort((a, b) => (streetFacing(b) ? 1 : 0) - (streetFacing(a) ? 1 : 0) || a.y0 * 128 + a.x0 - (b.y0 * 128 + b.x0));

  /* ---------------- 5. the reservation book ---------------- */
  const occupied = new Set<number>();
  const reserve = (p: Plot): void => {
    for (let ly = p.y0 - 1; ly <= p.y1 + 1; ly++) {
      for (let lx = p.x0 - 1; lx <= p.x1 + 1; lx++) occupied.add(urbanKey(lx, ly));
    }
  };
  const plotFree = (p: Plot): boolean => {
    for (let ly = p.y0; ly <= p.y1; ly++) {
      for (let lx = p.x0; lx <= p.x1; lx++) {
        if (streets.has(urbanKey(lx, ly)) || occupied.has(urbanKey(lx, ly))) return false;
      }
    }
    return true;
  };
  const merged = (a: Plot, b: Plot): Plot | null => {
    // two side-by-side plots joined across their gap — along either axis
    if (a.y0 === b.y0 && a.y1 === b.y1 && Math.abs(a.x0 - b.x0) === cfg.plot + 1) {
      const lo = a.x0 < b.x0 ? a : b;
      return { x0: lo.x0, x1: lo.x1 + cfg.plot + 1, y0: lo.y0, y1: lo.y1, block: a.block };
    }
    if (a.x0 === b.x0 && a.x1 === b.x1 && Math.abs(a.y0 - b.y0) === cfg.plot + 1) {
      const lo = a.y0 < b.y0 ? a : b;
      return { x0: lo.x0, x1: lo.x1, y0: lo.y0, y1: lo.y1 + cfg.plot + 1, block: a.block };
    }
    return null;
  };

  let buildIdx = 0;
  const buildings: Building[] = [];
  const GRAND = new Set<string>(["inn", "association", "city_hq", "assoc_hq"]);
  const tryPlace = (plot: Plot, type: BuildingType, tag: string): Building | null => {
    if (!plotFree(plot)) return null;
    const w = plot.x1 - plot.x0 + 1;
    const hgt = plot.y1 - plot.y0 + 1;
    let b: Building;
    try {
      // the great halls must outgrow a town building whenever their plot
      // allows it: raise the floor instead of hoping the roll does
      const base = BUILDING_TEMPLATES[type];
      const grand = GRAND.has(type) && (w >= 9 || hgt >= 9) ? { ...base, minW: Math.max(base.minW, 9), minH: Math.max(base.minH, 6) } : base;
      b = generateBuilding({
        id: `b:${fx}:${fy}:${tag}`,
        seed: hash2(seed ^ 0x62d1, fx * 3 + buildIdx, fy * 5 + buildIdx * 7),
        template: grand,
        plot: { w, h: hgt },
        origin: { x: fx + plot.x0, y: fy + plot.y0 },
        exitOk: (side, wx, wy) => {
          const lx = wx - fx;
          const ly = wy - fy;
          if (Math.abs(lx) > HALF || Math.abs(ly) > HALF) return false;
          const k = urbanKey(lx, ly);
          if (occupied.has(k)) return false;
          if (streets.has(k)) return true;
          // open ground is fine unless a future building owns that plot
          return !plotOrder.some((p) => p !== plot && inside(p, lx, ly));
        },
      });
    } catch {
      return null;
    }
    buildIdx++;
    reserve(plot);
    buildings.push(b);
    return b;
  };
  const giveBack = (p: Plot | null): void => {
    if (p) plotOrder.push(p);
  };
  const take = (zone: UrbanZone | null, minArea: number): Plot | null => {
    for (let i = 0; i < plotOrder.length; i++) {
      const p = plotOrder[i];
      if (zone !== null && zoneOfBlock(p.block) !== zone) continue;
      if ((p.x1 - p.x0 + 1) * (p.y1 - p.y0 + 1) < minArea) continue;
      plotOrder.splice(i, 1);
      return p;
    }
    return null;
  };
  const takePair = (zone: UrbanZone | null): [Plot, Plot] | null => {
    for (let i = 0; i < plotOrder.length; i++) {
      const a = plotOrder[i];
      if (zone !== null && zoneOfBlock(a.block) !== zone) continue;
      for (let j = i + 1; j < plotOrder.length; j++) {
        const b = plotOrder[j];
        if (zone !== null && zoneOfBlock(b.block) !== zone) continue;
        if (merged(a, b)) {
          plotOrder.splice(j, 1);
          plotOrder.splice(i, 1);
          return [a, b];
        }
      }
    }
    return null;
  };

  /* ---------------- 6. required services before homes ---------------- */
  // A grand hall must never lose its lot to a house that came up later.
  for (const svc of cfg.services) {
    for (let n = 0; n < svc.count; n++) {
      const zone = svc.plot === "double" ? svc.zone : n === 0 ? svc.zone : null;
      if (svc.plot === "double") {
        const pair = takePair(svc.zone);
        const double = pair ? merged(pair[0], pair[1]) : null;
        if (double && tryPlace(double, svc.type, svc.tag)) continue;
        giveBack(pair?.[1] ?? null);
        const single = pair?.[0] ?? null;
        if (single && tryPlace(single, svc.type, svc.tag)) continue;
        giveBack(single);
      } else {
        const p = take(zone, 20);
        if (p && tryPlace(p, svc.type, svc.tag)) continue;
        giveBack(p);
      }
    }
  }
  // a plot-poor district must not cost the settlement its services
  const ensure = (svc: UrbanService): void => {
    const have = buildings.filter((b) => b.type === svc.type).length;
    for (let n = have; n < svc.count; n++) {
      if (svc.plot === "double") {
        let done = false;
        for (let i = 0; i < plotOrder.length && !done; i++) {
          for (let j = i + 1; j < plotOrder.length && !done; j++) {
            const m = merged(plotOrder[i], plotOrder[j]);
            if (!m) continue;
            const a = plotOrder.splice(j, 1)[0];
            const b = plotOrder.splice(i, 1)[0];
            if (tryPlace(m, svc.type, svc.tag)) done = true;
            else {
              plotOrder.splice(i, 0, b);
              plotOrder.splice(j, 0, a);
            }
          }
        }
        if (done) continue;
      }
      for (let i = 0; i < plotOrder.length; i++) {
        const p = plotOrder[i];
        if ((p.x1 - p.x0 + 1) * (p.y1 - p.y0 + 1) < 20) continue;
        plotOrder.splice(i, 1);
        if (tryPlace(p, svc.type, svc.tag)) break;
        plotOrder.push(p);
      }
    }
  };
  for (const svc of cfg.services) ensure(svc);

  /* ---------------- 7. optional buildings by hash ---------------- */
  for (const svc of cfg.optional ?? []) {
    if (!rng.chance(0.5)) continue;
    if (svc.plot === "double") {
      const pair = takePair(svc.zone);
      const double = pair ? merged(pair[0], pair[1]) : null;
      if (double && tryPlace(double, svc.type, svc.tag)) continue;
      giveBack(pair?.[1] ?? null);
      giveBack(pair?.[0] ?? null);
    } else {
      const p = take(svc.zone, 20);
      if (p && tryPlace(p, svc.type, svc.tag)) continue;
      giveBack(p);
    }
  }

  /* ---------------- 8. homes fill what remains ---------------- */
  const homeTypes = ["small_home", "medium_home"] as const;
  const isHome = (t: BuildingType): boolean => (homeTypes as readonly string[]).includes(t);
  for (const b of blocks) {
    while (true) {
      const i = plotOrder.findIndex((p) => p.block === b.id);
      if (i < 0) break;
      const p = plotOrder.splice(i, 1)[0];
      // some lots stay open by hash: breathing room and room to grow
      if (rng.chance(cfg.homes.skip)) continue;
      const type = homeTypes[rng.int(0, 1)];
      if (!tryPlace(p, type, `home${buildIdx}`) && type === "medium_home") {
        tryPlace(p, "small_home", `home${buildIdx}`);
      }
    }
  }
  let homeGuard = 0;
  while (buildings.filter((b) => isHome(b.type)).length < cfg.homes.min && homeGuard++ < 4) {
    const p = take(null, 20);
    if (!p) break;
    if (!tryPlace(p, "medium_home", `home${buildIdx}`)) tryPlace(p, "small_home", `home${buildIdx}`);
  }

  /* ---------------- 9. the plan and validation ---------------- */
  const plan: UrbanPlan = {
    streets,
    plaza: { x: 0, y: 0, r: cfg.plazaR },
    gates,
    isStreet: (lx, ly) => streets.has(urbanKey(lx, ly)),
    zoneAt(lx, ly) {
      if (Math.abs(lx) > HALF || Math.abs(ly) > HALF) return null;
      if (streets.has(urbanKey(lx, ly))) return "public";
      const b = blocks.find((bb) => lx >= bb.x.lo && lx <= bb.x.hi && ly >= bb.y.lo && ly <= bb.y.hi);
      return b ? b.zone : "public";
    },
  };
  for (const g of gates) {
    const [dx, dy] = DIR_DELTA[g.dir];
    if (!opts.exteriorOk(fx + g.lx + dx, fy + g.ly + dy) || !opts.exteriorOk(fx + g.lx + 2 * dx, fy + g.ly + 2 * dy)) {
      problems.push(`gate ${g.dir} lost its approach space`);
    }
  }
  problems.push(...validateUrban({ plan, buildings }, fx, fy, cfg));

  return { plan, buildings, problems };
}

/**
 * Full validation of a generated urban settlement: geometry, circulation,
 * services. Returns human-readable problems (empty when the place is sound).
 * Gate approach space is world terrain and is checked by the generator.
 */
export function validateUrban(town: { plan: UrbanPlan; buildings: Building[] }, fx: number, fy: number, cfg: UrbanConfig): string[] {
  const problems: string[] = [];
  const { plan, buildings } = town;
  const HALF = cfg.half;
  const RING = cfg.ring;

  // geometry: inside the footprint, sane footprints, nothing on a street
  for (const b of buildings) {
    const lx0 = b.x - fx;
    const ly0 = b.y - fy;
    if (lx0 < -HALF || ly0 < -HALF || lx0 + b.w - 1 > HALF || ly0 + b.h - 1 > HALF) {
      problems.push(`[${b.id}] stands outside the ${cfg.tier} footprint`);
    }
    if (b.w < 4 || b.h < 4) problems.push(`[${b.id}] footprint ${b.w}x${b.h} is not a building`);
    for (let ly = 0; ly < b.h; ly++) {
      for (let lx = 0; lx < b.w; lx++) {
        if (plan.streets.has(urbanKey(lx0 + lx, ly0 + ly))) problems.push(`[${b.id}] covers a street tile at (${lx0 + lx},${ly0 + ly})`);
      }
    }
  }
  for (let i = 0; i < buildings.length; i++) {
    for (let j = i + 1; j < buildings.length; j++) {
      const a = buildings[i];
      const b = buildings[j];
      const sepX = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
      const sepY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
      if (sepX < 0 && sepY < 0) problems.push(`[${a.id}] and [${b.id}] overlap or touch`);
    }
  }

  // gates: on the ring, on the street network
  if (plan.gates.length < cfg.minGates) problems.push(`only ${plan.gates.length} gates — a ${cfg.tier} needs at least ${cfg.minGates} ways in`);
  for (const g of plan.gates) {
    if (Math.max(Math.abs(g.lx), Math.abs(g.ly)) !== RING) problems.push(`gate at (${g.lx},${g.ly}) is not on the ring road`);
    if (!plan.streets.has(urbanKey(g.lx, g.ly))) problems.push(`gate at (${g.lx},${g.ly}) does not open onto a street`);
  }

  // circulation: flood the open ground from the green. Buildings are opaque;
  // every gate and every building entrance must be reached, or the place has
  // a sealed quarter.
  const blocked = new Set<number>();
  for (const b of buildings) {
    for (let ly = 0; ly < b.h; ly++) {
      for (let lx = 0; lx < b.w; lx++) blocked.add(urbanKey(b.x - fx + lx, b.y - fy + ly));
    }
  }
  const seen = new Set<number>([urbanKey(0, 0)]);
  const queue: [number, number][] = [[0, 0]];
  while (queue.length) {
    const [cx, cy] = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (Math.abs(nx) > HALF || Math.abs(ny) > HALF) continue;
      const k = urbanKey(nx, ny);
      if (seen.has(k) || blocked.has(k)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  for (const g of plan.gates) {
    if (!seen.has(urbanKey(g.lx, g.ly))) problems.push(`gate at (${g.lx},${g.ly}) is cut off from the streets`);
  }
  for (const b of buildings) {
    const door = b.doors.find((d) => d.external && d.dir);
    if (!door || !door.dir) {
      problems.push(`[${b.id}] has no exterior entrance`);
      continue;
    }
    const ex = b.x - fx + door.lx + DIR_DELTA[door.dir][0];
    const ey = b.y - fy + door.ly + DIR_DELTA[door.dir][1];
    if (!seen.has(urbanKey(ex, ey))) problems.push(`[${b.id}] entrance at (${ex},${ey}) is not reachable from the streets`);
    problems.push(...validateBuilding(b));
  }

  // services: what makes this tier what it is
  for (const svc of cfg.services) {
    const count = buildings.filter((b) => b.type === svc.type).length;
    if (svc.type === "small_home" || svc.type === "medium_home") continue;
    if (count < svc.count) problems.push(`${count}/${svc.count} ${svc.type}`);
  }
  const homes = buildings.filter((b) => b.type === "small_home" || b.type === "medium_home").length;
  if (homes < cfg.homes.min) problems.push(`too few homes (${homes})`);
  return problems;
}

/** Shared footprint lookup for the tiers that build urban layouts. */
export const urbanHalf = (tier: SettlementTier): number => getSettlementFootprint(tier).w >> 1;
