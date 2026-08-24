# Services

The **Services** tab is a read-only, local-only view of the TCP ports listening on this machine, with a guarded control for stopping an eligible current-user listener. It is a native desktop observation lane (`apps/desktop/src-tauri/src/local_services.rs`), not a bridge event or agent session field.

```text
macOS TCP LISTEN sockets (lsof)
  -> bounded process/port records (libproc detail)
  -> short local HTTP root probes (title + web-frontend anatomy)
  -> listener cwd + bounded parent ancestry (owner attribution)
  -> Detected web frontends / Other listeners groups
  -> Open in browser (HTTP)
  -> optional exact-identity Stop / Force kill for eligible current-user listeners
```

Discovery runs only while the Services tab is visible and refreshes every 5 seconds. macOS only; other platforms report an explicit unsupported state.

## What it reads

macOS reads structured `lsof` listener output plus bounded `libproc` detail: process name, PID/start identity, parent, executable path, numeric user ID, physical/resident memory, bind address, port, current cwd, whether a bounded root `GET` returned an HTTP response, a safe document title, and whether strong web-frontend evidence was confirmed. Each discovery pass has a 1.5-second total budget, an 8 KiB per-response cap, and a 256 KiB listener-output cap. The inventory is capped at 64 listeners.

## Web-frontend detection

Classification is fail-closed and does not guess from ports or process names. The same probes apply to every listener (Node, Bun, Python, and unknown runtimes). A listener counts as a web frontend only on a framework-specific Vite/Next development response, or a successful root HTML document with browser-app anatomy (a module script plus stylesheet, a known Next/Nuxt marker, a root mount plus external script, or a bundled `/assets/` stylesheet plus JavaScript `modulepreload`). A Python directory listing, generic HTML/error page, arbitrary JavaScript endpoint, API, or AirTunes response stays an ordinary HTTP service.

Strongly evidenced web frontends appear first under **Detected web frontends** with a green dot; everything else appears under **Other listeners**. Group labels and `HTTP`/`TCP` text keep color from being the only signal. A successful HTML root may expose a whitespace-normalized, control-free title (capped at 120 characters) used as the primary row label, unless it is a generic `Directory listing`/`Index of` title; the process name stays visible beside the endpoint.

Expanding one listener row shows its full bounded process detail in normal document flow. When the listener's bounded live parent ancestry contains a trusted owner PID whose native process start matches within two seconds, an owner (`Started by …`) detail is shown; PID reuse, stale/missing ancestry, a process re-parented to `launchd`, or malformed labels produce no owner claim rather than a guess.

Every HTTP listener exposes an inset **Open in browser** action through a safe `http(s)` URL command, whether or not it is recognized as a web frontend.

### Explicit web-frontend registry

A project that Gyredeck does not recognize automatically may register a current local listener through `~/.config/gyredeck/local-web-frontends.v1.json`:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "processId": 87203,
      "processStartedAtMs": 1785475200000,
      "bindAddress": "127.0.0.1",
      "port": 4173,
      "expiresAtMs": 1785475800000
    }
  ]
}
```

The registry is positive-only and never downgrades strong automatic evidence. An entry matches only the exact live PID, process start within 2 seconds, normalized bind address, and port. Expiry must be in the future but at most 15 minutes ahead. Gyredeck never creates, rewrites, or deletes this file.

The reader fails closed: the file must be a current-user regular file opened without following symlinks, use private permissions (`0600` recommended), stay under 32 KiB, declare schema version 1, and contain at most 32 validated non-duplicate entries. An unsafe/malformed registry is ignored as classification evidence and surfaced as a Services diagnostic while normal discovery continues. Producers must write a same-directory `0600` temporary file and atomically rename it into place.

## Stop / Force kill

**Stop process** is offered only when the listener has a nonzero process-start identity, all real/effective/saved UIDs match the current non-root user, and the process is not PID 1, Gyredeck or its ancestors, or the protected Gyredeck bridge on port 47621. Confirmation states that stopping one process ends every listener it owns.

- Stop sends `SIGTERM` to the positive PID only after a fresh exact PID/start/address/port/UID revalidation.
- If the process remains and the same listener is still open after a bounded grace period, native state records a short-lived one-shot Force eligibility; only then may the UI offer a confirmed **Force kill**, which repeats full revalidation before `SIGKILL`.
- A process that survives closing only the selected endpoint returns a distinct `listenerStopped` outcome, removes only that listener row, and never unlocks Force kill.
- Missing capability/progression state, stale PID, changed identity, endpoint disappearance before signaling, `lsof` failure/timeout, UID mismatch, or a protected identity fails closed. macOS exposes no atomic PID handle, so a narrow check-to-signal race remains; the implementation minimizes it with an immediate second `libproc` identity read and never signals process groups.

## Privacy and retention

- Everything stays inside the local Tauri app; nothing is written to the bridge snapshot, NDJSON log, or persistent storage.
- The inventory is held in renderer/native memory only.
- Command arguments, terminal output, environment variables, and response bodies are never exposed or accepted by the control command.
- Control results contain only status, signal name, process ID, endpoint, and whether the listener remains.
- No remote telemetry or hosted service is involved.

## Verification

```bash
pnpm check
pnpm test:demo
(cd apps/desktop/src-tauri && cargo test && cargo check)
```
