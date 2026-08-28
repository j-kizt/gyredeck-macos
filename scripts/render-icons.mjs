#!/usr/bin/env node
// Regenerates every app/tray icon from render-icons.swift.
//
// The .svg files under apps/desktop/assets are the design reference, but nothing
// on a stock macOS box can rasterize them correctly: qlmanage — the only SVG
// thumbnailer present — composites onto opaque white, which silently fills the
// rounded corners and turns the all-white tray mark into a solid block. So the
// geometry lives in the Swift renderer (CoreGraphics, real alpha, pinned sRGB)
// and the SVGs are kept in sync by hand.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "apps/desktop/src-tauri/icons");
const assets = join(root, "apps/desktop/assets");

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
const resize = (src, size, out) => run("sips", ["-z", String(size), String(size), src, "--out", out]);

const work = mkdtempSync(join(tmpdir(), "gyredeck-icons-"));
try {
  const app1024 = join(work, "app-1024.png");
  const tray128 = join(work, "tray-128.png");
  run("swift", [join(root, "scripts/render-icons.swift"), app1024, tray128]);

  const iconset = join(work, "icon.iconset");
  run("mkdir", ["-p", iconset]);
  for (const s of [16, 32, 128, 256, 512]) {
    resize(app1024, s, join(iconset, `icon_${s}x${s}.png`));
    resize(app1024, s * 2, join(iconset, `icon_${s}x${s}@2x.png`));
  }
  run("iconutil", ["-c", "icns", iconset, "-o", join(icons, "icon.icns")]);

  resize(app1024, 32, join(icons, "32x32.png"));
  resize(app1024, 64, join(icons, "64x64.png"));
  resize(app1024, 128, join(icons, "128x128.png"));
  resize(app1024, 256, join(icons, "128x128@2x.png"));
  copyFileSync(app1024, join(icons, "icon.png"));
  copyFileSync(tray128, join(icons, "tray-icon.png"));
  copyFileSync(app1024, join(assets, "gyredeck-app-icon.png"));

  console.log("icons regenerated — tray-icon.png is compiled in, so rebuild the desktop app to see it");
} finally {
  rmSync(work, { recursive: true, force: true });
}
