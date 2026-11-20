import { expect, test, type Page } from "@playwright/test";

/**
 * One scrollbar for the whole app, Settings' at the window edge as Usage's is, nothing that
 * scrolls sideways, and Release notes shown as formatted text (#277).
 *
 * Headless Chrome hides scrollbars by default, which would make every inset look equal whatever
 * the CSS did. The gutter tests below turn the bars back on, so the bar's slot is real and
 * measured, not inferred from the rule that is meant to produce it (#376).
 */

// Real bars for every test here: a hidden one has no width, so a missing gutter would pass.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

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
  // No area sets the standard properties: in Chromium they would override the app's
  // ::-webkit-scrollbar and change the bar's width away from the gutter kept for it.
  for (const area of seen) {
    expect(area.width, area.name).toBe("auto");
    expect(area.color, area.name).toBe(color);
  }
  // The narrow layout's sidebar is the one row meant to scroll sideways.
  expect(seen.filter((area) => area.sideways && !area.name.includes("usage-sidebar"))).toEqual([]);
  // The rule carries a literal width, as WebKit is not known to read var() there, so it is held
  // to the gutter every scroller keeps by value.
  const webkit = await page.evaluate(() => ({
    rules: Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules))
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === "::-webkit-scrollbar")
      .map((rule) => ({ width: rule.style.width, height: rule.style.height })),
    gutter: getComputedStyle(document.documentElement).getPropertyValue("--scrollbar-gutter").trim(),
  }));
  expect(webkit.rules, "one global ::-webkit-scrollbar rule, for WebKit, as wide as the gutter").toEqual([{ width: webkit.gutter, height: webkit.gutter }]);
});

test.describe("every scroller keeps the bar's 8 px slot and its content an equal inset on both sides (#376)", () => {
  /**
   * The scroller's content box against the window: its right inset must equal the page's own
   * inset (the left padding of .sheet-inner, which every left edge lines up with), whether or not
   * it overflows. `slot` is the width the bar takes, measured, which must be the shared gutter.
   */
  const measure = (page: Page, selector: string) =>
    page.locator(selector).first().evaluate((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(document.querySelector(".sheet-inner")!).paddingLeft);
      const contentLeft = box.left + el.clientLeft + parseFloat(style.paddingLeft);
      const contentRight = box.left + el.clientLeft + el.clientWidth - parseFloat(style.paddingRight);
      return {
        overflows: el.scrollHeight > el.clientHeight + 1,
        slot: el.offsetWidth - el.clientWidth - el.clientLeft - parseFloat(style.borderRightWidth),
        gutter: style.scrollbarGutter,
        inset,
        left: contentLeft,
        right: window.innerWidth - contentRight,
        box: `${box.left}..${box.right} of ${window.innerWidth}`,
        // A box that hides its overflow still clips it, and focus can scroll it sideways: a
        // scroller reaching past one would lose its bar and shift the page.
        clippedBy: (() => {
          const out: string[] = [];
          for (let up = el.parentElement; up; up = up.parentElement) {
            if (getComputedStyle(up).overflowX !== "visible" && up.scrollWidth > up.clientWidth + 1) out.push(up.className || up.tagName);
          }
          return out;
        })(),
      };
    });

  const expectGutter = (seen: Awaited<ReturnType<typeof measure>>, name: string, fullBleed: boolean) => {
    expect(seen.gutter, name).toBe("stable");
    expect(seen.clippedBy, `${name}: reaches past a clipping ancestor`).toEqual([]);
    expect(seen.slot, `${name}: the bar's slot`).toBe(8);
    expect(Math.abs(seen.right - seen.inset), `${name}: right inset ${seen.right} vs ${seen.inset} (${seen.box})`).toBeLessThanOrEqual(1);
    if (fullBleed) expect(Math.abs(seen.left - seen.inset), `${name}: left inset ${seen.left} vs ${seen.inset}`).toBeLessThanOrEqual(1);
  };

  for (const { height, overflows } of [{ height: 280, overflows: true }, { height: 1400, overflows: false }]) {
    test(`Usage, narrow and wide, provider and settings, ${overflows ? "scrolling" : "not scrolling"}`, async ({ page }) => {
      await open(page);
      for (const width of [444, 760]) {
        await page.setViewportSize({ width, height });
        await page.getByRole("tab", { name: "Usage" }).click();
        const scroller = width <= 520 ? ".usage-layout" : ".usage-detail-panel";
        for (const view of ["provider", "settings"]) {
          if (view === "settings") await page.getByRole("button", { name: "Usage settings" }).click();
          const name = `${view} at ${width}x${height}`;
          // The settings page is short: it never fills the tall window and may not fill the short one.
          if (view === "provider") await expect.poll(async () => (await measure(page, scroller)).overflows, `premise: ${name} overflows`).toBe(overflows);
          else if (!overflows) expect((await measure(page, scroller)).overflows).toBe(false);
          expectGutter(await measure(page, scroller), name, width <= 520);
        }
        await page.getByRole("button", { name: "Usage settings" }).click();
      }
    });

    test(`Sessions, ${overflows ? "scrolling" : "not scrolling"}`, async ({ page }) => {
      await open(page);
      // The demo's sessions fill a window shorter than Usage's needs.
      await page.setViewportSize({ width: 444, height: overflows ? 150 : height });
      await page.getByRole("tab", { name: "Sessions" }).click();
      await expect(page.locator(".session-list").first()).toBeVisible();
      await expect.poll(async () => (await measure(page, ".sheet-body")).overflows, "premise").toBe(overflows);
      expectGutter(await measure(page, ".sheet-body"), "Sessions", true);
    });

    test(`Settings, ${overflows ? "scrolling" : "not scrolling"}`, async ({ page }) => {
      await open(page);
      await page.setViewportSize({ width: 444, height });
      await settingsTabs(page);
      // Connection is the tallest tab; the bar's slot is kept either way.
      await expect.poll(async () => (await measure(page, ".setup-category-panel")).overflows, "premise").toBe(overflows);
      expectGutter(await measure(page, ".setup-category-panel"), "Settings", false);
      // The page itself does not keep a second, empty slot beside the panel's.
      expect((await measure(page, ".sheet-body")).gutter).toBe("auto");
    });
  }
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
