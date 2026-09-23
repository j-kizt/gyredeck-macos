#!/usr/bin/env node
/**
 * Refuse to build a release signed by a key nobody meant to sign it with.
 *
 * The updater verifies a download against the public key baked into the copy already
 * installed. So which private key CI signs with is not a detail — sign with the wrong one
 * and every installed copy refuses the update, and there is no taking a published release
 * back. Until this existed the only thing standing behind that was the current value of a
 * mutable GitHub secret. Codex raised it while reviewing the key rotation, where the cost of
 * being wrong is at its highest: the bridge release *must* be signed with the outgoing key.
 *
 * The check does what the app does. A throwaway file is signed with whatever the secret is,
 * and that signature is verified against the public key the installed copies hold — Ed25519,
 * the same two steps `minisign-verify` takes inside `tauri-plugin-updater`. An earlier
 * version compared only the eight-byte key id minisign writes in the clear, which Codex
 * pointed out proves nothing: the id is metadata carried *inside* the signature, not a
 * fingerprint of the key that made it, so a different key wearing the same id would have
 * passed while every installed copy rejected the release.
 *
 * Both expected keys are public, so both live in the workflow in full rather than as digests.
 *
 *   node scripts/check-signing-key.mjs --expect-signing-pubkey <b64> --expect-config-pubkey <b64>
 *
 * During a rotation the two are deliberately different: the release is signed by the key
 * going out, and carries the key coming in. That is the whole mechanism, so neither is
 * inferred from the other.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);

const argument = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : process.argv[at + 1] ?? null;
};

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

/**
 * The bytes of a minisign block, which are always on its second line.
 *
 * Not the last line: a signature file has four, and the last one signs the trusted comment
 * rather than the file. Reading from the end passed a global signature to an Ed25519 check
 * that then refused the key that had genuinely made it.
 */
const payloadOf = (base64Block, what) => {
  const lines = Buffer.from(base64Block, "base64").toString("utf8").trim().split("\n");
  if (lines.length < 2) fail(`${what} does not look like minisign output — base64 encoded twice?`);
  return Buffer.from(lines[1], "base64");
};

/** A raw Ed25519 public key, wrapped so `node:crypto` will take it. */
const ed25519KeyFrom = (raw32) =>
  createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw32]),
    format: "der",
    type: "spki",
  });

const expectedSigning = argument("--expect-signing-pubkey");
const expectedConfig = argument("--expect-config-pubkey");
if (!expectedSigning || !expectedConfig) {
  fail("usage: check-signing-key.mjs --expect-signing-pubkey <b64> --expect-config-pubkey <b64>");
}

// ── what the built app will verify its next update with ─────────────────────────────
const conf = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
const pubkey = conf.plugins?.updater?.pubkey;
if (typeof pubkey !== "string" || pubkey.length === 0) fail("tauri.conf.json has no updater pubkey");
// Byte for byte, not by key id: an id says which key a thing claims to be, and the thirty-two
// bytes after it are the key itself.
if (pubkey.trim() !== expectedConfig.trim()) {
  fail("tauri.conf.json does not carry the public key this release expects");
}
payloadOf(pubkey, "the updater pubkey"); // shape, so a double-encoded value cannot slip past

// ── what the secret actually is, asked by signing something disposable ──────────────
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) fail("TAURI_SIGNING_PRIVATE_KEY is not set");

const dir = mkdtempSync(join(tmpdir(), "gyredeck-signing-check-"));
try {
  const canary = join(dir, "canary.txt");
  const message = Buffer.from("gyredeck signing key check\n");
  writeFileSync(canary, message);

  // Signed from the environment rather than a file: the CLI refuses both at once, and the
  // key never has to be written to disk to be asked what it is.
  const signed = spawnSync(
    "pnpm",
    ["--filter", "@gyredeck/desktop", "exec", "tauri", "signer", "sign", canary],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  if (signed.status !== 0) {
    fail(`could not sign with TAURI_SIGNING_PRIVATE_KEY — wrong passphrase?\n${signed.stderr?.trim() ?? ""}`);
  }

  const signature = payloadOf(readFileSync(`${canary}.sig`, "utf8").trim().split("\n")[0], "the signature");
  const expected = payloadOf(expectedSigning, "the expected signing public key");
  const algorithm = signature.subarray(0, 2).toString("utf8");
  const key = ed25519KeyFrom(expected.subarray(10, 42));
  // `Ed` signs the message; `ED` signs its BLAKE2b-512 digest. `minisign-verify` accepts
  // both and so does this, for the same reason: what matters is that the key holds.
  const signedBytes = algorithm === "ED" ? createHash("blake2b512").update(message).digest() : message;
  if (!verify(null, signedBytes, key, signature.subarray(10, 74))) {
    fail("the signing secret is not the key this release expects — installed copies would refuse it");
  }
  console.log("✓ the signing secret verifies against the public key installed copies hold");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
