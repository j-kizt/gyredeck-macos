import assert from "node:assert/strict";
import test from "node:test";
import { installDecision, pickIdentity, signedWithDeveloperId } from "../scripts/signing.mjs";

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
