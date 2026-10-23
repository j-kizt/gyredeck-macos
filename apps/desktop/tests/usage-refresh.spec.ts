import { expect, test, type Page } from "@playwright/test";

// #192: one set of refresh intervals for every provider, 3 min at the fastest and by default.
const mockUsage = async (page: Page, saved: unknown) => {
  await page.addInitScript((stored) => {
    if (stored !== null) window.localStorage.setItem("gyredeck.usage-settings", JSON.stringify(stored));
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "codex_usage") {
          return {
            providerId: "codex",
            displayName: "Codex",
            plan: "Pro",
            fetchedAt: "2026-10-24T01:00:00Z",
            lines: [{ type: "progress", label: "Session", used: 30, limit: 100 }],
          };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, saved);
  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  await page.getByRole("button", { name: "Usage settings" }).click();
  return page.locator(".usage-settings-panel [role='radiogroup']").first().getByRole("radio");
};

test("Usage refreshes every 3 min by default, offering 3 min, 10 min, 30 min and 1 hour (#192)", async ({ page }) => {
  const options = await mockUsage(page, null);
  await expect(options).toHaveText(["3 min", "10 min", "30 min", "1 hour"]);
  await expect(options.filter({ hasText: "3 min" })).toHaveAttribute("aria-checked", "true");
});

test("a saved refresh interval that is no longer offered falls back to 3 min (#192)", async ({ page }) => {
  // 15 min was the old default, so it is what most saved settings hold.
  const options = await mockUsage(page, { refreshMs: 15 * 60_000, usageMode: "left", resetMode: "relative", timeFormat: "auto" });
  await expect(options.filter({ hasText: "3 min" })).toHaveAttribute("aria-checked", "true");
  await expect(options.filter({ hasText: /^30 min$/ })).toHaveAttribute("aria-checked", "false");
});

test("a saved refresh interval that is still offered is kept (#192)", async ({ page }) => {
  const options = await mockUsage(page, { refreshMs: 30 * 60_000, usageMode: "left", resetMode: "relative", timeFormat: "auto" });
  await expect(options.filter({ hasText: /^30 min$/ })).toHaveAttribute("aria-checked", "true");
});
