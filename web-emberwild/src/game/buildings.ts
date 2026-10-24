import { hash2, Rng } from "./rng";

/**
 * Procedural buildings — the structural layer between settlements and the
 * rooms/objects inside them. A building is a physical, navigable structure:
 * exterior walls, at least one exterior entrance, two or more rooms connected
 * by internal doors, walkable floor, and reserved space where later systems
 * can place beds, chests, stations and desks — without regenerating or
 * redesigning the structure.
 *
 * Hierarchy this module exists for:
 *
 *   Settlement  (settlement.ts)
 *    └── Building   ← this module
 *         ├── Exterior + Entrance
 *         └── Room → Floor / Reserved / Interactable space
 *
 * Everything is deterministic: the same world seed + building seed produces
 * the same dimensions, rooms, doors, entrances, reserved spots and walkable
 * areas. Generation never uses uncontrolled randomness.
 */

/** Cardinal side of a building. */
export type Dir = "n" | "s" | "e" | "w";

export const DIR_DELTA: Record<Dir, [number, number]> = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };

/**
 * What occupies a building tile. Wall blocks movement; floor, door, reserved,
 * interactable and furniture tiles are all walkable today. Reserved marks
 * where future systems may place objects; furniture/interactable cells exist
 * so later phases can classify without touching this type again.
 */
export type BuildingCellKind = "wall" | "floor" | "door" | "reserved" | "interactable" | "furniture";

/** Every cell kind a creature can stand on. */
export const WALKABLE_CELLS: readonly BuildingCellKind[] = ["floor", "door", "reserved", "interactable", "furniture"];

/** Semantic room roles. Room types are assigned by templates; gameplay systems read them, the generator only labels. */
export type RoomType = "bedroom" | "living" | "kitchen" | "storage" | "common" | "office" | "shop" | "pen";

/** What future interactables reserve floor space for, per room type. */
const RESERVED_FOR: Record<RoomType, string> = {
  bedroom: "bed",
  living: "table",
  kitchen: "hearth",
  storage: "chest",
  common: "table",
  office: "desk",
  shop: "counter",
  pen: "trough",
};

/** The kind of building a template describes. Only templates in active use are generated; the rest are registered for later phases. */
export type BuildingType = "small_home" | "medium_home" | "inn" | "trader" | "pen" | "association" | "city_hq" | "assoc_hq";

/** Inclusive rectangle in building-local coordinates. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * A building template describes constraints, not tiles: dimension ranges,
 * room counts, how big and how roomy rooms must be, which semantic room
 * types it prefers and how much floor each room holds back for interactables.
 */
export interface BuildingTemplate {
  type: BuildingType;
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
  minRooms: number;
  prefRooms: number;
  /** Rooms must be meaningful spaces — never one-tile compartments or corridors. */
  minRoomSide: number;
  minRoomArea: number;
  /** Semantic room types in priority order; overflow rooms become extraRoomType. */
  roomTypes: RoomType[];
  extraRoomType: RoomType;
  /** Floor tiles per room held back for future interactables. */
  reservedPerRoom: number;
}

/**
 * All building templates. Hamlets generate inns, traders and pens today;
 * homes, associations and city headquarters are registered so towns, cities
 * and Phase-3 expansion can reuse the same generator without a rewrite.
 */
export const BUILDING_TEMPLATES: Record<BuildingType, BuildingTemplate> = {
  small_home: { type: "small_home", minW: 7, maxW: 8, minH: 4, maxH: 5, minRooms: 2, prefRooms: 2, minRoomSide: 2, minRoomArea: 4, roomTypes: ["bedroom", "living"], extraRoomType: "storage", reservedPerRoom: 1 },
  medium_home: { type: "medium_home", minW: 7, maxW: 10, minH: 5, maxH: 7, minRooms: 2, prefRooms: 3, minRoomSide: 2, minRoomArea: 4, roomTypes: ["bedroom", "living", "kitchen"], extraRoomType: "storage", reservedPerRoom: 1 },
  inn: { type: "inn", minW: 7, maxW: 14, minH: 4, maxH: 8, minRooms: 2, prefRooms: 4, minRoomSide: 2, minRoomArea: 4, roomTypes: ["common", "kitchen", "storage"], extraRoomType: "storage", reservedPerRoom: 2 },
  trader: { type: "trader", minW: 7, maxW: 9, minH: 4, maxH: 6, minRooms: 2, prefRooms: 2, minRoomSide: 2, minRoomArea: 4, roomTypes: ["shop", "storage"], extraRoomType: "storage", reservedPerRoom: 1 },
  pen: { type: "pen", minW: 7, maxW: 9, minH: 4, maxH: 6, minRooms: 2, prefRooms: 2, minRoomSide: 2, minRoomArea: 4, roomTypes: ["pen", "office"], extraRoomType: "storage", reservedPerRoom: 1 },
  association: { type: "association", minW: 8, maxW: 14, minH: 5, maxH: 9, minRooms: 2, prefRooms: 4, minRoomSide: 2, minRoomArea: 6, roomTypes: ["common", "office", "storage"], extraRoomType: "storage", reservedPerRoom: 2 },
  city_hq: { type: "city_hq", minW: 9, maxW: 16, minH: 6, maxH: 10, minRooms: 3, prefRooms: 5, minRoomSide: 2, minRoomArea: 6, roomTypes: ["common", "office", "storage", "bedroom"], extraRoomType: "storage", reservedPerRoom: 2 },
  // the great hall of an association in a city: a regional seat, grander than
  // a town's chapter house, with offices, an auction floor and records
  assoc_hq: { type: "assoc_hq", minW: 10, maxW: 16, minH: 6, maxH: 10, minRooms: 3, prefRooms: 5, minRoomSide: 2, minRoomArea: 6, roomTypes: ["common", "office", "office", "storage"], extraRoomType: "storage", reservedPerRoom: 2 },
};

/** A room: a rect of floor inside the building, typed for future gameplay systems. */
export interface BuildingRoom {
  id: number;
  type: RoomType;
  /** Building-local inclusive bounds; rooms are disjoint rects separated by wall lines. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A doorway. Internal doors connect two rooms; external doors connect a room to the outside. */
export interface BuildingDoor {
  /** Building-local position of the door cell (a walkable gap in a wall line). */
  lx: number;
  ly: number;
  external: boolean;
  /** Facing of an exterior entrance (which side it opens toward); null for internal doors. */
  dir: Dir | null;
  /** Room the door opens into; for internal doors, the room on the other side. */
  roomA: number;
  roomB: number | null;
  type: "door" | "opening";
}

/** Floor held back for a future object: a bed, chest, hearth, desk… */
export interface ReservedSpot {
  lx: number;
  ly: number;
  purpose: string;
}

/** A generated building: structure only — never NPCs, chests or furniture (those are population, placed later). */
export interface Building {
  /** Stable identity: unique within its settlement. */
  id: string;
  type: BuildingType;
  /** World coordinate of the footprint's top-left tile. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Row-major local grid, cells[ly * w + lx]. */
  cells: BuildingCellKind[];
  rooms: BuildingRoom[];
  doors: BuildingDoor[];
  reserved: ReservedSpot[];
}

/** The plot a building must fit inside: maximum footprint dimensions. */
export interface BuildingPlot {
  w: number;
  h: number;
}

export interface GenerateBuildingOpts {
  id: string;
  /** Building generation seed — derive from world seed + settlement identity + building identity. */
  seed: number;
  template: BuildingTemplate;
  /** Maximum footprint the assigned plot allows. */
  plot?: BuildingPlot;
  /** World origin of the plot (building coordinates are placed at the plot's top-left). */
  origin?: { x: number; y: number };
  /** Whether the tile just outside a candidate entrance is acceptable ground, in world coordinates. */
  exitOk?: (side: Dir, wx: number, wy: number) => boolean;
}

/** Raised when the generation budget is exhausted — never silently swallow a bad layout. */
export class BuildingGenerationError extends Error {
  constructor(
    message: string,
    readonly buildingId: string,
    readonly templateType: BuildingType,
    readonly seed: number,
    readonly attempts: number,
    readonly problems: string[],
  ) {
    super(message);
  }
}

/* --------------------------------- Lookups --------------------------------- */

/** The cell kind at building-local coordinates, or null outside the footprint. */
export function cellKindAt(b: Building, lx: number, ly: number): BuildingCellKind | null {
  if (lx < 0 || ly < 0 || lx >= b.w || ly >= b.h) return null;
  return b.cells[ly * b.w + lx];
}

const isWalkableCell = (k: BuildingCellKind | null): boolean => k !== null && WALKABLE_CELLS.includes(k);

/** The room covering this local tile, or null (walls, doors, outside). */
export function roomAt(b: Building, lx: number, ly: number): BuildingRoom | null {
  for (const r of b.rooms) if (lx >= r.x0 && lx <= r.x1 && ly >= r.y0 && ly <= r.y1) return r;
  return null;
}

/** The door at this local tile, if any. */
export function doorAt(b: Building, lx: number, ly: number): BuildingDoor | null {
  return b.doors.find((d) => d.lx === lx && d.ly === ly) ?? null;
}

/** Room area in floor tiles (rooms are rects of non-wall cells). */
export const roomArea = (r: BuildingRoom): number => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

/** Count of walkable tiles (floor + doors + reserved space). */
export function walkableCount(b: Building): number {
  let n = 0;
  for (const c of b.cells) if (isWalkableCell(c)) n++;
  return n;
}

/* -------------------------------- Generation -------------------------------- */

const GEN_BUDGET = 12;

const rectW = (r: Rect): number => r.x1 - r.x0 + 1;
const rectH = (r: Rect): number => r.y1 - r.y0 + 1;

/**
 * Generate a building. Deterministic: same opts → same building. Invalid
 * layouts are rejected and regenerated from the same deterministic seed
 * sequence; a clearly-diagnosed failure is thrown if the budget runs out.
 */
export function generateBuilding(opts: GenerateBuildingOpts): Building {
  const t = opts.template;
  const plotW = opts.plot?.w ?? t.maxW;
  const plotH = opts.plot?.h ?? t.maxH;
  if (plotW < t.minW || plotH < t.minH) {
    throw new BuildingGenerationError(
      `plot ${plotW}x${plotH} cannot fit template ${t.type} (needs at least ${t.minW}x${t.minH})`,
      opts.id,
      t.type,
      opts.seed,
      0,
      [],
    );
  }
  let lastProblems: string[] = [];
  for (let attempt = 0; attempt < GEN_BUDGET; attempt++) {
    const rng = new Rng(hash2(opts.seed ^ 0xb171, attempt + 1, 0x51ce));
    const b = attemptLayout(opts, rng, plotW, plotH);
    if (!b) continue;
    const problems = validateBuilding(b, t);
    if (problems.length === 0) return b;
    lastProblems = problems;
  }
  throw new BuildingGenerationError(
    `building generation failed after ${GEN_BUDGET} attempts`,
    opts.id,
    t.type,
    opts.seed,
    GEN_BUDGET,
    lastProblems,
  );
}

/** One layout attempt; null when the rolls cannot satisfy the template at all. */
function attemptLayout(opts: GenerateBuildingOpts, rng: Rng, plotW: number, plotH: number): Building | null {
  const t = opts.template;
  const w = Math.min(rng.int(t.minW, t.maxW), plotW);
  const h = Math.min(rng.int(t.minH, t.maxH), plotH);
  const ox = opts.origin?.x ?? 0;
  const oy = opts.origin?.y ?? 0;
  const cells: BuildingCellKind[] = new Array(w * h).fill("floor");
  const at = (lx: number, ly: number): BuildingCellKind => cells[ly * w + lx];
  const set = (lx: number, ly: number, k: BuildingCellKind): void => {
    cells[ly * w + lx] = k;
  };
  for (let lx = 0; lx < w; lx++) {
    set(lx, 0, "wall");
    set(lx, h - 1, "wall");
  }
  for (let ly = 1; ly < h - 1; ly++) {
    set(0, ly, "wall");
    set(w - 1, ly, "wall");
  }

  // ---- partition the interior into rooms (full-span wall lines → rect rooms) ----
  const target = Math.min(rng.int(t.minRooms, t.prefRooms), 4);
  const rects: Rect[] = [{ x0: 1, y0: 1, x1: w - 2, y1: h - 2 }];
  const canSplitV = (r: Rect): boolean => rectW(r) >= 2 * t.minRoomSide + 1;
  const canSplitH = (r: Rect): boolean => rectH(r) >= 2 * t.minRoomSide + 1;
  let guard = 0;
  while (rects.length < target && guard++ < 12) {
    const splittable = rects.map((r, i) => ({ r, i })).filter(({ r }) => canSplitV(r) || canSplitH(r));
    if (!splittable.length) break;
    // bias toward the largest room so space is spent where it is roomiest
    splittable.sort((a, b) => rectW(b.r) * rectH(b.r) - rectW(a.r) * rectH(a.r) || a.i - b.i);
    const pick = splittable[rng.int(0, Math.min(1, splittable.length - 1))]?.r ?? splittable[0].r;
    const ri = rects.indexOf(pick);
    const r = rects[ri];
    const v = canSplitV(r);
    const hz = canSplitH(r);
    // split along the roomier axis; ties and both-possible go through the rng
    const vertical = v && hz ? (rectW(r) === rectH(r) ? rng.next() < 0.5 : rectW(r) > rectH(r)) : v;
    if (vertical) {
      const wallX = rng.int(r.x0 + t.minRoomSide, r.x1 - t.minRoomSide);
      for (let ly = r.y0; ly <= r.y1; ly++) set(wallX, ly, "wall");
      rects[ri] = { x0: r.x0, y0: r.y0, x1: wallX - 1, y1: r.y1 };
      rects.push({ x0: wallX + 1, y0: r.y0, x1: r.x1, y1: r.y1 });
    } else if (hz) {
      const wallY = rng.int(r.y0 + t.minRoomSide, r.y1 - t.minRoomSide);
      for (let lx = r.x0; lx <= r.x1; lx++) set(lx, wallY, "wall");
      rects[ri] = { x0: r.x0, y0: r.y0, x1: r.x1, y1: wallY - 1 };
      rects.push({ x0: r.x0, y0: wallY + 1, x1: r.x1, y1: r.y1 });
    } else break;
  }
  if (rects.length < t.minRooms) return null;

  const rooms: BuildingRoom[] = rects.map((r, id) => ({
    id,
    type: id < t.roomTypes.length ? t.roomTypes[id] : t.extraRoomType,
    x0: r.x0,
    y0: r.y0,
    x1: r.x1,
    y1: r.y1,
  }));

  // ---- internal doors: a connected spanning of rooms, never wall-to-wall ----
  interface Edge {
    a: number;
    b: number;
    candidates: { lx: number; ly: number }[];
  }
  const edges: Edge[] = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i];
      const b = rooms[j];
      const candidates: { lx: number; ly: number }[] = [];
      if (b.x0 === a.x1 + 2 || a.x0 === b.x1 + 2) {
        const wallX = Math.max(a.x0, b.x0) === a.x1 + 2 ? a.x1 + 1 : b.x1 + 1;
        const yLo = Math.max(a.y0, b.y0);
        const yHi = Math.min(a.y1, b.y1);
        for (let ly = yLo; ly <= yHi; ly++) {
          if (at(wallX, ly) === "wall" && at(wallX - 1, ly) === "floor" && at(wallX + 1, ly) === "floor") candidates.push({ lx: wallX, ly });
        }
      } else if (b.y0 === a.y1 + 2 || a.y0 === b.y1 + 2) {
        const wallY = Math.max(a.y0, b.y0) === a.y1 + 2 ? a.y1 + 1 : b.y1 + 1;
        const xLo = Math.max(a.x0, b.x0);
        const xHi = Math.min(a.x1, b.x1);
        for (let lx = xLo; lx <= xHi; lx++) {
          if (at(lx, wallY) === "wall" && at(lx, wallY - 1) === "floor" && at(lx, wallY + 1) === "floor") candidates.push({ lx, ly: wallY });
        }
      }
      if (candidates.length) edges.push({ a: i, b: j, candidates });
    }
  }
  // spanning tree over room adjacency, shuffled deterministically
  const parent = rooms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const doors: BuildingDoor[] = [];
  const shuffled = edges.map((e) => ({ e, k: rng.next() })).sort((x, y) => x.k - y.k);
  for (const { e } of shuffled) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    parent[ra] = rb;
    const c = e.candidates[rng.int(0, e.candidates.length - 1)];
    set(c.lx, c.ly, "door");
    doors.push({ lx: c.lx, ly: c.ly, external: false, dir: null, roomA: e.a, roomB: e.b, type: "door" });
  }
  // an extra opening between roomy neighbours keeps bigger buildings flowing
  const linked = (a: number, b2: number): boolean =>
    doors.some((d) => !d.external && ((d.roomA === a && d.roomB === b2) || (d.roomA === b2 && d.roomB === a)));
  for (const { e } of shuffled) {
    const lo = Math.min(e.a, e.b);
    const hi = Math.max(e.a, e.b);
    if (linked(lo, hi) || rng.next() > 0.3) continue;
    const c = e.candidates[rng.int(0, e.candidates.length - 1)];
    if (at(c.lx, c.ly) !== "wall") continue;
    set(c.lx, c.ly, "door");
    doors.push({ lx: c.lx, ly: c.ly, external: false, dir: null, roomA: lo, roomB: hi, type: "opening" });
  }

  // ---- exterior entrance: a wall gap opening onto acceptable outside ground ----
  interface EntranceCandidate {
    lx: number;
    ly: number;
    side: Dir;
    room: number;
  }
  const entrances: EntranceCandidate[] = [];
  for (let lx = 1; lx < w - 1; lx++) {
    if (at(lx, 1) === "floor" && entranceAllowed(opts, "n", ox + lx, oy - 1)) entrances.push({ lx, ly: 0, side: "n", room: roomIdCovering(rooms, lx, 1) });
    if (at(lx, h - 2) === "floor" && entranceAllowed(opts, "s", ox + lx, oy + h)) entrances.push({ lx, ly: h - 1, side: "s", room: roomIdCovering(rooms, lx, h - 2) });
  }
  for (let ly = 1; ly < h - 1; ly++) {
    if (at(1, ly) === "floor" && entranceAllowed(opts, "w", ox - 1, oy + ly)) entrances.push({ lx: 0, ly, side: "w", room: roomIdCovering(rooms, 1, ly) });
    if (at(w - 2, ly) === "floor" && entranceAllowed(opts, "e", ox + w, oy + ly)) entrances.push({ lx: w - 1, ly, side: "e", room: roomIdCovering(rooms, w - 2, ly) });
  }
  if (!entrances.length) return null;
  const ent = entrances[rng.int(0, entrances.length - 1)];
  set(ent.lx, ent.ly, "door");
  doors.push({ lx: ent.lx, ly: ent.ly, external: true, dir: ent.side, roomA: ent.room, roomB: null, type: "door" });

  // ---- reserved space: floor held back per room for future interactables ----
  const reserved: ReservedSpot[] = [];
  for (const room of rooms) {
    const nextToDoor = (lx: number, ly: number): boolean =>
      doors.some((d) => Math.abs(d.lx - lx) + Math.abs(d.ly - ly) === 1);
    const quiet: { lx: number; ly: number }[] = [];
    const any: { lx: number; ly: number }[] = [];
    for (let ly = room.y0; ly <= room.y1; ly++) {
      for (let lx = room.x0; lx <= room.x1; lx++) {
        if (at(lx, ly) !== "floor") continue;
        any.push({ lx, ly });
        if (!nextToDoor(lx, ly)) quiet.push({ lx, ly });
      }
    }
    if (!any.length) return null;
    const pool = quiet.length ? quiet : any;
    for (let k = 0; k < Math.max(1, t.reservedPerRoom) && pool.length; k++) {
      const idx = rng.int(0, pool.length - 1);
      const spot = pool.splice(idx, 1)[0];
      set(spot.lx, spot.ly, "reserved");
      reserved.push({ lx: spot.lx, ly: spot.ly, purpose: RESERVED_FOR[room.type] });
    }
    if (!reserved.some((s) => s.lx >= room.x0 && s.lx <= room.x1 && s.ly >= room.y0 && s.ly <= room.y1)) return null;
  }

  return { id: opts.id, type: t.type, x: ox, y: oy, w, h, cells, rooms, doors, reserved };
}

function entranceAllowed(opts: GenerateBuildingOpts, side: Dir, wx: number, wy: number): boolean {
  return opts.exitOk ? opts.exitOk(side, wx, wy) : true;
}

function roomIdCovering(rooms: BuildingRoom[], lx: number, ly: number): number {
  const r = rooms.find((rr) => lx >= rr.x0 && lx <= rr.x1 && ly >= rr.y0 && ly <= rr.y1);
  return r ? r.id : 0;
}

/* -------------------------------- Validation -------------------------------- */

/**
 * Full structural validation of a generated building. Returns a list of
 * human-readable problems (empty when the building is sound). Every problem
 * names the building, room or tile responsible so bad layouts are debuggable.
 */
export function validateBuilding(b: Building, template?: BuildingTemplate): string[] {
  const problems: string[] = [];
  const tag = (s: string): string => `[${b.id}] ${s}`;
  const at = (lx: number, ly: number): BuildingCellKind | null => cellKindAt(b, lx, ly);

  // structure
  if (b.w < 4 || b.h < 4) problems.push(tag(`footprint ${b.w}x${b.h} is too small to be a building`));
  if (b.cells.length !== b.w * b.h) problems.push(tag("cell grid does not match footprint"));
  // the perimeter is solid wall except for doorway gaps (entrances live there)
  const solid = (k: BuildingCellKind | null): boolean => k === "wall" || k === "door";
  for (let lx = 0; lx < b.w; lx++) {
    if (!solid(at(lx, 0)) || !solid(at(lx, b.h - 1))) problems.push(tag(`exterior wall broken at (${lx},0) or (${lx},${b.h - 1})`));
  }
  for (let ly = 0; ly < b.h; ly++) {
    if (!solid(at(0, ly)) || !solid(at(b.w - 1, ly))) problems.push(tag(`exterior wall broken at (0,${ly}) or (${b.w - 1},${ly})`));
  }

  // rooms
  if (b.rooms.length < (template?.minRooms ?? 2)) problems.push(tag(`only ${b.rooms.length} rooms (need ${template?.minRooms ?? 2})`));
  const minSide = template?.minRoomSide ?? 2;
  const minArea = template?.minRoomArea ?? 4;
  for (const r of b.rooms) {
    if (rectW(r) < minSide || rectH(r) < minSide) problems.push(tag(`room ${r.id} (${r.x0},${r.y0}..${r.x1},${r.y1}) is narrower than ${minSide} tiles`));
    if (roomArea(r) < minArea) problems.push(tag(`room ${r.id} has only ${roomArea(r)} tiles of floor`));
    for (let ly = r.y0; ly <= r.y1; ly++) {
      for (let lx = r.x0; lx <= r.x1; lx++) {
        const k = at(lx, ly);
        if (k !== "floor" && k !== "reserved") problems.push(tag(`room ${r.id} contains a ${k} cell at (${lx},${ly})`));
      }
    }
  }
  for (let i = 0; i < b.rooms.length; i++) {
    for (let j = i + 1; j < b.rooms.length; j++) {
      const a = b.rooms[i];
      const c = b.rooms[j];
      if (a.x0 <= c.x1 && c.x0 <= a.x1 && a.y0 <= c.y1 && c.y0 <= a.y1) problems.push(tag(`rooms ${a.id} and ${c.id} overlap`));
    }
  }

  // doors
  const external = b.doors.filter((d) => d.external);
  if (!external.length) problems.push(tag("has no exterior entrance"));
  for (const d of b.doors) {
    if (at(d.lx, d.ly) !== "door") problems.push(tag(`door at (${d.lx},${d.ly}) is not a door cell`));
    if (d.external) {
      const inward: [number, number] | null = d.dir === "n" ? [d.lx, d.ly + 1] : d.dir === "s" ? [d.lx, d.ly - 1] : d.dir === "w" ? [d.lx + 1, d.ly] : d.dir === "e" ? [d.lx - 1, d.ly] : null;
      if (!d.dir || !inward || !isWalkableCell(at(inward[0], inward[1]))) problems.push(tag(`exterior entrance at (${d.lx},${d.ly}) opens into ${inward ? `a ${at(inward[0], inward[1])}` : "nowhere"}`));
      else if (d.dir === "n" && d.ly !== 0) problems.push(tag(`north entrance at (${d.lx},${d.ly}) is not on the north wall`));
      else if (d.dir === "s" && d.ly !== b.h - 1) problems.push(tag(`south entrance at (${d.lx},${d.ly}) is not on the south wall`));
      else if (d.dir === "w" && d.lx !== 0) problems.push(tag(`west entrance at (${d.lx},${d.ly}) is not on the west wall`));
      else if (d.dir === "e" && d.lx !== b.w - 1) problems.push(tag(`east entrance at (${d.lx},${d.ly}) is not on the east wall`));
    } else {
      if (d.roomA === d.roomB) problems.push(tag(`internal door at (${d.lx},${d.ly}) connects room ${d.roomA} to itself`));
      if (d.roomB === null) problems.push(tag(`internal door at (${d.lx},${d.ly}) connects to nothing`));
      const horiz = at(d.lx - 1, d.ly) !== "wall" && at(d.lx + 1, d.ly) !== "wall";
      const vert = at(d.lx, d.ly - 1) !== "wall" && at(d.lx, d.ly + 1) !== "wall";
      if (!horiz && !vert) problems.push(tag(`internal door at (${d.lx},${d.ly}) connects wall to wall`));
    }
  }

  // connectivity: every room reachable from the entrance through walkable cells
  if (external.length) {
    const d = external[0];
    const start: [number, number] | null = d.dir === "n" ? [d.lx, d.ly + 1] : d.dir === "s" ? [d.lx, d.ly - 1] : d.dir === "w" ? [d.lx + 1, d.ly] : d.dir === "e" ? [d.lx - 1, d.ly] : null;
    if (start && isWalkableCell(at(start[0], start[1]))) {
      const seen = new Set<number>([start[1] * b.w + start[0]]);
      const queue: [number, number][] = [start];
      while (queue.length) {
        const [cx, cy] = queue.shift()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          const key = ny * b.w + nx;
          if (seen.has(key) || !isWalkableCell(at(nx, ny))) continue;
          seen.add(key);
          queue.push([nx, ny]);
        }
      }
      for (const r of b.rooms) {
        let reached = 0;
        for (let ly = r.y0; ly <= r.y1 && reached === 0; ly++) {
          for (let lx = r.x0; lx <= r.x1; lx++) {
            if (seen.has(ly * b.w + lx)) {
              reached++;
              break;
            }
          }
        }
        if (!reached) problems.push(tag(`room ${r.id} (${r.type}) is unreachable from the entrance`));
      }
    } else problems.push(tag("entrance opens into solid wall — interior unreachable"));
  }

  // movement capacity
  const walk = walkableCount(b);
  if (walk < 8) problems.push(tag(`only ${walk} walkable tiles`));
  if (walk < b.w * b.h * 0.3) problems.push(tag(`walls consume the footprint (${walk}/${b.w * b.h} walkable)`));

  // future interaction capacity
  if (b.reserved.length < b.rooms.length) problems.push(tag(`only ${b.reserved.length} reserved spots for ${b.rooms.length} rooms`));
  for (const r of b.rooms) {
    const spots = b.reserved.filter((s) => s.lx >= r.x0 && s.lx <= r.x1 && s.ly >= r.y0 && s.ly <= r.y1);
    if (!spots.length) problems.push(tag(`room ${r.id} (${r.type}) has no reserved space`));
  }

  return problems;
}
