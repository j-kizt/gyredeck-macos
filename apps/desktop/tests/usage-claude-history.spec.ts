import { expect, test, type Page } from "@playwright/test";

/**
 * Claude Code's card shows the same local history Codex's does (#276), and with no history
 * from the app it shows its limits alone — never a history of zeros.
 */

const HISTORY = [
  { type: "text", label: "Today", value: "$3.00 · 1.2M tokens" },
  { type: "text", label: "Yesterday", value: "$1.00 · 400K tokens" },
  { type: "text", label: "Latest Token Log", value: "Nov 2" },
  { type: "text", label: "Last 30 Days", value: "$40.00 · 12M tokens" },
  { type: "text", label: "Daily Nov 2", value: "$3.00 · 1.2M tokens" },
  { type: "text", label: "Daily Nov 1", value: "$1.00 · 400K tokens" },
  {
    type: "barChart",
    label: "Usage Trend",
    points: [{ label: "Nov 1", value: 400000 }, { label: "Nov 2", value: 1200000 }],
    note: "Estimated from local Claude Code logs for this home, cache reads and writes included.",
    color: "#D97757",
  },
  { type: "text", label: "claude-opus-5-5", value: "75%" },
  { type: "text", label: "claude-sonnet-5-5", value: "25%" },
  { type: "text", label: "Extra usage", value: "$4.00 / $50.00" },
];

const open = async (page: Page, withHistory: boolean) => {
  await page.addInitScript((lines) => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "claude_usage") {
          return {
            providerId: "claude",
            displayName: "Claude Code",
            plan: "Max",
            lines: [{ type: "progress", label: "Session", used: 30, limit: 100, format: { kind: "percent" } }, ...lines],
            fetchedAt: new Date().toISOString(),
          };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, withHistory ? HISTORY : []);
  await page.goto("/");
  await page.getByRole("tab", { name: "Usage" }).click();
  const claude = page.getByRole("button", { name: /Claude Code/ }).first();
  if (await claude.count()) await claude.click();
};

test("Claude Code's card shows its local history, model mix and daily detail, with the local-logs note", async ({ page }) => {
  await open(page, true);
  const history = page.getByRole("region", { name: "Claude Code usage history" });
  await expect(history).toBeVisible();
  await expect(history).toContainText("Local history");
  await expect(history).toContainText("1.2M tokens");
  await expect(history).toContainText("Estimated from local Claude Code logs for this home, cache reads and writes included.");
  await expect(history.locator(".usage-model-share")).toHaveCount(2);
  await expect(history.locator(".usage-model-share").first()).toContainText("claude-opus-5-5");
  await expect(history).not.toContainText("Extra usage");
  await expect(history.locator(".usage-daily-token")).toHaveCount(2);
});

test("with no history from the app, Claude Code's card shows its limits alone", async ({ page }) => {
  await open(page, false);
  await expect(page.getByText("Session").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Claude Code usage history" })).toHaveCount(0);
});
