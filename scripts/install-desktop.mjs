#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { checkProfile, entitlementsPlist, installDecision, leafIsPinned, pickIdentity, signedBuildConfig, signedWithDeveloperId, teamOf } from "./signing.mjs";
import { leafSha256 } from "./check-signer.mjs";

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

// Signed with the Developer ID when this Mac has it, so the app keeps what it saved in the
// Keychain across updates (#288). Tauri reads the identity from the environment; the config
// keeps "-" so a contributor without one can still build.
// -dvv: plain -dv prints no Authority lines, so every signature read as not Developer ID.
const codesignDetails = (app) => spawnSync("codesign", ["-dvv", app], { encoding: "utf8" }).stderr ?? "";
const picked = pickIdentity(spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).stdout ?? "");
if (picked.error) {
  console.error(picked.error);
  process.exit(1);
}
const decision = installDecision({
  identity: picked.identity,
  installedIsDeveloperId: existsSync(installPath) && signedWithDeveloperId(codesignDetails(installPath)),
  allowAdhoc: process.env.GYREDECK_ALLOW_ADHOC === "1",
});
if (!decision.ok) {
  console.error(decision.why);
  process.exit(1);
}
const buildArgs = ["desktop:build"];
if (picked.identity) {
  process.env.APPLE_SIGNING_IDENTITY = picked.identity;
  // The Keychain items live in the team's access group, which macOS grants only with the
  // provisioning profile inside the app. Both files carry the Team ID, so they are written
  // here for this build and never committed.
  const teamId = teamOf(picked.identity);
  const profilePath = process.env.GYREDECK_PROVISIONING_PROFILE || join(homedir(), ".config", "gyredeck", "Gyredeck_Developer_ID.provisionprofile");
  if (!existsSync(profilePath)) {
    console.error(`No provisioning profile at ${profilePath}. Download the "Gyredeck Developer ID" profile from developer.apple.com and put it there.`);
    process.exit(1);
  }
  // Field by field: the profile holds certificates and dates, which plutil cannot turn into JSON.
  const signingDir = join(root, "apps/desktop/src-tauri/target/signing");
  mkdirSync(signingDir, { recursive: true });
  const decodedPath = join(signingDir, "profile.plist");
  if (spawnSync("sh", ["-c", 'security cms -D -i "$1" > "$2"', "sh", profilePath, decodedPath]).status !== 0) {
    console.error(`Could not read the provisioning profile at ${profilePath}.`);
    process.exit(1);
  }
  const field = (path) => spawnSync("plutil", ["-extract", path, "raw", "-o", "-", decodedPath], { encoding: "utf8" }).stdout?.trim() ?? "";
  const refused = checkProfile(
    {
      teamIds: [field("TeamIdentifier.0")],
      appIdentifier: field("Entitlements.com\\.apple\\.application-identifier"),
      platforms: [field("Platform.0")],
      expires: new Date(field("ExpirationDate")),
    },
    teamId,
  );
  if (refused) {
    console.error(refused);
    process.exit(1);
  }
  const entitlementsPath = join(signingDir, "entitlements.plist");
  const configPath = join(signingDir, "tauri.signing.json");
  writeFileSync(entitlementsPath, entitlementsPlist(teamId));
  writeFileSync(configPath, JSON.stringify(signedBuildConfig({ entitlementsPath, profilePath })));
  buildArgs.push("--config", configPath);
} else console.warn("Building ad-hoc: this install keeps no Keychain items across updates.");

run("pnpm", buildArgs);

const sourceApp = existsSync(builtApp) ? builtApp : fallbackApp;
if (!existsSync(sourceApp)) {
  console.error(`Gyredeck app bundle not found at ${builtApp}`);
  process.exit(1);
}

// Checked before anything installed is touched: a build that came out unsigned or ad-hoc
// when the identity was there must not replace the app.
if (picked.identity) {
  const verified = spawnSync("codesign", ["--verify", "--strict", "--deep", sourceApp], { stdio: "inherit" });
  if (verified.status !== 0 || !signedWithDeveloperId(codesignDetails(sourceApp))) {
    console.error(`${sourceApp} is not validly signed with the Developer ID; the installed app was left as it was.`);
    process.exit(1);
  }
  // Not just any Developer ID: the pinned certificate, or the Keychain group is not the one the
  // installed app saved into.
  if (!leafIsPinned(leafSha256(sourceApp))) {
    console.error(`${sourceApp} is signed by a different certificate than the pinned Developer ID one; the installed app was left as it was.`);
    process.exit(1);
  }
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
