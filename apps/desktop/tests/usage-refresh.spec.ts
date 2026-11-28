import { expect, test, type Page } from "@playwright/test";

// #192, #398: one set of refresh intervals for every provider, 5 min at the fastest and by
// default, the same list the app and the bridge accept.
const mockUsage = async (page: Page, saved: unknown) => {
  await page.addInitScript((stored) => {
    if (stored !== null) window.localStorage.setItem("gyredeck.usage-settings", JSON.stringify(stored));
    const sent: unknown[] = [];
    (window as typeof window & { __usageSettingsSent: unknown[] }).__usageSettingsSent = sent;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: unknown) => {
        if (command === "set_keep_awake") return false;
        if (command === "usage_settings_set") {
          sent.push(args);
          return null;
        }
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

const sentSettings = (page: Page) =>
  page.evaluate(() => (window as typeof window & { __usageSettingsSent: unknown[] }).__usageSettingsSent);

test("Usage refreshes every 5 min by default, offering 5 min, 15 min, 30 min and 1 hour (#398)", async ({ page }) => {
  const options = await mockUsage(page, null);
  await expect(options).toHaveText(["5 min", "15 min", "30 min", "1 hour"]);
  await expect(options.filter({ hasText: /^5 min$/ })).toHaveAttribute("aria-checked", "true");
});

for (const minutes of [3, 10]) {
  test(`a saved ${minutes} min, no longer offered, falls back to 5 min (#398)`, async ({ page }) => {
    const options = await mockUsage(page, { refreshMs: minutes * 60_000, usageMode: "left", resetMode: "relative", timeFormat: "auto" });
    await expect(options.filter({ hasText: /^5 min$/ })).toHaveAttribute("aria-checked", "true");
    await expect(options.filter({ hasText: /^30 min$/ })).toHaveAttribute("aria-checked", "false");
  });
}

test("a saved refresh interval that is still offered is kept (#192)", async ({ page }) => {
  const options = await mockUsage(page, { refreshMs: 30 * 60_000, usageMode: "left", resetMode: "relative", timeFormat: "auto" });
  await expect(options.filter({ hasText: /^30 min$/ })).toHaveAttribute("aria-checked", "true");
});

test("the interval and mode reach the app before the first refresh and on every change (#398)", async ({ page }) => {
  const options = await mockUsage(page, { refreshMs: 15 * 60_000, usageMode: "used", resetMode: "relative", timeFormat: "auto" });
  await expect.poll(() => sentSettings(page)).toContainEqual({ refreshMs: 15 * 60_000, usageMode: "used" });
  await options.filter({ hasText: /^1 hour$/ }).click();
  await expect.poll(() => sentSettings(page)).toContainEqual({ refreshMs: 60 * 60_000, usageMode: "used" });
});
