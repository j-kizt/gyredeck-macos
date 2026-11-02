#!/usr/bin/env node
// Is this app signed by the pinned Developer ID certificate? Exits 1 when not (#288). Used by
// the install script and by CI before anything is installed or published.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leafIsPinned } from "./signing.mjs";

export const leafSha256 = (app) => {
  const dir = mkdtempSync(join(tmpdir(), "gyredeck-signer-"));
  try {
    const out = spawnSync("codesign", ["-d", `--extract-certificates=${join(dir, "cert")}`, app], { encoding: "utf8" });
    if (out.status !== 0) return null;
    return createHash("sha256").update(readFileSync(join(dir, "cert0"))).digest("hex");
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = process.argv[2];
  const sha = app ? leafSha256(app) : null;
  if (!sha || !leafIsPinned(sha)) {
    console.error(`${app ?? "(no app given)"} is not signed by the pinned Developer ID certificate.`);
    process.exit(1);
  }
  console.log("signed by the pinned Developer ID certificate");
}
