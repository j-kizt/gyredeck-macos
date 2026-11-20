import { expect, test } from "@playwright/test";

/**
 * Usage settings is reached by the gear, so the provider tabs are not shown beside it, the
 * page is not labelled as a panel of a tab that does not exist, and the gear is the way back,
 * to the first provider (#376).
 */

test("Usage settings hides the provider tabs, is a region of its own, and the gear returns to the first provider", async ({ page }) => {
  await page.addInitScript(() => {
    const snapshot = (providerId: string, displayName: string) => ({
      providerId, displayName, plan: "Pro", fetchedAt: "2026-10-24T01:00:00Z",
      lines: [{ type: "progress", label: "Session", used: 30, limit: 100 }],
    });
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "agy_usage") return snapshot("agy", "Antigravity");
        if (command === "claude_usage") return snapshot("claude", "Claude Code");
        if (command === "codex_usage") return snapshot("codex", "Codex");
        throw new Error(`${command} unavailable`);
      },
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();

  const providerTabs = page.getByRole("tablist", { name: "Usage providers" }).getByRole("tab");
  // Premise: all three are online, so the first tab is Antigravity, and Codex is not it.
  await expect(providerTabs).toHaveText([/Antigravity/, /Claude Code/, /Codex/]);
  await page.getByRole("tab", { name: /Codex/ }).click();
  await expect(page.getByRole("tab", { name: /Codex/ })).toHaveAttribute("aria-selected", "true");

  const gear = page.getByRole("button", { name: "Usage settings" });
  await gear.click();
  await expect(gear).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tablist", { name: "Usage providers" })).toHaveCount(0);
  await expect(page.locator("[id^='usage-tab-']")).toHaveCount(0);
  const panel = page.locator("#usage-provider-panel");
  await expect(panel).toHaveAttribute("role", "region");
  await expect(panel).not.toHaveAttribute("aria-labelledby", /.*/);
  await expect(page.getByRole("region", { name: "Usage settings" })).toContainText("Auto refresh");
  await expect(page.getByRole("tabpanel")).toHaveCount(1); // the main Usage tab's own panel, not this one
  // Nothing on the page points its label at an element that is not there.
  expect(await page.evaluate(() => Array.from(document.querySelectorAll("[aria-labelledby]"))
    .flatMap((el) => el.getAttribute("aria-labelledby")!.split(/\s+/))
    .filter((id) => !document.getElementById(id)))).toEqual([]);
  // One column: the settings take the whole width the tabs used to share.
  expect(await page.locator(".usage-layout").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(1);
  await expect(gear).toBeFocused();

  await gear.click();
  await expect(gear).toHaveAttribute("aria-pressed", "false");
  await expect(providerTabs).toHaveCount(3);
  await expect(providerTabs.first()).toHaveAttribute("aria-selected", "true");
  await expect(providerTabs.first()).toHaveText(/Antigravity/);
  await expect(panel).toHaveAttribute("role", "tabpanel");
  await expect(panel).toHaveAttribute("aria-labelledby", "usage-tab-agy");
  expect(await page.locator(".usage-layout").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(2);
});
