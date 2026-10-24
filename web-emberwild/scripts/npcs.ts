/**
 * Hamlet folk sprite pipeline.
 *
 *   bun scripts/npcs.ts   — fetch the role portraits, key the white background,
 *                           trim, resize, export to public/npcs + QA sheet
 *
 * The portraits are pixel-art style studio shots on pure white; the key is a
 * border flood only (see stripWhiteBackground) so clothing whites survive.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { decodePng, encodePng, resize, trim, contactSheet } from "./sprites";
import { stripWhiteBackground, type RawImage } from "../src/game/spritebg";

const OUT_DIR = "public/npcs";
const QA_PATH = "/tmp/npcart/out_contact.png";

const ROLES: Record<string, string> = {
  innkeep: "/tmp/npcart/innkeeper.png",
  trader: "/tmp/npcart/merchant.png",
  penkeeper: "/tmp/npcart/penkeeper.png",
};

mkdirSync(OUT_DIR, { recursive: true });
const outs: RawImage[] = [];
for (const [role, path] of Object.entries(ROLES)) {
  const buf = await Bun.file(path).arrayBuffer();
  const src = decodePng(new Uint8Array(buf));
  const out = resize(trim(stripWhiteBackground(src)), 320);
  writeFileSync(`${OUT_DIR}/${role}.png`, encodePng(out));
  outs.push(out);
  console.log(`${role} (${src.w}x${src.h} -> ${out.w}x${out.h})`);
}
writeFileSync(QA_PATH, encodePng(contactSheet(outs, 340)));
console.log(`QA sheet: ${QA_PATH}`);
