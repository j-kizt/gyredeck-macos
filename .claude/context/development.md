# Contributing to Gyredeck

macOS · Node 22 · pnpm 10 · Rust + the Tauri toolchain. The `gh` / `glab` CLIs are optional — the Git Monitor tab signs in via OAuth device flow and can also import existing auth from them.

## Build from source

```bash
pnpm install
pnpm desktop:install          # build + install /Applications/Gyredeck.app
```

Connect an agent (or use the in-app **Settings → Plugins → Claude Code hooks → Install**):

```bash
pnpm hooks:install            # install the Claude Code hook into ~/.claude/settings.json
```

Codex notify (optional, coarse turn-level presence) is installed from Settings →
Plugins → **Codex notify**, alongside the other adapters. It copies the script and writes
`notify` into `~/.codex/config.toml` with `toml_edit`, which leaves comments and key order
untouched.

It refuses rather than overwriting if `notify` already points somewhere else: Codex runs
one notify program, so replacing it would silently disconnect whatever was there. Wiring
it by hand still works and is what the installer writes:

```toml
notify = ["node", "/Users/<you>/.config/gyredeck/gyredeck-codex-notify.mjs"]
```

## Development

```bash
pnpm check              # typecheck root + desktop
pnpm desktop:dev        # run the Tauri app in dev mode (menu-bar window; footer reads "local")
pnpm desktop:web        # browser-only demo/dev server (no native features)
pnpm mod:tail           # tail the local NDJSON event log
pnpm test:demo          # browser demo Playwright suite
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The menu-bar window, tray toggle, terminal focus, notifications, and real event streams must be validated in the installed/native app — the browser demo is only for layout and interaction checks.

## Architecture

Data flow: agent hooks → adapter `.mjs` → `POST /ingest` → local bridge (`127.0.0.1:47621`) → SSE `/events` → Tauri menu-bar window. See [`architecture.md`](architecture.md) for the full breakdown, [`event-protocol.md`](event-protocol.md) for the wire format, and [`presence-model.md`](presence-model.md) for the state model. Local state lives under `~/.config/gyredeck/`.

## Project layout

```text
adapters/bridge/     Local standalone event bridge
adapters/claude/     Claude Code hook adapter + installer
adapters/codex/      Codex notify adapter
packages/protocol/   Shared event and presence model
apps/desktop/        Tauri menu-bar window (src = React/TS, src-tauri = Rust)
apps/viewer/         Terminal event viewer
scripts/             Install/build helpers
```

## Releases & auto-update

Releases are published to GitHub Releases and the app updates itself via `tauri-plugin-updater`. Signed update artifacts + `latest.json` are built and uploaded by `.github/workflows/release.yml` when a `v*` tag is pushed (CI signing needs the `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repo secrets). The full release flow and versioning policy live in [`releasing.md`](releasing.md).
