import assert from "node:assert/strict";
import test from "node:test";
import { checkProfile, entitlementsPlist, installDecision, pickIdentity, signedBuildConfig, signedWithDeveloperId, teamOf } from "../scripts/signing.mjs";

const line = (n, name) => `  ${n}) ${"A".repeat(40)} "${name}"`;
const DEV = "Developer ID Application: Someone (ABCDE12345)";

test("#288 the identity is the one Developer ID Application in the keychain; none, or two, is said", () => {
  assert.deepEqual(pickIdentity([line(1, "Apple Development: x"), line(2, DEV), "     2 valid identities found"].join("\n")), { identity: DEV });
  assert.deepEqual(pickIdentity([line(1, DEV), line(2, DEV)].join("\n")), { identity: DEV }, "the same one listed twice is one");
  assert.deepEqual(pickIdentity(line(1, "Apple Development: x")), { identity: null });
  assert.match(pickIdentity([line(1, DEV), line(2, "Developer ID Application: Other (ZZZZZ99999)")].join("\n")).error, /More than one/);
});

test("#288 a Developer ID signature is told from an ad-hoc one", () => {
  assert.equal(signedWithDeveloperId(`Identifier=com.j-kizt.gyredeck\nAuthority=${DEV}\nAuthority=Developer ID Certification Authority\n`), true);
  assert.equal(signedWithDeveloperId("Identifier=com.j-kizt.gyredeck\nSignature=adhoc\n"), false);
  assert.equal(signedWithDeveloperId(""), false);
});

test("#288 an ad-hoc build never replaces a Developer ID install, and needs asking for by name otherwise", () => {
  assert.deepEqual(installDecision({ identity: DEV, installedIsDeveloperId: true, allowAdhoc: false }), { ok: true });
  assert.equal(installDecision({ identity: null, installedIsDeveloperId: true, allowAdhoc: true }).ok, false, "not even when asked");
  assert.equal(installDecision({ identity: null, installedIsDeveloperId: false, allowAdhoc: false }).ok, false);
  assert.deepEqual(installDecision({ identity: null, installedIsDeveloperId: false, allowAdhoc: true }), { ok: true, adhoc: true });
});

test("#288 a profile is embedded only for this app, this team, the Mac, and before it expires", () => {
  const good = { teamIds: ["ABCDE12345"], appIdentifier: "ABCDE12345.com.j-kizt.gyredeck", platforms: ["OSX"], expires: new Date("2044-10-28"), now: new Date("2026-11-02") };
  assert.equal(checkProfile(good, "ABCDE12345"), null);
  assert.match(checkProfile(good, "ZZZZZ99999"), /another team/);
  assert.match(checkProfile({ ...good, appIdentifier: "ABCDE12345.com.j-kizt.other" }, "ABCDE12345"), /not for com\.j-kizt\.gyredeck/);
  assert.match(checkProfile({ ...good, platforms: ["iOS"] }, "ABCDE12345"), /not for the Mac/);
  assert.match(checkProfile({ ...good, now: new Date("2045-01-01") }, "ABCDE12345"), /expired/);
});

test("#288 a signed build claims its own keychain group only, and the team comes from the identity", () => {
  const plist = entitlementsPlist("ABCDE12345");
  assert.match(plist, /<string>ABCDE12345\.com\.j-kizt\.gyredeck<\/string>\s*<\/array>/);
  assert.doesNotMatch(plist, /\*/, "no wildcard group, though the profile would allow one");
  assert.throws(() => entitlementsPlist("abc"));
  assert.equal(teamOf(DEV), "ABCDE12345");
  assert.deepEqual(signedBuildConfig({ entitlementsPath: "/e.plist", profilePath: "/p.provisionprofile" }), {
    bundle: { macOS: { entitlements: "/e.plist", files: { "embedded.provisionprofile": "/p.provisionprofile" } } },
  });
});

test("#288 the signature is read from codesign itself: -dvv shows the authority, -dv does not", { skip: process.platform !== "darwin" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const script = readFileSync(new URL("../scripts/install-desktop.mjs", import.meta.url), "utf8");
  assert.match(script, /spawnSync\("codesign", \["-dvv", app\]/, "the install script asks for the authority");
  const plain = spawnSync("codesign", ["-dv", "/System/Applications/Calculator.app"], { encoding: "utf8" }).stderr;
  const verbose = spawnSync("codesign", ["-dvv", "/System/Applications/Calculator.app"], { encoding: "utf8" }).stderr;
  assert.doesNotMatch(plain, /^Authority=/m);
  assert.match(verbose, /^Authority=/m);
});

test("#288 the signer is the pinned Developer ID certificate, read from the app itself", { skip: process.platform !== "darwin" }, async () => {
  const { leafIsPinned, DEVELOPER_ID_LEAF_SHA256 } = await import("../scripts/signing.mjs");
  const { leafSha256 } = await import("../scripts/check-signer.mjs");
  assert.match(DEVELOPER_ID_LEAF_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(leafIsPinned(DEVELOPER_ID_LEAF_SHA256.toUpperCase()), true);
  const apple = leafSha256("/System/Applications/Calculator.app");
  assert.match(apple ?? "", /^[0-9a-f]{64}$/, "premise: a signed app's leaf is read");
  assert.equal(leafIsPinned(apple), false, "a valid signature by anyone else is not ours");
  assert.equal(leafSha256("/nonexistent.app"), null);
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../scripts/install-desktop.mjs", import.meta.url), "utf8"), /if \(!leafIsPinned\(leafSha256\(sourceApp\)\)\)/, "the install checks it before touching the installed app");
  assert.match(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"), /node scripts\/check-signer\.mjs "\$app"/, "CI checks it before publishing");
});

test("#313 the release build, which holds the signing secrets, restores the Rust cache and never saves one", async () => {
  const { readFileSync } = await import("node:fs");
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const caches = [...release.matchAll(/uses:\s*actions\/cache(\/\w+)?@/g)].map((m) => m[1] ?? "");
  assert.ok(caches.length > 0, "premise: release.yml restores a cache");
  assert.deepEqual(caches.filter((kind) => kind !== "/restore"), [], "no actions/cache step that saves");
  // setup-node's `cache: pnpm` saves on its own: only the job's cache mode stops every save.
  assert.match(release, /\n  release:\n(?:    .*\n)*?    cache-mode: read\n/, "the release job may restore caches and save none");
});
