/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BODIES,
  EYE_COLORS,
  FACES,
  HAIR_COLORS,
  HAIRS,
  HEADS,
  OUTFIT_COLORS,
  SKIN_TONES,
  SLOT,
  SPRITE_H,
  SPRITE_W,
  STRUCTURAL_COMBINATIONS,
  assetFiles,
  colorDistance,
  composeLook,
  decodePart,
  defaultLook,
  ensureRosterLooks,
  generateLook,
  hexToRgb,
  lookKey,
  lookSilhouette,
  luma,
  ramp,
  resolveLook,
  validatePart,
  validateRegistry,
  type PartMap,
  type TamerLook,
} from "@/game/appearance";
import { migrateLoaded } from "@/game/migrate";
import { newGame, previewStarter, SAVE_VERSION } from "@/game/sim";
import type { GameState } from "@/game/types";
import { decodePng } from "../../scripts/tamer-art/png";

const parts = new Map<string, PartMap>();
const fileProblems: string[] = [];
for (const f of assetFiles()) {
  const png = decodePng(new Uint8Array(readFileSync(new URL(`../../public${f.src}`, import.meta.url))));
  const dec = decodePart(png.w, png.h, png.rgba);
  fileProblems.push(...validatePart(f, png.w, png.h, dec));
  parts.set(f.src, dec.map);
}
const getPart = (src: string): PartMap | undefined => parts.get(src);

const game = (seed: string): GameState => newGame(seed, "Rook", "ranger", "#e8742a", previewStarter(seed, "mossback"));

/** Pixel indices whose color differs between two compositions. */
function diffPixels(a: Uint8ClampedArray, b: Uint8ClampedArray): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length / 4; i++) {
    if (a[i * 4] !== b[i * 4] || a[i * 4 + 1] !== b[i * 4 + 1] || a[i * 4 + 2] !== b[i * 4 + 2] || a[i * 4 + 3] !== b[i * 4 + 3]) out.push(i);
  }
  return out;
}

const other = <T extends { id: string }>(list: T[], id: string): T => list.find((s) => s.id !== id && s.id !== list[0].id) ?? list.find((s) => s.id !== id)!;

describe("asset registry", () => {
  it("is internally valid with the required part counts", () => {
    expect(validateRegistry()).toEqual([]);
    expect(BODIES).toHaveLength(4);
    expect(HEADS).toHaveLength(4);
    expect(FACES).toHaveLength(4);
    expect(HAIRS).toHaveLength(6);
    expect(STRUCTURAL_COMBINATIONS).toBe(384);
    expect(HAIRS.filter((h) => h.length === "short")).toHaveLength(2);
    expect(HAIRS.filter((h) => h.length === "medium")).toHaveLength(2);
    expect(HAIRS.filter((h) => h.length === "long")).toHaveLength(2);
  });

  it("every body has independent skin and one region per garment", () => {
    for (const b of BODIES) {
      expect(b.slots).toContain(SLOT.skin);
      const slots = (b.garments ?? []).map((g) => g.slot);
      expect(new Set(slots).size).toBe(slots.length);
      expect(slots.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("every registered file exists, decodes at its declared size, and uses exactly its declared regions", () => {
    expect(fileProblems).toEqual([]);
    expect(parts.size).toBe(assetFiles().length);
  });

  it("palettes produce four distinct, monotonic shades for every swatch", () => {
    const all = [...SKIN_TONES, ...HAIR_COLORS, ...EYE_COLORS, ...Object.values(OUTFIT_COLORS).flat()];
    for (const s of all) {
      const r = ramp(s.hex);
      for (let i = 1; i < 4; i++) expect(luma(r[i]), `${s.id} shade ${i}`).toBeGreaterThan(luma(r[i - 1]));
    }
    expect(SKIN_TONES.length).toBeGreaterThanOrEqual(12);
    expect(HAIR_COLORS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("compositor", () => {
  it("composes all 384 structural combinations with no missing layers or stray regions", () => {
    let n = 0;
    for (const b of BODIES) for (const h of HEADS) for (const f of FACES) for (const hr of HAIRS) {
      const c = composeLook({ ...defaultLook(), body: b.id, head: h.id, face: f.id, hair: hr.id, outfit: {} }, getPart);
      expect(c.missing).toEqual([]);
      expect(c.w).toBe(SPRITE_W);
      expect(c.h).toBe(SPRITE_H);
      expect(c.region.some((r) => r.startsWith("invalid"))).toBe(false);
      // feet on the bottom row, every layer present
      expect(c.layer.slice((SPRITE_H - 1) * SPRITE_W).some((l) => l === "body")).toBe(true);
      for (const l of ["body", "head", "face", "hair-front"]) expect(c.layer.includes(l), `${l} in ${b.id}/${h.id}/${f.id}/${hr.id}`).toBe(true);
      n++;
    }
    expect(n).toBe(384);
  });

  it("front hair never covers the eyes, brows or mouth of any head/face/hair combination", () => {
    const noFront = (src: string) => (src.includes("hair_") ? undefined : parts.get(src));
    for (const h of HEADS) for (const f of FACES) for (const hr of HAIRS) for (const expression of ["neutral", "grin"] as const) {
      const look: TamerLook = { ...defaultLook(), head: h.id, face: f.id, hair: hr.id, expression };
      const withHair = composeLook(look, getPart);
      const bare = composeLook(look, noFront);
      const features = bare.region.map((r, i) => (["iris", "sclera", "mouth", "brow"].includes(r) ? i : -1)).filter((i) => i >= 0);
      expect(features.length).toBeGreaterThan(0);
      for (const i of features) expect(withHair.region[i], `${hr.id} over ${f.id}/${h.id} at ${i % SPRITE_W},${Math.floor(i / SPRITE_W)}`).toBe(bare.region[i]);
    }
  });

  it("recoloring one garment changes only that garment's pixels, and all of them", () => {
    for (const b of BODIES) {
      const base: TamerLook = { ...defaultLook(), body: b.id, outfit: {} };
      const baseLook = resolveLook(base).look;
      const c0 = composeLook(baseLook, getPart);
      for (const g of b.garments ?? []) {
        const swap = other(OUTFIT_COLORS[g.palette], baseLook.outfit[g.id]);
        const c1 = composeLook({ ...baseLook, outfit: { ...baseLook.outfit, [g.id]: swap.id } }, getPart);
        const changed = diffPixels(c0.rgba, c1.rgba);
        const owned = c0.region.map((r, i) => (r === `garment:${g.id}` ? i : -1)).filter((i) => i >= 0);
        expect(owned.length, `${b.id}.${g.id} visible`).toBeGreaterThan(0);
        for (const i of changed) expect(c0.region[i], `${b.id}.${g.id} leaked`).toBe(`garment:${g.id}`);
        expect(changed.length, `${b.id}.${g.id} fully recolored`).toBe(owned.length);
      }
    }
  });

  it("skin, hair and eye recolors stay inside their regions", () => {
    const base = resolveLook({ ...defaultLook(), body: "body.brawler", hair: "hair.mane", face: "face.easy" }).look;
    const c0 = composeLook(base, getPart);
    const check = (patch: Partial<TamerLook>, allowed: string[], must: string) => {
      const c1 = composeLook({ ...base, ...patch }, getPart);
      const changed = diffPixels(c0.rgba, c1.rgba);
      expect(changed.length).toBeGreaterThan(0);
      for (const i of changed) expect(allowed).toContain(c0.region[i]);
      // every pixel of the primary region recolors (head, body midriff/arms, all of it)
      const owned = c0.region.filter((r) => r === must).length;
      expect(changed.filter((i) => c0.region[i] === must).length).toBe(owned);
    };
    // lips are derived from the skin tone; brows from the hair color
    check({ skin: other(SKIN_TONES, base.skin).id }, ["skin", "mouth"], "skin");
    check({ hairColor: other(HAIR_COLORS, base.hairColor).id }, ["hair", "brow"], "hair");
    check({ eyes: other(EYE_COLORS, base.eyes).id }, ["iris"], "iris");
  });

  it("recoloring preserves shading: each region keeps one color per authored shade", () => {
    const look = generateLook(1234);
    const c = composeLook(look, getPart);
    const colors = new Map<string, Set<string>>();
    c.region.forEach((r, i) => {
      if (!r) return;
      const k = `${c.rgba[i * 4]},${c.rgba[i * 4 + 1]},${c.rgba[i * 4 + 2]}`;
      (colors.get(r) ?? colors.set(r, new Set()).get(r)!).add(k);
    });
    expect(colors.get("skin")!.size).toBeGreaterThanOrEqual(3);
    for (const [r, set] of colors) if (r.startsWith("garment:")) expect(set.size, r).toBeGreaterThanOrEqual(2);
  });

  it("pixels painted with a slot the part does not declare are never drawn", () => {
    const body = BODIES[0];
    const undeclared = [8, 9, 10, 11, 12, 13].find((s) => !body.slots.includes(s))!;
    expect(undeclared).toBeDefined();
    const real = parts.get(body.src)!;
    const tampered: PartMap = { ...real, slot: real.slot.slice(), shade: real.shade.slice() };
    const idx = 20 * real.w + 16;
    tampered.slot[idx] = undeclared;
    const c = composeLook({ ...defaultLook(), body: body.id }, (src) => (src === body.src ? tampered : parts.get(src)));
    expect(c.region.some((r) => r.startsWith("invalid"))).toBe(false);
    // the tampered pixel (body origin is sprite row 16) shows nothing from the undeclared slot
    const at = (16 + 20) * SPRITE_W + 16;
    expect(c.region[at]).not.toMatch(/invalid/);
  });

  it("missing assets and invalid looks fall back without throwing", () => {
    const look = generateLook(77);
    const noFace = composeLook(look, (src) => (src.includes("/face_") ? undefined : parts.get(src)));
    expect(noFace.missing.some((m) => m.includes("face_"))).toBe(true);
    expect(noFace.layer.includes("body")).toBe(true);
    const nothing = composeLook(look, () => null);
    expect(nothing.rgba.every((v) => v === 0)).toBe(true);
    for (const junk of [null, undefined, 42, "x", {}, { body: "body.nope", skin: 3, outfit: "red" }] as unknown[]) {
      expect(() => composeLook(junk as TamerLook, getPart)).not.toThrow();
      const r = resolveLook(junk);
      expect(r.ok).toBe(false);
      expect(resolveLook(r.look).ok).toBe(true);
    }
  });
});

describe("generator", () => {
  it("is deterministic and always produces a valid look", () => {
    for (let s = 0; s < 400; s++) {
      const a = generateLook(s * 7919 + 13);
      expect(a).toEqual(generateLook(s * 7919 + 13));
      expect(resolveLook(a).ok).toBe(true);
    }
  });

  it("uses every part freely (no gender lock) and keeps hair readable against skin", () => {
    const seen = new Set<string>();
    const combos = new Set<string>();
    let lowContrast = 0;
    for (let s = 0; s < 2000; s++) {
      const l = generateLook(s + 1);
      seen.add(l.body).add(l.head).add(l.face).add(l.hair);
      combos.add(`${l.body}|${l.face}`);
      const d = colorDistance(hexToRgb(HAIR_COLORS.find((h) => h.id === l.hairColor)!.hex), hexToRgb(SKIN_TONES.find((h) => h.id === l.skin)!.hex));
      if (d < 60) lowContrast++;
    }
    expect(seen.size).toBe(18);
    // every face on every body
    expect(combos.size).toBe(16);
    expect(lowContrast / 2000).toBeLessThan(0.02);
  });
});

describe("persistence", () => {
  it("every rival is born with a distinct, valid look, the same for the same world", () => {
    const a = game("LOOK-A");
    const b = game("LOOK-A");
    const ta = Object.values(a.tamers ?? {});
    expect(ta.length).toBeGreaterThanOrEqual(8);
    for (const t of ta) expect(resolveLook(t.look).ok).toBe(true);
    expect(new Set(ta.map((t) => lookSilhouette(t.look!))).size).toBe(ta.length);
    expect(ta.map((t) => t.look)).toEqual(Object.values(b.tamers ?? {}).map((t) => t.look));
    const c = game("LOOK-C");
    expect(ta.map((t) => lookKey(t.look!))).not.toEqual(Object.values(c.tamers ?? {}).map((t) => lookKey(t.look!)));
  }, 120_000);

  it("appearance never changes gameplay state: rerolling looks leaves everything else identical", () => {
    const a = game("LOOK-G");
    const strip = (gs: GameState) => JSON.stringify(Object.values(gs.tamers ?? {}).map(({ look: _look, ...rest }) => rest));
    const before = strip(a);
    for (const t of Object.values(a.tamers ?? {})) delete t.look;
    ensureRosterLooks(a.seed, a.tamers!);
    expect(strip(a)).toBe(before);
  }, 120_000);

  it("survives save and load unchanged", () => {
    const a = game("LOOK-S");
    const looks = Object.values(a.tamers ?? {}).map((t) => t.look);
    const loaded = JSON.parse(JSON.stringify(a)) as GameState;
    expect(migrateLoaded(loaded)).toBe(true);
    expect(loaded.version).toBe(SAVE_VERSION);
    expect(Object.values(loaded.tamers ?? {}).map((t) => t.look)).toEqual(looks);
  }, 120_000);

  it("an old save without looks gains the same looks a new game would, idempotently", () => {
    const fresh = game("LOOK-M");
    const old = JSON.parse(JSON.stringify(fresh)) as GameState;
    old.version = 23;
    for (const t of Object.values(old.tamers ?? {})) delete t.look;
    expect(migrateLoaded(old)).toBe(true);
    expect(Object.values(old.tamers ?? {}).map((t) => t.look)).toEqual(Object.values(fresh.tamers ?? {}).map((t) => t.look));
    const once = JSON.stringify(old);
    const again = JSON.parse(once) as GameState;
    expect(migrateLoaded(again)).toBe(true);
    expect(JSON.stringify(again)).toBe(once);
  }, 120_000);

  it("a damaged stored look is repaired field by field; valid looks elsewhere are untouched", () => {
    const gs = game("LOOK-R");
    const [t1, t2] = Object.values(gs.tamers ?? {});
    const keep = JSON.stringify(t2.look);
    const bad = { ...t1.look!, body: "body.missing", skin: "chartreuse", outfit: { coat: "nope", ghost: "red" } };
    t1.look = bad as TamerLook;
    const saved = JSON.parse(JSON.stringify(gs)) as GameState;
    expect(migrateLoaded(saved)).toBe(true);
    const fixed = saved.tamers![t1.id].look!;
    expect(resolveLook(fixed).ok).toBe(true);
    expect(fixed.head).toBe(bad.head);
    expect(fixed.hair).toBe(bad.hair);
    expect(Object.keys(fixed.outfit)).not.toContain("ghost");
    expect(JSON.stringify(saved.tamers![t2.id].look)).toBe(keep);
  }, 120_000);
});
