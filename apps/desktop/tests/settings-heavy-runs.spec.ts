import { expect, test } from "@playwright/test";

/**
 * The Settings row for the machine's one heavy-run slot (#223): it shows who holds the
 * slot, what runs and who waits, and its one action frees a stuck slot through the app's
 * own command — never anything that reorders the line.
 */

const HELD = {
  ok: true,
  v: 1,
  load: 6.2,
  loadLimit: 5,
  holder: { as: "claude-a", what: "pnpm test:demo --workers=3", state: "active", since: "2026-10-25T02:00:00Z", elapsedMs: 754_000, loadSkipped: true, helperGone: true },
  queue: [{ position: 1, as: "codex-b", what: "cargo check", waitedMs: 42_000 }],
  waiting: 1,
  limit: "The queue is advisory. A command runs unqueued when the Gyredeck bridge cannot be reached or speaks another protocol version, even while Gyredeck is running, and a restart of Gyredeck resets the waiting line.",
};

test("the heavy-runs row shows the holder and the line, and releases a stuck slot through the app", async ({ page }) => {
  await page.addInitScript((held) => {
    const calls: string[] = [];
    let released = false;
    (window as typeof window & { __heavyCalls: string[] }).__heavyCalls = calls;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") {
          calls.push(command);
          return released ? { ...held, holder: null, queue: [], waiting: 0 } : held;
        }
        if (command === "heavy_release") {
          calls.push(command);
          released = true;
          return true;
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);

  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("tabpanel", { name: "Connection" })).toBeVisible();

  const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
  await expect(row).toContainText("claude-a · pnpm test:demo --workers=3 · 12 min · started under load");
  await expect(row).toContainText("Helper gone, command still running");
  await expect(row).toContainText("Waiting 1 · codex-b · cargo check · 42s");
  await expect(row).toContainText("The queue is advisory.");
  await expect(row).toContainText("Frees the slot even if its command is still running — two heavy runs may then overlap.");

  await row.getByRole("button", { name: "Release stuck slot" }).click();
  await expect(row.locator(".setup-detail").first()).toHaveText("Free");
  await expect(row.getByRole("button", { name: "Release stuck slot" })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as typeof window & { __heavyCalls: string[] }).__heavyCalls);
  expect(calls.filter((call) => call === "heavy_release")).toHaveLength(1);
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
