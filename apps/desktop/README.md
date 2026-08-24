# Agent Activity Desktop

The Agent Activity desktop app is a Tauri v2 macOS menu-bar window backed by the local bridge at `127.0.0.1:47621`.

Runtime flow:

```text
bridge SSE  ─→  http://127.0.0.1:47621/events  ─→  renderer
```

The renderer derives compact presence and persisted per-conversation Sessions from the protocol package plus bounded local event history. `src/main.tsx` owns the shell and native-window orchestration; owner-local modules under `src/features/` own Sessions, presence ingestion, Setup, Usage, Services, and GitHub; `src-tauri/` (Rust) owns the tray, window, terminal focus, notifications, bridge supervision, local-services scan, and `gh`-backed GitHub data. Ordered CSS ownership lives under `src/styles/`.

Do not start by scraping terminal output or transcript files. Those can be fallback diagnostics later, not the primary source.

Validation:

```bash
pnpm check
pnpm test:demo
pnpm test:performance
pnpm desktop:web:build
```

Use `pnpm desktop:install` for the native release/install gate. See [`../../.claude/context/architecture.md`](../../.claude/context/architecture.md) for the full data flow.
