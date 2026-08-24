#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const appName = "Gyredeck.app";
const builtApp = join(root, "apps/desktop/src-tauri/target/release/bundle/macos", appName);
const fallbackApp = join(root, "apps/desktop/src-tauri/target/release", appName);
const installDir = process.env.GYREDECK_INSTALL_DIR || "/Applications";
const installPath = join(installDir, appName);
const userApplicationsPath = join(homedir(), "Applications", appName);

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// createUpdaterArtifacts signs the bundle at build time, so a local install needs
// the updater signing key. Load it from the local key file when present so
// `pnpm desktop:install` works without manually exporting env vars.
const signingKeyPath = join(homedir(), ".config", "gyredeck", "gyredeck-updater.key");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && existsSync(signingKeyPath)) {
  process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(signingKeyPath, "utf8").trim();
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
}

run("pnpm", ["desktop:build"]);

const sourceApp = existsSync(builtApp) ? builtApp : fallbackApp;
if (!existsSync(sourceApp)) {
  console.error(`Gyredeck app bundle not found at ${builtApp}`);
  process.exit(1);
}

// Replacing an app bundle does not reload an already-running process. Stop the
// current menu-bar instance before copying so the installed UI cannot remain on
// stale in-memory code after a successful install.
spawnSync("pkill", ["-x", "gyredeck-desktop"], { stdio: "ignore" });

try {
  mkdirSync(installDir, { recursive: true });
  rmSync(installPath, { recursive: true, force: true });
  cpSync(sourceApp, installPath, { recursive: true });
} catch (error) {
  console.error(`Failed to install ${appName} → ${installPath}`);
  console.error(error instanceof Error ? error.message : error);
  if (!process.env.GYREDECK_INSTALL_DIR && installDir === "/Applications") {
    console.error(
      `If /Applications is not writable from your shell, rerun with GYREDECK_INSTALL_DIR=${join(
        homedir(),
        "Applications",
      )} pnpm desktop:install`,
    );
  }
  process.exit(1);
}
rmSync(sourceApp, { recursive: true, force: true });
if (installPath !== userApplicationsPath) {
  rmSync(userApplicationsPath, { recursive: true, force: true });
}

spawnSync(
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
  ["-f", installPath],
  { stdio: "ignore" },
);
spawnSync("mdimport", [installPath], { stdio: "ignore" });
run("open", ["-g", installPath]);

console.log(`Installed and restarted ${appName} → ${installPath}`);
console.log("Click the menu-bar icon to open it, then Settings → Plugins → Install to connect Claude Code hooks.");
console.log("Restart Claude Code (or start a new session) so it loads the hook.");
