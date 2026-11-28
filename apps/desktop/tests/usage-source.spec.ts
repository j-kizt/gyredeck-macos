import { expect, test, type Page } from "@playwright/test";

// #398: a reading taken from the agent's own file says where it came from; one from the
// provider, and every Antigravity reading, keeps "Updated".
const mockProvider = async (page: Page, command: string, providerId: string, displayName: string, source: string | null) => {
  await page.addInitScript(({ command, providerId, displayName, source }) => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (name: string) => {
        if (name === "set_keep_awake") return false;
        if (name === command) {
          return {
            providerId,
            displayName,
            plan: "Pro",
            fetchedAt: "2026-11-28T01:00:00Z",
            ...(source === null ? {} : { source }),
            lines: [{ type: "progress", label: "Session", used: 30, limit: 100 }],
          };
        }
        throw new Error(`${name} unavailable`);
      },
    };
  }, { command, providerId, displayName, source });
  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  await page.getByRole("tab", { name: new RegExp(displayName) }).click();
  return page.locator(".usage-freshness");
};

const CASES = [
  { command: "claude_usage", id: "claude", name: "Claude Code", source: "statusline", prefix: /^From status line · / },
  { command: "codex_usage", id: "codex", name: "Codex", source: "log", prefix: /^From session log · / },
  { command: "codex_usage", id: "codex", name: "Codex", source: "api", prefix: /^Updated / },
  { command: "claude_usage", id: "claude", name: "Claude Code", source: null, prefix: /^Updated / },
  { command: "codex_usage", id: "codex", name: "Codex", source: "made-up", prefix: /^Updated / },
  { command: "agy_usage", id: "agy", name: "Antigravity", source: "statusline", prefix: /^Updated / },
] as const;

for (const entry of CASES) {
  test(`${entry.name} with source ${entry.source ?? "absent"} heads its reading ${entry.prefix.source} (#398)`, async ({ page }) => {
    const freshness = await mockProvider(page, entry.command, entry.id, entry.name, entry.source);
    await expect(freshness).toHaveText(entry.prefix);
    await expect(freshness).not.toHaveAttribute("data-stale", "true");
  });
}

test("the reworded Auto refresh row fits the window at 440 px (#398)", async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 800 });
  await mockProvider(page, "codex_usage", "codex", "Codex", "api");
  await page.getByRole("button", { name: "Usage settings" }).click();
  const row = page.locator(".usage-setting-group").filter({ hasText: "Auto refresh" });
  await expect(row.locator(".usage-setting-desc")).toHaveText(
    "How often usage is refreshed. Each refresh asks the provider when it can, and a newer reading from an agent’s own status line or log is shown in its place.",
  );
  const fit = await row.evaluate((el) => {
    const panel = el.closest(".usage-settings-panel")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const desc = el.querySelector(".usage-setting-desc")!;
    return {
      inside: box.left >= panel.left - 0.5 && box.right <= panel.right + 0.5,
      descOverflow: desc.scrollWidth - desc.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(fit).toEqual({ inside: true, descOverflow: 0, pageOverflow: 0 });
});
