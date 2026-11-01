import { expect, test, type Page } from "@playwright/test";

/**
 * One scrollbar for the whole app, Settings' at the window edge as Usage's is, nothing that
 * scrolls sideways, and Release notes shown as formatted text (#277).
 *
 * Headless Chrome hides scrollbars, so their width cannot be measured here: what is pinned is
 * that every scroll area carries the app's scrollbar style, from one global rule.
 */

const NOTES = [
  "## Two fixes — (v9.9.9)",
  "",
  "### Fixes",
  "",
  "- **The scrollbar** in Settings now matches `Usage`, and a long line",
  "  wraps under its bullet.",
  "- A path with no break: /Users/a_rather_long_account_name_for_this_mac/Library/Application_Support/Gyredeck/some/deep/file.json",
  "",
  "<script>window.__pwned = true</script><img src=x onerror=\"window.__pwned = true\">",
].join("\n");

const open = async (page: Page) => {
  await page.addInitScript((notes) => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "plugin:app|version") return "9.9.8";
        if (command === "plugin:updater|check") {
          return { rid: 1, currentVersion: "9.9.8", version: "9.9.9", date: "2026-11-02T00:00:00Z", body: notes, rawJson: {} };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, NOTES);
  await page.setViewportSize({ width: 444, height: 280 });
  await page.goto("/?demo=1");
};

const scrollAreas = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("*"))
      .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY + getComputedStyle(el).overflowX) && el.getBoundingClientRect().width > 0)
      .map((el) => ({
        name: el.className.toString() || el.tagName,
        width: getComputedStyle(el).scrollbarWidth,
        color: getComputedStyle(el).scrollbarColor,
        sideways: getComputedStyle(el).overflowX !== "hidden" && el.scrollWidth > el.clientWidth + 1,
      })));

const settingsTabs = async (page: Page) => {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  return page.getByRole("tablist").last().getByRole("tab").allTextContents();
};

test("every scroll area on Usage and every Settings page wears the app's scrollbar, and none scrolls sideways", async ({ page }) => {
  await open(page);
  const seen: Awaited<ReturnType<typeof scrollAreas>> = [];
  await page.getByRole("tab", { name: "Usage" }).click();
  seen.push(...(await scrollAreas(page)));
  for (const tab of await settingsTabs(page)) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    seen.push(...(await scrollAreas(page)));
  }
  expect(seen.map((area) => area.name)).toEqual(expect.arrayContaining([expect.stringContaining("usage-layout"), expect.stringContaining("setup-category-panel"), expect.stringContaining("setup-sidebar")]));
  const { color } = seen.find((area) => area.name.includes("usage-layout"))!;
  for (const area of seen) {
    expect(area.width, area.name).toBe("thin");
    expect(area.color, area.name).toBe(color);
  }
  // The narrow layout's sidebar is the one row meant to scroll sideways.
  expect(seen.filter((area) => area.sideways && !area.name.includes("usage-sidebar"))).toEqual([]);
  const webkit = await page.evaluate(() =>
    Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules))
      .some((rule) => rule instanceof CSSStyleRule && rule.selectorText === "::-webkit-scrollbar" && rule.style.width === "8px"));
  expect(webkit, "one global ::-webkit-scrollbar rule, for WebKit").toBe(true);
});

test("Settings scrolls at the window edge as Usage does, with its content inset the same on both sides", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: "Usage" }).click();
  const usageRight = await page.locator(".usage-layout").evaluate((el) => el.getBoundingClientRect().right);
  expect(usageRight).toBe(444);
  await settingsTabs(page);
  const edges = await page.locator(".setup-category-panel").evaluate((panel) => {
    const content = panel.firstElementChild!.getBoundingClientRect();
    const sidebar = document.querySelector(".setup-sidebar")!.getBoundingClientRect();
    return { right: panel.getBoundingClientRect().right, inRight: window.innerWidth - content.right, inLeft: sidebar.left };
  });
  expect(edges.right).toBe(usageRight);
  expect(Math.abs(edges.inRight - edges.inLeft)).toBeLessThanOrEqual(1);
});

test("Release notes render headings, bullets, bold and code as elements, wrap a long path, and keep markup as text", async ({ page }) => {
  await open(page);
  await settingsTabs(page);
  await page.getByRole("tab", { name: "Update", exact: true }).click();
  // The app checks on its own at start, so the update is already there.
  const notes = page.locator(".update-notes-body");
  await expect(notes.locator("h4")).toHaveText("Two fixes — (v9.9.9)");
  await expect(notes.locator("h5")).toHaveText("Fixes");
  await expect(notes.locator("li")).toHaveCount(2);
  await expect(notes.locator("li").first()).toContainText("in Settings now matches Usage, and a long line wraps under its bullet.");
  await expect(notes.locator("li strong")).toHaveText("The scrollbar");
  await expect(notes.locator("li code")).toHaveText("Usage");
  await expect(notes.locator("script, img")).toHaveCount(0);
  await expect(notes.locator("p")).toContainText("<script>window.__pwned = true</script>");
  expect(await page.evaluate(() => (window as typeof window & { __pwned?: boolean }).__pwned)).toBeUndefined();
  expect(await notes.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(notes).not.toContainText("**");
  await expect(notes).not.toContainText("##");
});
