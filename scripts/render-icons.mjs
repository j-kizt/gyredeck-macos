#!/usr/bin/env node
// Regenerates every app/tray icon. Run with `pnpm icons:render`.
//
// The .svg files under apps/desktop/assets are the design reference, but nothing
// on a stock macOS box rasterizes them correctly: qlmanage — the only SVG
// thumbnailer present — composites onto opaque white, which fills the rounded
// corners and turns the all-white tray mark into a solid block. Rather than add
// a native toolchain (a lone .swift file makes CodeQL auto-detect Swift, whose
// autobuild then fails for want of an Xcode project), the three primitives the
// mark needs are drawn here directly: signed distance fields for coverage,
// straight alpha compositing in sRGB, and a hand-rolled PNG writer over
// node:zlib. Keep the SVGs in sync by hand when the geometry below changes.

import { deflateSync } from "node:zlib";
import { writeFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- geometry (design space is 1024x1024, y down, matching the SVGs) ----
const CX = 512, CY = 512;
const START = (-15 * Math.PI) / 180;  // 60 degree gap at the upper right
const SPAN = (300 * Math.PI) / 180;

const APP = { radius: 245, stroke: 92, core: 86 };
// The app icon's margin exists for its rounded plate. The tray has no plate, so
// reusing those proportions renders the status item at 59% of the frame —
// visibly smaller than its neighbours. Same shape, scaled 1.669x to fill ~98%.
const TRAY = { radius: 409, stroke: 187, core: 173 };

const PLATE_RADIUS = 224;
const PLATE = [0x0e, 0x17, 0x26];
const GRAD_FROM = [0x2b, 0x5f, 0xa8];
const GRAD_TO = [0x4b, 0xa3, 0xc7];
const CORE = [0x7e, 0xc8, 0xe3];
const WHITE = [0xff, 0xff, 0xff];
const GRAD_P0 = [221, 221], GRAD_P1 = [803, 803];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Distance from p to the arc's centreline; round caps fall out of the endpoint
// distance, so a stroke is just |d| - width/2.
function arcDistance(x, y, radius) {
  const dx = x - CX, dy = y - CY;
  let t = Math.atan2(dy, dx) - START;
  t -= Math.floor(t / (Math.PI * 2)) * (Math.PI * 2);
  if (t <= SPAN) return Math.abs(Math.hypot(dx, dy) - radius);
  const ends = [START, START + SPAN].map((a) => [CX + radius * Math.cos(a), CY + radius * Math.sin(a)]);
  return Math.min(...ends.map(([ex, ey]) => Math.hypot(x - ex, y - ey)));
}

function roundedRectDistance(x, y, size, r) {
  const qx = Math.abs(x - size / 2) - (size / 2 - r);
  const qy = Math.abs(y - size / 2) - (size / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// One pixel of coverage from a signed distance, in device pixels.
const cover = (dist, scale) => clamp01(0.5 - dist * scale);

function gradientAt(x, y) {
  const [x0, y0] = GRAD_P0, [x1, y1] = GRAD_P1;
  const dx = x1 - x0, dy = y1 - y0;
  const t = clamp01(((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy));
  return GRAD_FROM.map((c, i) => c + (GRAD_TO[i] - c) * t);
}

// Straight alpha source-over, on sRGB byte values as CoreGraphics does.
function over(px, o, rgb, a) {
  if (a <= 0) return;
  const dst = px[o + 3] / 255;
  const out = a + dst * (1 - a);
  for (let i = 0; i < 3; i++) {
    const d = px[o + i];
    px[o + i] = Math.round((rgb[i] * a + d * dst * (1 - a)) / out);
  }
  px[o + 3] = Math.round(out * 255);
}

function render(size, { plate, geom, mono }) {
  const px = new Uint8Array(size * size * 4);
  const scale = size / 1024;              // design units -> device pixels
  const inv = 1 / scale;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const dx = (x + 0.5) * inv, dy = (y + 0.5) * inv;   // pixel centre
      if (plate) over(px, o, PLATE, cover(roundedRectDistance(dx, dy, 1024, PLATE_RADIUS), scale));
      const ring = cover(arcDistance(dx, dy, geom.radius) - geom.stroke / 2, scale);
      over(px, o, mono ?? gradientAt(dx, dy), ring);
      const core = cover(Math.hypot(dx - CX, dy - CY) - geom.core, scale);
      over(px, o, mono ?? CORE, core);
    }
  }
  return px;
}

// ---- minimal PNG writer (RGBA8, filter 0, sRGB-tagged) ----
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;   // filter: none
    Buffer.from(px.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("sRGB", Buffer.from([0])),          // rendering intent: perceptual
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- outputs ----
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "apps/desktop/src-tauri/icons");
const assets = join(root, "apps/desktop/assets");

const appIcon = (size) => encodePng(render(size, { plate: true, geom: APP }), size);
const trayIcon = (size) => encodePng(render(size, { plate: false, geom: TRAY, mono: WHITE }), size);

const work = mkdtempSync(join(tmpdir(), "gyredeck-icons-"));
try {
  const iconset = join(work, "icon.iconset");
  execFileSync("mkdir", ["-p", iconset]);
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${s}x${s}.png`), appIcon(s));
    writeFileSync(join(iconset, `icon_${s}x${s}@2x.png`), appIcon(s * 2));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(icons, "icon.icns")]);

  writeFileSync(join(icons, "32x32.png"), appIcon(32));
  writeFileSync(join(icons, "64x64.png"), appIcon(64));
  writeFileSync(join(icons, "128x128.png"), appIcon(128));
  writeFileSync(join(icons, "128x128@2x.png"), appIcon(256));
  writeFileSync(join(icons, "icon.png"), appIcon(1024));
  writeFileSync(join(icons, "tray-icon.png"), trayIcon(128));
  copyFileSync(join(icons, "icon.png"), join(assets, "gyredeck-app-icon.png"));

  console.log("icons regenerated — tray-icon.png is compiled in, so rebuild the desktop app to see it");
} finally {
  rmSync(work, { recursive: true, force: true });
}
