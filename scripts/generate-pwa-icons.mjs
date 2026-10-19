#!/usr/bin/env node
/**
 * PWA icon generator — emits the 192×192 + 512×512 PNG icons the web app
 * manifest references, using ONLY Node built-ins (node:fs, node:zlib).
 *
 * No new runtime dependency: this is a one-time build
 * tool, not a runtime import. It hand-encodes PNGs (signature + IHDR +
 * zlib-compressed IDAT + IEND + per-chunk CRC-32) so no `sharp`/`canvas`
 * dependency is needed. The icon is a brand mark: the harness accent
 * (#7c8cf8) as a filled disc on the dark base (#0d0f14), with a smaller
 * inner disc in a lighter accent — a simple, recognizable glyph that
 * scales cleanly (the SVG sibling carries the same design for crispness).
 *
 * Run once after checkout (or whenever the brand colors change):
 *  node scripts/generate-pwa-icons.mjs
 * Output: public/icons/icon-192.png, public/icons/icon-512.png
 */
// The one checkout writer (the checkout write door + atomic rename): a
// generator run under a test runner cannot rewrite the runner's checkout.
import { atomicWriteFile } from "../engine/src/filesystem/atomic-write.ts";
import { deflateSync, crc32 } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "..", "public", "icons");

// Brand colors (mirror src/styles/tokens.css :root defaults).
const BG = [0x0d, 0x0f, 0x14]; // --color-bg-base
const ACCENT = [0x7c, 0x8c, 0xf8]; // --color-accent
const ACCENT_HI = [0x9b, 0xa5, 0xfa]; // --color-accent-hover

/** Pack a 32-bit big-endian integer. */
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** Build a PNG chunk: length + type + data + CRC32(type+data). */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  return Buffer.concat([u32(data.length), typeBuf, data, u32(crc32(Buffer.concat([typeBuf, data])))]);
}

/**
 * Render the icon at `size`×`size` and return a PNG Buffer. Pure pixel
 * math: a filled accent disc on the dark base, with a smaller inner disc
 * in the lighter accent (a "lens" mark). Anti-aliased on the outer edge
 * by alpha-blending against the background using a coverage approximation.
 */
function renderIconPng(size) {
  const r = size / 2;
  const outerR = size * 0.40; // outer disc radius (fraction of size)
  const innerR = size * 0.16; // inner disc radius
  const cx = r;
  const cy = r;
  // RGB row data: each scanline is [filterByte, R,G,B, R,G,B, ...].
  const rowLen = size * 3;
  const raw = Buffer.alloc((rowLen + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowOff = y * (rowLen + 1);
    raw[rowOff] = 0; // filter type 0 (None)
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let px = [BG[0], BG[1], BG[2]];
      if (dist <= innerR) {
        px = ACCENT_HI;
      } else if (dist <= outerR) {
        // Anti-alias the outer edge over ~1px.
        const coverage = Math.max(0, Math.min(1, outerR - dist));
        px = [
          Math.round(BG[0] + (ACCENT[0] - BG[0]) * coverage),
          Math.round(BG[1] + (ACCENT[1] - BG[1]) * coverage),
          Math.round(BG[2] + (ACCENT[2] - BG[2]) * coverage),
        ];
      }
      const off = rowOff + 1 + x * 3;
      raw[off] = px[0];
      raw[off + 1] = px[1];
      raw[off + 2] = px[2];
    }
  }
  // IHDR: width, height, bit depth 8, color type 2 (truecolor RGB),
  // compression 0, filter 0, interlace 0.
  const ihdr = Buffer.concat([u32(size), u32(size), Buffer.from([8, 2, 0, 0, 0])]);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const size of [192, 512]) {
  const png = renderIconPng(size);
  const out = resolve(OUT_DIR, `icon-${size}.png`);
  // Served files: world-readable like every other file under public/.
  const result = atomicWriteFile(out, png, { exactMode: 0o644 });
  if (!result.success) throw new Error(`[pwa-icons] could not write ${out}: ${result.reason ?? "unknown"}`);
  console.log(`[pwa-icons] wrote ${out} (${png.length} bytes)`);
}
