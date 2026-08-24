Agent Activity is a local macOS menu-bar companion that surfaces live Claude Code / Codex activity, provider usage, local services, and the state of the GitHub repos you track.

### What's new
- **Clearer service names.** The Services tab now names each listener from its command line — e.g. a bare `node` becomes `agent-activity-bridge` or `next-server` — falling back to the project folder, so you can tell what each port is running.
- **Live indicator.** Each listening service shows a green, gently pulsing dot.
- **Add repo picker dismisses easily** — press Esc or click outside, not only by selecting.

### Changed
- Services tab is tidier: removed the empty "Letta services" group and the stale footer, and the "Other listeners" heading no longer duplicates the count in the toolbar.
- Buttons have subtle hover/press animations, and close/delete buttons turn red on hover. All motion respects the system "reduce motion" setting.
