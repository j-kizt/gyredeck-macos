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
