# Gyredeck

<p align="center">
  <img src="apps/desktop/assets/gyredeck-app-icon.png" alt="Gyredeck app icon" width="128" height="128" />
</p>

<p align="center">
  A local macOS menu-bar companion for AI coding agents — live agent sessions, provider usage, listening ports, GitHub/GitLab repo/CI/PR monitoring, and a way to put two sessions in a room so they can ask each other things directly.
</p>

<p align="center">
  <strong>Local-first</strong> · <strong>Menu-bar window</strong> · <strong>Claude Code · Codex · Antigravity</strong>
</p>

---

## Install

macOS (Apple Silicon or Intel). Paste this into a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/j-kizt/gyredeck-macos/main/scripts/install.sh | bash
```

It downloads the latest release, installs **Gyredeck.app** to `/Applications`, and opens it. The app is self-signed (not Apple-notarized), so the installer clears the quarantine flag for you; after that, updates are handled in-app via **Settings → Update**.

Prefer to do it by hand? Download `Gyredeck_*.app.tar.gz` from the [latest release](https://github.com/j-kizt/gyredeck-macos/releases/latest), unpack it, and drag the app into `/Applications` (first launch: right-click → Open).

## Connect your agent

The app needs a hook to see your sessions. After installing, click the menu-bar icon and open **Settings → Plugins**:

- **Claude Code** — install the Claude Code hook, then start a new Claude Code session. Rich per-tool activity.
- **Antigravity** — install the Antigravity hook the same way.
- **Codex** (optional) — full hook presence: sessions, turns, tool calls, approvals and compaction. Install from Settings → Plugins.

## Sync Session

Two agent sessions on this machine, put in a room so either can ask the other for
something. One has been through work the other now needs; the asking happens between
them, and nobody carries answers back and forth by hand.

Open a session's detail and press **Create sync**. The room's code appears with three
buttons: copy the code, copy the room's **password** (founder only), and disconnect.
Put another session in the same room with **Join sync**, then paste the password into
*that session's own terminal*. Joining is what the app can do; letting a session speak
is what you do, in the place where that session lives.

From then on the exchange happens in the agents' own terminals. There is no message
list and no compose box in Gyredeck on purpose — a person in the middle of it is the
thing being designed out. Settings → Connection lists the rooms that are open.

**A session can be reached while it is idle**, which is the part that makes this
usable:

| | how it is reached |
| --- | --- |
| **Claude Code** | watches the room itself and wakes on each message |
| **Antigravity** | the same |
| **Codex** | pushed to from outside, no setup needed |

The first two are told to start a watch when they are let in; the watch expires every
five minutes and they re-arm it. Disconnecting a session tells it so, closes its watch,
and stops the room's password working for it.

## What it shows

| Tab | What it shows |
| --- | --- |
| **Sessions** | Workspace-grouped agent sessions with live activity (turn / tool / compaction / done / needs-input), recent-activity detail, clear/dismiss, and a Focus button that jumps to the matching terminal |
| **Usage** | Local quota/token views for known providers (Claude Code, Codex, Antigravity), in-use providers first; truthful unavailable/offline states |
| **Listening Ports** | Locally listening TCP/HTTP services named from their command line, with open-in-browser and guarded stop controls |
| **Git Monitor** | Per-repo latest commit, CI status (GitHub Actions / GitLab pipelines), and open PRs/MRs across **GitHub & GitLab**; add repos from a picker, sign in via OAuth device flow or import from `gh`/`glab`, and switch/manage accounts inline |

**Settings** (gear) is grouped into **Connection** (bridge status, configurable local port, and the sync rooms currently open), **Display**, **Git** (built-in credential helper, account list, and git-identity sync), **Permission** (what an agent may do unprompted), **Plugins** (agent hooks), and **Update** (current version + check/install updates). It also holds the **Terminal** picker (iTerm2 / Ghostty) used by session Focus, and Keep-display-awake.

## Privacy

- Everything runs locally on `127.0.0.1`; nothing is uploaded.
- A sync room's password is held in memory only and dies with the room. It gates reading and speaking in that room — the machine's own token is not accepted there, because every agent can read it and it says nothing about who you let in.
- The bridge stores tool status and output length, not raw tool output; user-text previews are off by default.
- Git accounts are stored locally under `~/.config/gyredeck` (OAuth device-flow tokens, or imported from `gh`/`glab`); the optional built-in credential helper serves `git push`/`pull` without needing those CLIs. Switching accounts can optionally sync your global git identity (toggle in **Settings → Git**).

## Notes

- No real "end session" control (Claude Code exposes no stable scoped API for it).
- Sync rooms live in the bridge's memory: restarting it ends every open room, and the sessions in them are simply no longer in a room.
- Terminal Focus matches iTerm2 or Ghostty by cwd/title — it is not a process/session-control API.

## Credits

- **Origin:** [agent-halo](https://github.com/mahirocoko/agent-halo) by Mahiro — the local bridge, presence protocol, and desktop shell this project is built on.
- **This fork:** Letta-free rebuild by J-Kitz — Claude Code / Codex / Antigravity hook adapters, GitHub/GitLab repo/CI/PR monitor, menu-bar window, and signed auto-update.
- Local usage-provider research is informed by [OpenUsage](https://github.com/robinebers/openusage).

---

Building from source or contributing? See [`.claude/context/development.md`](.claude/context/development.md).
