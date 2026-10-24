import { expect, test, type Page } from "@playwright/test";

// The clock is fixed so "today" is known: 2026-10-24 16:00 in the browser's own zone.
const NOW = new Date(2026, 9, 24, 16, 0, 0);
const at = (days: number, hours: number, minutes: number) =>
  new Date(2026, 9, 24 + days, hours, minutes, 0).toISOString();

const mockCodex = async (page: Page, fetchedAt: string, resetsAt: string, resetMode: "absolute" | "relative") => {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(({ fetchedAt, resetsAt, resetMode }) => {
    window.localStorage.setItem("gyredeck.usage-settings", JSON.stringify({ refreshMs: 3 * 60_000, usageMode: "left", resetMode, timeFormat: "24h" }));
    let calls = 0;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "codex_usage") {
          calls += 1;
          if (calls > 1) throw new Error("Codex usage is rate limited. Try again shortly.");
          return {
            providerId: "codex", displayName: "Codex", plan: "Pro", fetchedAt,
            lines: [{ type: "progress", label: "Weekly", used: 30, limit: 100, resetsAt }],
          };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, { fetchedAt, resetsAt, resetMode });
  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  await page.getByRole("button", { name: "Refresh usage" }).click();
};

test("an outdated reading from another day names its day (#227)", async ({ page }) => {
  await mockCodex(page, at(-2, 15, 48), at(0, 20, 0), "relative");
  const label = page.locator(".usage-freshness[data-stale='true']");
  await expect(label).toContainText("Outdated");
  await expect(label).toContainText(/22 Oct|Oct 22/);
  await expect(label).toContainText("15:48");
});

test("an outdated reading from today shows the time alone (#227)", async ({ page }) => {
  await mockCodex(page, at(0, 15, 48), at(0, 20, 0), "relative");
  const label = page.locator(".usage-freshness[data-stale='true']");
  await expect(label).toContainText("Outdated · 15:48");
  await expect(label).not.toContainText(/Oct/);
});

test("a reset days away names its day in absolute mode (#227)", async ({ page }) => {
  await mockCodex(page, at(0, 15, 48), at(3, 9, 0), "absolute");
  await expect(page.getByText(/Reset at (27 Oct|Oct 27) 09:00/)).toBeVisible();
});
