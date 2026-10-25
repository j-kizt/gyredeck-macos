import { expect, test } from "@playwright/test";

/**
 * Heavy-run notifications (#244), through the hook that posts them: the native watcher's
 * `heavy_state` event arrives every five seconds, the hook compares it with its last look,
 * and posts only what changed — never while the window is on screen, never a backlog after
 * the toggle comes back on.
 */

type Delivered = { identifier: string; title: string; body: string };
type Win = typeof window & { __heavyEmit: (payload: unknown) => void; __delivered: Delivered[]; __visible: boolean; __listening: () => boolean };

const look = (overrides: Record<string, unknown> = {}) => ({ ok: true, v: 1, load: 1, loadLimit: 5, holder: null, queue: [], observed: [], waiting: 0, limit: "", ...overrides });
const RUN = { id: "a1a1a1a1a1a1a1a1", as: "s-gyre", label: "Claude Code / Gyre Assistant", what: "test:hooks", state: "active", since: "2026-10-26T01:00:00Z", elapsedMs: 252_000, loadSkipped: false, helperGone: false };
const OBSERVED = { pid: 4242, pattern: "cargo test|build|check", exe: "cargo", cwd: null, label: "Terminal", startedAtMs: 1_790_000_000_000, elapsedMs: 65_000 };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as Win;
    const callbacks = new Map<number, (event: unknown) => void>();
    let next = 1;
    let listener: number | null = null;
    w.__delivered = [];
    w.__visible = false;
    w.__listening = () => listener !== null;
    w.__heavyEmit = (payload) => { if (listener !== null) callbacks.get(listener)?.({ event: "heavy_state", id: 1, payload }); };
    (w as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    (w as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      transformCallback: (callback: (event: unknown) => void) => { const id = next++; callbacks.set(id, callback); return id; },
      invoke: async (command: string, args?: { event?: string; handler?: number } & Delivered) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "notification_permission_state") return "authorized";
        if (command === "plugin:event|listen") { if (args?.event === "heavy_state") listener = args.handler ?? null; return 1; }
        if (command === "plugin:event|unlisten") return null;
        if (command === "plugin:window|is_visible") return w.__visible;
        if (command === "deliver_notification") { w.__delivered.push({ identifier: args!.identifier, title: args!.title, body: args!.body }); return null; }
        throw new Error(`${command} unavailable`);
      },
    };
  });
  await page.goto("/?demo=1");
  await expect.poll(() => page.evaluate(() => (window as Win).__listening())).toBe(true);
});

const emit = (page: import("@playwright/test").Page, payload: unknown) => page.evaluate((p) => (window as Win).__heavyEmit(p), payload);
const delivered = (page: import("@playwright/test").Page) => page.evaluate(() => (window as Win).__delivered);

test("a run that starts and ends is posted once each, named as Settings names it; the first look is not news", async ({ page }) => {
  await emit(page, look({ holder: RUN }));
  await emit(page, look({ holder: { ...RUN, elapsedMs: 257_000 } }));
  // Premise: the hook is reading — the next change is posted.
  await emit(page, look({ observed: [OBSERVED] }));
  await expect.poll(() => delivered(page)).toEqual([
    { identifier: "gyredeck.heavy.started.observed.4242.1790000000000", title: "Terminal started a heavy run", body: "cargo test|build|check" },
    { identifier: "gyredeck.heavy.ended.helper.a1a1a1a1a1a1a1a1", title: "test:hooks finished (4m 17s)", body: "Claude Code / Gyre Assistant" },
  ]);
});

test("nothing is posted while the window is on screen", async ({ page }) => {
  await emit(page, look());
  await page.evaluate(() => { (window as Win).__visible = true; });
  await emit(page, look({ holder: RUN }));
  await page.evaluate(() => { (window as Win).__visible = false; });
  await emit(page, look());
  // Premise: the hidden window does get the end, so the start was dropped for being visible.
  await expect.poll(async () => (await delivered(page)).map((d) => d.title)).toEqual(["test:hooks finished (4m 12s)"]);
});

test("C4: switching Heavy runs off and on again releases no backlog", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Notification" }).click();
  const toggle = page.getByRole("switch", { name: "Notify about heavy runs" });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await emit(page, look());
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await emit(page, look({ holder: RUN }));
  await emit(page, look({ queue: [{ id: "c3c3c3c3c3c3c3c3", position: 1, as: "s-audit", label: "Codex", what: "cargo check", waitedMs: 1_000 }], load: 7 }));
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  // The same state again, then one real change: only that change is posted.
  await emit(page, look({ queue: [{ id: "c3c3c3c3c3c3c3c3", position: 1, as: "s-audit", label: "Codex", what: "cargo check", waitedMs: 6_000 }], load: 7 }));
  await emit(page, look({ observed: [OBSERVED], queue: [{ id: "c3c3c3c3c3c3c3c3", position: 1, as: "s-audit", label: "Codex", what: "cargo check", waitedMs: 11_000 }] }));
  await expect.poll(async () => (await delivered(page)).map((d) => d.title)).toEqual(["Terminal started a heavy run"]);
});
