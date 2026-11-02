// How a local build is signed (#288). Kept apart from install-desktop.mjs so the decisions can
// be tested without a keychain. The identity is found in this Mac's keychain and never written
// anywhere: the Team ID inside its name stays off the repo, issues and logs.

const DEVELOPER_ID = /^\s*\d+\)\s+[0-9A-F]{40}\s+"(Developer ID Application: [^"]+)"\s*$/;

/** The one Developer ID Application identity in `security find-identity -v -p codesigning`. */
export const pickIdentity = (findIdentityOutput) => {
  const found = [...new Set(String(findIdentityOutput).split("\n").map((line) => DEVELOPER_ID.exec(line)?.[1]).filter(Boolean))];
  if (found.length > 1) return { error: "More than one Developer ID Application identity is in the keychain; keep one." };
  return found.length === 1 ? { identity: found[0] } : { identity: null };
};

/** Whether `codesign -dv` (its stderr) shows a Developer ID signature, not ad-hoc. */
export const signedWithDeveloperId = (codesignDetails) => {
  const text = String(codesignDetails);
  return /^Authority=Developer ID Application: /m.test(text) && !/^Signature=adhoc$/m.test(text);
};

/**
 * Whether this install may go ahead. A build without the identity is ad-hoc, and an ad-hoc app
 * cannot read what a Developer ID one saved in the Keychain: it never replaces a Developer ID
 * install. Otherwise it goes ahead only when asked for by name.
 */
export const installDecision = ({ identity, installedIsDeveloperId, allowAdhoc }) => {
  if (identity) return { ok: true };
  if (installedIsDeveloperId) {
    return { ok: false, why: "No Developer ID identity in the keychain, and the installed Gyredeck is signed with one: an ad-hoc build would lose its saved Discord token and owner. Import the identity first." };
  }
  if (!allowAdhoc) {
    return { ok: false, why: "No Developer ID identity in the keychain. Import it, or run with GYREDECK_ALLOW_ADHOC=1 to install an ad-hoc build that keeps no Keychain items across updates." };
  }
  return { ok: true, adhoc: true };
};

export const APP_ID = "com.j-kizt.gyredeck";

/**
 * What a provisioning profile (its plist, decoded with `security cms -D`) allows, checked
 * before it is embedded (#288): a Mac Developer ID profile for this app and this team, not
 * expired. The data-protection keychain needs it: without one macOS kills an app that claims a
 * keychain access group.
 */
export const checkProfile = ({ teamIds, appIdentifier, platforms, expires, now = new Date() }, teamId) => {
  if (!Array.isArray(teamIds) || !teamIds.includes(teamId)) return "The provisioning profile is for another team.";
  if (appIdentifier !== `${teamId}.${APP_ID}`) return `The provisioning profile is not for ${APP_ID}.`;
  if (!Array.isArray(platforms) || !platforms.includes("OSX")) return "The provisioning profile is not for the Mac.";
  if (!(expires instanceof Date) || Number.isNaN(expires.getTime()) || expires <= now) return "The provisioning profile has expired.";
  return null;
};

/** The entitlements a signed build carries: its own keychain access group, nothing wider. */
export const entitlementsPlist = (teamId) => {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("Not a Team ID.");
  const group = `${teamId}.${APP_ID}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.application-identifier</key>
  <string>${group}</string>
  <key>com.apple.developer.team-identifier</key>
  <string>${teamId}</string>
  <key>keychain-access-groups</key>
  <array>
    <string>${group}</string>
  </array>
</dict>
</plist>
`;
};

/** Tauri config merged over tauri.conf.json for a signed build: entitlements and the profile. */
export const signedBuildConfig = ({ entitlementsPath, profilePath }) => ({
  bundle: { macOS: { entitlements: entitlementsPath, files: { "embedded.provisionprofile": profilePath } } },
});

/** The Team ID in a Developer ID identity's name, "Developer ID Application: Name (TEAMID)". */
export const teamOf = (identity) => /\(([A-Z0-9]{10})\)$/.exec(String(identity))?.[1] ?? null;

/**
 * The Developer ID certificate the app is signed with, pinned by the SHA-256 of its leaf (#288).
 * The Keychain group follows the team, so a build signed by another certificate — a wrong
 * identity, a stale secret — would build and pass every other check, then lose the saved token.
 * Not a secret, and no Team ID: the certificate itself ships inside every signed app. When the
 * certificate is renewed, put the new one's fingerprint here, with the new profile.
 */
export const DEVELOPER_ID_LEAF_SHA256 = "1b81d7d23b4a2d064cf43d74ad75750e41141808077ce8a0cbf3b74b7c223d0b";

export const leafIsPinned = (sha256) => String(sha256).trim().toLowerCase() === DEVELOPER_ID_LEAF_SHA256;
