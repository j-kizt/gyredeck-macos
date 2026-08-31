import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("session context receives focus and Escape restores the originating row", async ({ page }) => {
  await page.goto("/?demo=1&demoScenario=multi");

  const sessionRow = page.getByRole("button", { name: "Open gyredeck-macos session details" }).first();
  await sessionRow.focus();
  await page.keyboard.press("Enter");

  const context = page.locator(".session-context-summary");
  await expect(context).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open gyredeck-macos session details" }).first()).toBeFocused();
});

test("main section tabs provide roving keyboard navigation and panel relationships", async ({ page }) => {
  await page.goto("/?demo=1&demoScenario=multi");

  const sessionsTab = page.getByRole("tab", { name: "Sessions" });
  await sessionsTab.focus();
  await expect(sessionsTab).toBeFocused();
  await page.keyboard.press("ArrowRight");

  const usageTab = page.getByRole("tab", { name: "Usage" });
  await expect(usageTab).toBeFocused();
  await expect(usageTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Usage" })).toBeVisible();

  await page.keyboard.press("ArrowRight");

  const servicesTab = page.getByRole("tab", { name: "Listening Ports" });
  await expect(servicesTab).toBeFocused();
  await expect(servicesTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Listening Ports" })).toBeVisible();

  await page.keyboard.press("ArrowRight");

  const githubTab = page.getByRole("tab", { name: "Git Monitor" });
  await expect(githubTab).toBeFocused();
  await expect(githubTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Git Monitor" })).toBeVisible();

  await page.keyboard.press("Home");
  await expect(sessionsTab).toBeFocused();
  await expect(sessionsTab).toHaveAttribute("aria-selected", "true");
});

test("reduced motion disables panel, status, and loading animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?demo=1&demoScenario=multi");

  // The reduced-motion reset collapses transitions/animations to a near-zero
  // 0.001ms (1e-06s) and clamps looping animations to a single iteration.
  await expect(page.locator(".halo-surface")).toHaveCSS("transition-duration", "1e-06s");
  await expect(page.locator(".sheet-inner")).toHaveCSS("transition-duration", "1e-06s");
  await expect(page.locator(".glyph-pulse").first()).toHaveCSS("animation-duration", "1e-06s");
  await expect(page.locator(".glyph-pulse").first()).toHaveCSS("animation-iteration-count", "1");
});

test("Setup sections use vertical roving tabs and labelled panels", async ({ page }) => {
  await page.goto("/?demo=1&demoScenario=idle");
  await page.getByRole("button", { name: "Settings" }).click();
  // Opening Settings moves focus to the panel target; wait for that before taking focus.
  await expect(page.getByRole("button", { name: "Back to sessions" })).toBeFocused();
  const connection = page.getByRole("tab", { name: "Connection" });
  await connection.focus();
  await expect(connection).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const display = page.getByRole("tab", { name: "Display" });
  await expect(display).toBeFocused();
  await expect(display).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Display" })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Update" })).toBeFocused();
});

test("narrow Setup switches to horizontal tab semantics", async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 440 });
  await page.goto("/?demo=1&demoScenario=idle");
  await page.getByRole("button", { name: "Settings" }).click();
  // Opening Settings moves focus to the panel target; wait for that before taking focus.
  await expect(page.getByRole("button", { name: "Back to sessions" })).toBeFocused();
  await expect(page.getByRole("tablist", { name: "Setup sections" })).toHaveAttribute("aria-orientation", "horizontal");
  const connection = page.getByRole("tab", { name: "Connection" });
  await connection.focus();
  await expect(connection).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Display" })).toBeFocused();
});
