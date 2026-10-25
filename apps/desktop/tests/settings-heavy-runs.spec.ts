import { expect, test } from "@playwright/test";

/**
 * The Settings row for the machine's one heavy-run slot (#223): it shows who holds the
 * slot, what runs and who waits, and its one action stops the run holding the slot (#243) —
 * never anything that reorders the line.
 */

const HELD = {
  ok: true,
  v: 1,
  load: 6.2,
  loadLimit: 5,
  holder: { id: "a1a1a1a1a1a1a1a1", as: "claude-a", label: "Claude Code / Gyre Assistant", what: "pnpm test:demo --workers=3", state: "active", since: "2026-10-25T02:00:00Z", elapsedMs: 754_000, loadSkipped: true, helperGone: true },
  queue: [{ position: 1, as: "codex-b", label: "Codex / Gyredesk Audit", what: "cargo check", waitedMs: 42_000 }],
  waiting: 1,
  limit: "The queue is advisory. A command runs unqueued when the Gyredeck bridge cannot be reached or speaks another protocol version, even while Gyredeck is running, and a restart of Gyredeck resets the waiting line.",
};

test("the heavy-runs row shows the holder and the line, and stops the run it names after asking in the row", async ({ page }) => {
  await page.addInitScript((held) => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    let stopped = false;
    (window as typeof window & { __heavyCalls: typeof calls }).__heavyCalls = calls;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: unknown) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return stopped ? { ...held, holder: null, queue: [], waiting: 0 } : held;
        if (command === "heavy_stop") {
          calls.push({ command, args });
          stopped = true;
          return "stopping";
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);

  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("tabpanel", { name: "Connection" })).toBeVisible();

  const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
  await expect(row).toContainText("Claude Code / Gyre Assistant · pnpm test:demo --workers=3 · 12 min · started under load");
  await expect(row).toContainText("Helper gone, command still running");
  await expect(row).toContainText("Waiting 1 · Codex / Gyredesk Audit · cargo check · 42s");
  await expect(row).toContainText("Only queued runs show here.");

  // Asked in the row, where Stop is pressed: the macOS webview has no window.confirm, so a
  // native dialog here fails this test.
  page.on("dialog", () => { throw new Error("no native dialog may be used"); });
  await row.getByRole("button", { name: "Stop this run" }).click();
  await expect(row.getByRole("alert")).toHaveText("Stop pnpm test:demo --workers=3 of Claude Code / Gyre Assistant? Its command will be ended.");
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row.getByRole("alert")).toHaveCount(0);
  await row.getByRole("button", { name: "Stop this run" }).click();
  await row.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(row.locator(".setup-detail").first()).toHaveText("Free");
  await expect(row.getByRole("button", { name: "Stop this run" })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as typeof window & { __heavyCalls: Array<{ command: string; args?: { holderId?: string } }> }).__heavyCalls);
  expect(calls).toEqual([{ command: "heavy_stop", args: { holderId: "a1a1a1a1a1a1a1a1" } }]);
});

test("a run that took the slot while Stop was being confirmed is not the one stopped (#243)", async ({ page }) => {
  await page.addInitScript((held) => {
    const calls: string[] = [];
    let holder = held.holder;
    (window as typeof window & { __heavyCalls: string[]; __swap: () => void }).__heavyCalls = calls;
    (window as typeof window & { __swap: () => void }).__swap = () => {
      holder = { ...held.holder, id: "b2b2b2b2b2b2b2b2", as: "codex-b", label: "Codex / Gyredesk Audit", what: "cargo check" };
    };
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return { ...held, holder };
        if (command === "heavy_stop") { calls.push(command); return "stopping"; }
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);
  await page.clock.install();
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
  await row.getByRole("button", { name: "Stop this run" }).click();
  await expect(row.getByRole("alert")).toContainText("Claude Code / Gyre Assistant");
  // A finishes and B takes the slot; the next poll shows B.
  await page.evaluate(() => (window as typeof window & { __swap: () => void }).__swap());
  await page.clock.runFor(6_000);
  await expect(row).toContainText("Codex / Gyredesk Audit · cargo check");
  await expect(row.getByRole("alert")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as typeof window & { __heavyCalls: string[] }).__heavyCalls);
  expect(calls).toEqual([]);
});

test("the heavy-runs row says the slot is free when nothing holds it", async ({ page }) => {
  await page.addInitScript((held) => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return { ...held, holder: null, queue: [], waiting: 0 };
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);

  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
  await expect(row.locator(".setup-detail").first()).toHaveText("Free");
  await expect(row.getByRole("button", { name: "Release stuck slot" })).toHaveCount(0);
});

test.describe("at the app's own window width", () => {
  test.use({ viewport: { width: 444, height: 560 } });

  test("a held slot's row stays inside its card and below its heading (#243)", async ({ page }) => {
    await page.addInitScript((held) => {
      (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (command: string) => {
          if (command === "set_keep_awake") return false;
          if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
          if (command === "heavy_status") return held;
          throw new Error(`${command} unavailable`);
        },
      };
    }, HELD);
    await page.goto("/?demo=1");
    await page.getByRole("button", { name: "Settings" }).click();
    const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
    await expect(row).toContainText("Claude Code / Gyre Assistant");
    await row.scrollIntoViewIfNeeded();
    const rowBox = await row.boundingBox();
    const copyBox = await row.locator(".setup-copy").boundingBox();
    const headBox = await page.locator(".setup-subheading", { hasText: "Heavy runs" }).boundingBox();
    if (!rowBox || !copyBox || !headBox) throw new Error("row, copy or heading not laid out");
    expect(copyBox.y).toBeGreaterThanOrEqual(rowBox.y);
    expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5);
    expect(rowBox.y).toBeGreaterThanOrEqual(headBox.y + headBox.height);
  });
});
