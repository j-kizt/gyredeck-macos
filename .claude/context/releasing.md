# Releasing Gyredeck

## Versioning policy (SemVer)

Pre-1.0, we use `0.MINOR.PATCH`:

| Change | Bump | Example |
| --- | --- | --- |
| Something the app could not do before | **minor** (`0.X.0`) | new adapter/plugin, popover→window, new tab |
| Bug fix, perf, docs, internal refactor | **patch** (`0.x.Y`) | crash fix, scope fix, a repair a user plainly notices |

Adopted from **v0.2.0** onward. Earlier tags (`v0.1.1`–`v0.1.9`) predate this rule and used patch bumps for everything (including the v0.1.7 Antigravity feature) — treat them as history, don't refactor.

**A fix is a patch, however visible it is.** Repairing something broken changes what a
user sees — that is what repairing means — so "would they notice?" cannot be the test, and
reading it as one empties the patch row: every release becomes minor. Minor is for
something the app could not do before.

When genuinely unsure, ask what the release *adds*. Nothing added, however much behaviour
moved, is a patch. v1.16.0 was cut as a minor carrying only fixes, on the strength of the
sentence this replaces; that one is history, don't refactor.

## Release flow

`main` is the only long-lived branch and the default branch; releases are cut from it
by tag. (A `dev` branch existed until v1.6.1 but never once diverged from `main` —
every release fast-forwarded one onto the other — so it was removed.) Nothing lands on
`main` directly, releases included: branch, PR, merge, then tag the merged commit. Do
these steps only when the user asks to release.

1. Branch off `main` (e.g. `release/vX.Y.Z`) and bump `"version"` in all three: `apps/desktop/src-tauri/tauri.conf.json`, `package.json`, `apps/desktop/package.json`.
2. Rewrite `.github/release-notes.md` — CI reads it **verbatim** as the GitHub Release body. Keep the style: 1-line preamble + `### Changed` / `### Fixes` sections.
   - Heading: `## <what it is about> — (vX.Y.Z)`, from v1.16.1 on. The version used to come first, which read as a second title directly under the release's own — GitHub already shows the tag above it. Earlier entries keep the old shape; they are history.
3. Commit (conventional-commit message, `Co-Authored-By` trailer), push the branch, and open a PR into `main` with `gh pr create`.
4. Merge the PR, then `git checkout main && git pull`.
5. Tag the merge commit: `git tag -a vX.Y.Z -m "Gyredeck vX.Y.Z" && git push origin vX.Y.Z`. The tag must point at a commit already on `main` — tagging the branch before it merges publishes a build that `main` does not contain.
6. Tag push triggers `.github/workflows/release.yml` (build → sign → publish). Watch: `gh run watch <id> --exit-status`.
7. Verify: `gh release view vX.Y.Z` has `.app.tar.gz` + `.sig` + `latest.json`, and `latest.json` version matches and has a signature (the auto-updater manifest).

## Notes

- CI signs updater artifacts with the `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret.
- Actions caches are scoped per ref and only the default branch's are readable from tags, so `.github/workflows/cache-warm.yml` must keep tracking whatever the default branch is. Repointing it turns a ~4 min release back into ~9 min.
- Local install for testing: `pnpm desktop:install`. It signs with `~/.config/gyredeck/gyredeck-updater-v2.key`, whose passphrase it reads from the Keychain (account `updater-signing`, service `gyredeck-updater-key-password`), and stops with instructions if either is missing. There is deliberately no fallback to an older key: every installed copy verifies against the current one, so a build signed by anything else would succeed locally and produce updater artifacts nothing can accept.
- **`release.yml` refuses to build unless the signing key is the expected one.** It signs a throwaway file with the secret and verifies that signature against the public key installed copies hold — the same Ed25519 check `tauri-plugin-updater` makes. Both expected keys are passed in full, never as key ids: an id says which key something claims to be, and a different key wearing the right one would pass.
- **Rotating the signing key takes two releases, and the order is the whole of it.** One release is signed by the key going out while carrying the public key coming in, so installed copies accept it and come out trusting the new key; only then does the secret change. Skipping that bridge strands every copy that has not taken it, since the updater holds one public key and has no fallback. The rotation of 2026-09-23 used v1.17.0 as the bridge. During such a rotation `--expect-signing-pubkey` and `--expect-config-pubkey` deliberately differ; the rest of the time they are the same key.
- Never commit/push without explicit user approval.
