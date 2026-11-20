import { expect, test, type Page } from "@playwright/test";

/**
 * Settings → Update (#376): the release notes are shown whole, in the Settings column's own
 * scroll, never in a box that scrolls on its own; and a failed check is said in the warning tone.
 */

const LONG_NOTES = ["## A long release (v9.9.9)", "", "### Fixes", "", ...Array.from({ length: 40 }, (_, n) => `- Fix number ${n + 1}, described in a whole sentence so the list runs long.`)].join("\n");

const open = async (page: Page, check: "notes" | "fails") => {
  await page.addInitScript(([notes, mode]) => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "plugin:app|version") return "9.9.8";
        if (command === "plugin:updater|check") {
          if (mode === "fails") throw new Error("Could not fetch a valid release JSON from the remote");
          return { rid: 1, currentVersion: "9.9.8", version: "9.9.9", date: "2026-11-02T00:00:00Z", body: notes, rawJson: {} };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, [LONG_NOTES, check] as const);
  await page.setViewportSize({ width: 444, height: 560 });
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("tab", { name: "Update", exact: true }).click();
};

test("the release notes are not their own scroller: shown whole, wrapped, in the column's scroll", async ({ page }) => {
  await open(page, "notes");
  const notes = page.locator(".update-notes-body");
  // Premise: the notes are long enough that a capped box would have scrolled.
  await expect(notes.locator("li")).toHaveCount(40);
  const box = await notes.evaluate((el) => {
    const style = getComputedStyle(el);
    return { overflowY: style.overflowY, overflowX: style.overflowX, maxHeight: style.maxHeight, wrap: style.overflowWrap, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, height: el.getBoundingClientRect().height };
  });
  expect(box.overflowY).toBe("visible");
  expect(box.overflowX).toBe("clip");
  expect(box.maxHeight).toBe("none");
  expect(box.wrap).toBe("anywhere");
  expect(box.height).toBeGreaterThan(400);
  expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight + 1);
  // The column is what scrolls.
  expect(await page.locator(".setup-category-panel").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});

test("a failed update check is said in the warning tone", async ({ page }) => {
  await open(page, "fails");
  const detail = page.locator(".setup-row", { hasText: "App updates" }).locator(".setup-detail");
  await expect(detail).toHaveAttribute("data-tone", "warn");
  const [color, warn] = await detail.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--warn-text)";
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(el).color, expected];
  });
  expect(warn).not.toBe("");
  expect(color).toBe(warn);
});

test("an update check that did not fail is not in the warning tone", async ({ page }) => {
  await open(page, "notes");
  const detail = page.locator(".setup-row", { hasText: "App updates" }).locator(".setup-detail");
  await expect(detail).toContainText("Update available");
  await expect(detail).not.toHaveAttribute("data-tone", "warn");
});
