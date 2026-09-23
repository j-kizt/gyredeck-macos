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

// createUpdaterArtifacts signs the bundle at build time, so a local install needs the
// updater signing key. It is loaded from the key file so `pnpm desktop:install` works
// without exporting anything by hand.
//
// One key, and no falling back to the one it replaced. Every installed copy now verifies
// against the new key, so a build signed by the old one would succeed here and produce
// updater artifacts nothing can accept — a silent fallback would hide exactly that, and
// keep a retired key in the signing path. Codex made the case for closing it once the
// rotation finished. The old key file stays on disk until the first release signed by the
// new one has been seen to update cleanly; nothing looks for it.
const signingKeyPath = join(homedir(), ".config", "gyredeck", "gyredeck-updater-v2.key");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!existsSync(signingKeyPath)) {
    console.error(
      `No updater signing key at ${signingKeyPath}.\n` +
        "Copy it from a machine that has it, or set TAURI_SIGNING_PRIVATE_KEY yourself.",
    );
    process.exit(1);
  }
  const found = spawnSync(
    "security",
    ["find-generic-password", "-a", "updater-signing", "-s", "gyredeck-updater-key-password", "-w"],
    { encoding: "utf8" },
  );
  if (found.status !== 0) {
    // `-w` last and empty, so `security` prompts for the passphrase instead of taking it
    // from the command line — where it would land in the process list and the shell's
    // history. `security help` says as much itself, and a recovery step for a signing key
    // that leaks the passphrase on the way is not much of a recovery. Codex caught it here.
    console.error(
      "Found the signing key but not its passphrase in the Keychain. Add it with:\n" +
        "  security add-generic-password -a updater-signing -s gyredeck-updater-key-password -U -w\n" +
        "and type the passphrase at the prompt.",
    );
    process.exit(1);
  }
  process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(signingKeyPath, "utf8").trim();
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= found.stdout.trim();
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
