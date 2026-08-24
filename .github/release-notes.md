Gyredeck is a local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, local services, and GitHub repo/CI/PR monitoring, in a window from the menu bar.

## v1.0.0 — Gyredeck

First release under the new name **Gyredeck** (formerly Agent Activity), with a new app icon.

- **New brand + icon.** Renamed throughout; new 5-arc icon in the Dock and menu bar.
- **Universal build.** One download runs on both Apple Silicon and Intel Macs.
- **One-line install:**

  ```sh
  curl -fsSL https://raw.githubusercontent.com/j-kizt/gyredeck-macos/main/scripts/install.sh | bash
  ```

Everything runs locally on `127.0.0.1`; nothing is uploaded. After installing, open **Settings → Plugins** to connect your Claude Code / Antigravity hooks.

> Upgrading from Agent Activity: this is a rebrand with a new bundle id, so install Gyredeck fresh (the one-liner above) — it won't auto-update from the old app.
