#!/usr/bin/env node
// CI half of #288: from APPLE_TEAM_ID and APPLE_PROVISIONING_PROFILE (base64), write the
// entitlements and the Tauri config a signed release build merges, after checking the profile.
// Both carry the Team ID, so they go under target/ and are never committed or printed.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkProfile, entitlementsPlist, signedBuildConfig } from "./signing.mjs";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const teamId = process.env.APPLE_TEAM_ID ?? "";
const encoded = process.env.APPLE_PROVISIONING_PROFILE ?? "";
if (!teamId || !encoded) {
  console.error("APPLE_TEAM_ID and APPLE_PROVISIONING_PROFILE are both needed for a signed release.");
  process.exit(1);
}
const dir = join(root, "apps/desktop/src-tauri/target/signing");
mkdirSync(dir, { recursive: true });
const profilePath = join(dir, "embedded.provisionprofile");
const decodedPath = join(dir, "profile.plist");
writeFileSync(profilePath, Buffer.from(encoded, "base64"));
if (spawnSync("sh", ["-c", 'security cms -D -i "$1" > "$2"', "sh", profilePath, decodedPath]).status !== 0) {
  console.error("The provisioning profile could not be decoded.");
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
const entitlementsPath = join(dir, "entitlements.plist");
const configPath = join(dir, "tauri.signing.json");
writeFileSync(entitlementsPath, entitlementsPlist(teamId));
writeFileSync(configPath, JSON.stringify(signedBuildConfig({ entitlementsPath, profilePath })));
console.log(configPath);
