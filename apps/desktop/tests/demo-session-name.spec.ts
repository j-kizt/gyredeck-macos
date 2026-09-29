import { expect, test } from "@playwright/test";

/**
 * Naming a session, from the header where the name is read.
 *
 * Kept as a test because the two faults it pins both crossed a boundary that reading the
 * component could not show: one into the surface's own keyboard handling, the other into
 * the gap between a click and an answer that has not come back yet. The first was found
 * by driving the real app and would not have been found otherwise.
 */
const withNames = async (page: import("@playwright/test").Page, options: { delayMs?: number } = {}) => {
  await page.addInitScript(([delayMs]) => {
    const names: Record<string, string> = {};
    const calls: string[] = [];
    (window as typeof window & { __nameCalls: string[] }).__nameCalls = calls;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: Record<string, string>) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "session_names") return names;
        if (command === "set_session_name") {
          calls.push(`${args?.conversationId}=${args?.name}`);
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          const kept = String(args?.name ?? "").trim();
          if (kept) names[String(args?.conversationId)] = kept;
          else delete names[String(args?.conversationId)];
          return kept || null;
        }
        return null;
      },
    };
  }, [options.delayMs ?? 0]);
};

test("escape abandons the name without closing the session", async ({ page }) => {
  await withNames(page);
  await page.goto("/?demo=1");
  await page.locator(".session-row-main").first().click();

  const title = page.locator(".header-title-named");
  await expect(title).toBeVisible();
  await title.click();
  await page.locator(".header-title-input").fill("half typed");
  await page.keyboard.press("Escape");

  // Escape on this surface means "back to the session list". The field has to keep its
  // own Escape, or abandoning a half-typed name takes the whole detail view with it.
  await expect(page.locator(".header-title-input")).toHaveCount(0);
  await expect(title).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { __nameCalls: string[] }).__nameCalls)).toEqual([]);
});

test("cancelling once does not turn the next save into a cancel", async ({ page }) => {
  await withNames(page);
  await page.goto("/?demo=1");
  await page.locator(".session-row-main").first().click();

  const title = page.locator(".header-title-named");
  await title.click();
  await page.locator(".header-title-input").fill("abandoned");
  // The X, which undoes its own edit — and used to leave behind the flag that says "this
  // edit was abandoned", so the *next* save read itself as a cancel and saved nothing.
  await page.locator(".header-title-action").last().click();
  await expect(page.locator(".header-title-input")).toHaveCount(0);

  await title.click();
  await page.locator(".header-title-input").fill("the audit one");
  await page.locator(".header-title-action").first().click();

  await expect(title).toContainText("the audit one");
  // The name it would go by on its own stays in view beside the one it was given — that
  // is what a person matches a row against a terminal window with.
  await expect(page.locator(".header-title-derived")).toHaveText(/^\(.+\)$/);
  expect(await page.evaluate(() => (window as typeof window & { __nameCalls: string[] }).__nameCalls))
    .toEqual([expect.stringContaining("=the audit one")]);
});

test("a save in flight cannot be typed over", async ({ page }) => {
  await withNames(page, { delayMs: 600 });
  await page.goto("/?demo=1");
  await page.locator(".session-row-main").first().click();

  const title = page.locator(".header-title-named");
  await title.click();
  await page.locator(".header-title-input").fill("first");
  await page.locator(".header-title-action").first().click();

  // While the answer is outstanding the title is not a way back into the field: the
  // answer carries the name that was kept, and it would land on top of whatever had been
  // typed in the meantime.
  await expect(title).toBeDisabled();
  await expect(title).toHaveAttribute("data-saving", "");
  await expect(title).toBeEnabled({ timeout: 4_000 });
  await expect(title).toContainText("first");
});
