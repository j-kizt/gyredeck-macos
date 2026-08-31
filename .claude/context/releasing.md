# Releasing Gyredeck

## Versioning policy (SemVer)

Pre-1.0, we use `0.MINOR.PATCH`:

| Change | Bump | Example |
| --- | --- | --- |
| New feature or user-visible behavior change | **minor** (`0.X.0`) | new adapter/plugin, popover→window, new tab |
| Bug fix, perf, docs, internal refactor | **patch** (`0.x.Y`) | crash fix, scope fix |

Adopted from **v0.2.0** onward. Earlier tags (`v0.1.1`–`v0.1.9`) predate this rule and used patch bumps for everything (including the v0.1.7 Antigravity feature) — treat them as history, don't refactor.

When unsure whether a change is "feature" or "fix": if a user would notice the app behaves differently, it's minor.

## Release flow

`main` is the only long-lived branch and the default branch; releases are cut from it
by tag. (A `dev` branch existed until v1.6.1 but never once diverged from `main` —
every release fast-forwarded one onto the other — so it was removed.) Land work on
`main`, directly or via a short-lived branch and a PR. Do these steps only when the
user asks to release.

1. On `main`, bump `"version"` in all three: `apps/desktop/src-tauri/tauri.conf.json`, `package.json`, `apps/desktop/package.json`.
2. Rewrite `.github/release-notes.md` — CI reads it **verbatim** as the GitHub Release body. Keep the style: 1-line preamble + `### Changed` / `### Fixes` sections.
3. Commit on `main` (conventional-commit message, `Co-Authored-By` trailer), `git push origin main`.
4. `git tag -a vX.Y.Z -m "Gyredeck vX.Y.Z" && git push origin vX.Y.Z`.
5. Tag push triggers `.github/workflows/release.yml` (build → sign → publish). Watch: `gh run watch <id> --exit-status`.
6. Verify: `gh release view vX.Y.Z` has `.app.tar.gz` + `.sig` + `latest.json`, and `latest.json` version matches and has a signature (the auto-updater manifest).

## Notes

- CI signs updater artifacts with the `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret.
- Actions caches are scoped per ref and only the default branch's are readable from tags, so `.github/workflows/cache-warm.yml` must keep tracking whatever the default branch is. Repointing it turns a ~4 min release back into ~9 min.
- Local install for testing: `pnpm desktop:install` (reads the signing key from `~/.config/gyredeck/gyredeck-updater.key`).
- Never commit/push without explicit user approval.
