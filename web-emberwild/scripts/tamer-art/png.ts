/// <reference types="node" />
/**
 * Minimal RGBA PNG encode/decode for the tamer art pipeline and its tests
 * (8-bit RGBA, non-interlaced — exactly what the build script writes).
 */
import { deflateSync, inflateSync } from "node:zlib";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(w: number, h: number, rgba: ArrayLike<number>): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let i = 0; i < w * 4; i++) raw[y * (w * 4 + 1) + 1 + i] = rgba[y * w * 4 + i];
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function decodePng(buf: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 8;
  let w = 0, h = 0, colorType = 0, depth = 0;
  const idat: Uint8Array[] = [];
  while (o < buf.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      w = dv.getUint32(o + 8);
      h = dv.getUint32(o + 12);
      depth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (depth !== 8 || colorType !== 6) throw new Error(`unsupported PNG (depth ${depth}, color type ${colorType})`);
  const joined = new Uint8Array(idat.reduce((s, p) => s + p.length, 0));
  let j = 0;
  for (const p of idat) {
    joined.set(p, j);
    j += p.length;
  }
  const raw = new Uint8Array(inflateSync(joined));
  const stride = w * 4;
  const rgba = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0;
      let r = v;
      if (f === 1) r = v + a;
      else if (f === 2) r = v + b;
      else if (f === 3) r = v + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      rgba[y * stride + x] = r & 255;
    }
  }
  return { w, h, rgba };
}
