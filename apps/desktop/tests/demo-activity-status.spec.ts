import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("needs-input activity stays visible until the flow continues", async ({ page }) => {
  await page.goto("/?demo=1&demoScenario=attention");

  await expect(page.locator(".overlay-root")).toHaveAttribute("data-status", "attention");
  const row = page.locator('.session-row[data-status="attention"]');
  await expect(row).toBeVisible();
  await expect(row.locator(".session-inline-status")).toHaveText("Needs input");
});

test("done activity collapses after its ambient signal window while the row remains", async ({ page }) => {
  await page.goto("/?demo=1&demoScenario=done");

  await expect(page.locator(".overlay-root")).toHaveAttribute("data-status", "closed");
  const row = page.locator('.session-row[data-status="done"]');
  await expect(row).toBeVisible();
  await expect(row.locator(".session-inline-status")).toHaveText("Done");

  await expect(page.locator(".overlay-root")).toHaveAttribute("data-live", "false", { timeout: 10_000 });
  await expect(page.locator('.session-row[data-status="done"]')).toBeVisible();
});

test("old unfinished activity becomes inactive without an ambient live signal", async ({ page }) => {
  await page.goto("/?demo=1&demoScenario=inactive");

  await expect(page.locator(".overlay-root")).toHaveAttribute("data-live", "false");
  await expect(page.locator('.session-row[data-status="inactive"]')).toBeVisible();
});
