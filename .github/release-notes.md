Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, and GitHub/GitLab repo/CI/PR monitoring, in a window from the menu bar.

## Provisioning profile read without a shell — (v1.40.1)

Nothing changes in the app itself. This release changes how a build is put together.

### Fixes

- **The release build, and `pnpm desktop:install` when it signs with a profile, read the
  provisioning profile without starting a shell.** Both decoded it with `security cms -D -i "$1" > "$2"` run through `sh -c`. The paths
  went in as arguments, so nothing could be injected, but GitHub's code scanning kept two
  shell-injection alerts open against those lines. `security cms` now writes the decoded profile
  itself with `-o`. The profile and what is done with it are unchanged, and this release was
  signed through the new line.
