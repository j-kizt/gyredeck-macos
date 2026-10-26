import { expect, test, type Page } from "@playwright/test";

/**
 * Settings → Permission holds one "answer rooms without asking" switch per agent (#261):
 * Claude Code's and Antigravity's, each in its own row, each governing only its own agent.
 */

type State = "on" | "off" | "hook missing" | "checking";

const AGENTS = [
  { agent: "claude", name: "Claude Code" },
  { agent: "agy", name: "Antigravity" },
] as const;

const detailFor = (state: State, name: string) =>
  ({
    on: `On: ${name} replies and listens in its room with no prompt each time.`,
    off: "Off: it asks before every reply and every wait.",
    "hook missing": `Needs the ${name} hook — install it under Plugins`,
    checking: "Checking…",
  })[state];

const openPermission = async (page: Page, state: State) => {
  await page.addInitScript((state) => {
    const calls: unknown[] = [];
    (window as typeof window & { __syncCalls: unknown[] }).__syncCalls = calls;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: unknown) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", state !== "hook missing"];
        if (command === "sync_replies_allowed") {
          calls.push({ command, args });
          return state === "checking" ? new Promise(() => {}) : state === "on";
        }
        if (command === "set_sync_replies_allowed") {
          calls.push({ command, args });
          return null;
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, state);
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Permission" }).click();
  await expect(page.getByRole("tabpanel", { name: "Permission" })).toBeVisible();
};

// 444 × 560 is the window's minimum. At that size the Permission column has room to spare, so
// the rows are never squeezed; 444 × 280 makes the column scroll, which is the case
// `.setup-category-panel > * { flex-shrink: 0 }` exists for (#243), so the rule is pinned
// before a third row or longer copy needs it.
for (const viewport of [{ width: 444, height: 560 }, { width: 444, height: 280 }]) test.describe(`at ${viewport.width} × ${viewport.height}`, () => {
  test.use({ viewport });

  for (const state of ["on", "off", "hook missing", "checking"] as const) {
    test(`both rows stay inside their boxes, below the heading and apart: ${state}`, async ({ page }) => {
      await openPermission(page, state);
      const panel = page.getByRole("tabpanel", { name: "Permission" });
      for (const { agent, name } of AGENTS) {
        const row = page.locator(`.setup-row[data-sync-agent='${agent}']`);
        // Premise: the row shows this state's longest text, so the layout is measured on it.
        await expect(row.locator(".setup-title")).toHaveText(`${name}: answer rooms without asking`);
        await expect(row.locator(".setup-detail")).toHaveText(detailFor(state, name));
      }
      // One reading of every box, so a scroll between two of them cannot skew the comparison.
      const { head, rows } = await panel.evaluate((element) => {
        const rect = (node: Element | null) => {
          if (!node) throw new Error("not laid out");
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          head: rect(element.querySelector(".setup-section-heading")),
          rows: ["claude", "agy"].map((agent) => {
            const row = element.querySelector(`.setup-row[data-sync-agent='${agent}']`);
            return { agent, row: rect(row), copy: rect(row?.querySelector(".setup-copy") ?? null) };
          }),
        };
      });
      for (const { agent, row, copy } of rows) {
        expect(copy.x, agent).toBeGreaterThanOrEqual(row.x);
        expect(copy.x + copy.width, agent).toBeLessThanOrEqual(row.x + row.width + 0.5);
        expect(copy.y, agent).toBeGreaterThanOrEqual(row.y);
        expect(copy.y + copy.height, agent).toBeLessThanOrEqual(row.y + row.height + 0.5);
        expect(row.y, agent).toBeGreaterThanOrEqual(head.y + head.height);
      }
      const [claude, agy] = rows.map(({ row }) => row);
      expect(agy.y).toBeGreaterThanOrEqual(claude.y + claude.height);
      if (viewport.height < 560) {
        // Premise: the column really scrolls here, or this case says nothing about squeezing.
        expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      }
      const overflow = await panel.evaluate((element) => {
        const all = [element, ...element.querySelectorAll<HTMLElement>(".setup-row, .setup-copy, .setup-detail, .setup-title")];
        return all.filter((node) => node.scrollWidth > node.clientWidth).map((node) => node.className);
      });
      expect(overflow).toEqual([]);
    });
  }
});

test("each switch moves only its own agent, and the Antigravity one starts off", async ({ page }) => {
  await openPermission(page, "off");
  const claude = page.locator(".setup-row[data-sync-agent='claude']").getByRole("switch");
  const agy = page.locator(".setup-row[data-sync-agent='agy']").getByRole("switch");
  await expect(agy).toHaveAttribute("aria-checked", "false");
  await expect(agy).toHaveAccessibleName("Let Antigravity answer rooms without asking");
  await agy.click();
  await expect(agy).toHaveAttribute("aria-checked", "true");
  await expect(claude).toHaveAttribute("aria-checked", "false");
  await expect(page.locator(".setup-row[data-sync-agent='agy'] .setup-detail")).toHaveText(detailFor("on", "Antigravity"));
  await expect(page.locator(".setup-row[data-sync-agent='claude'] .setup-detail")).toHaveText(detailFor("off", "Claude Code"));
  const calls = await page.evaluate(() => (window as typeof window & { __syncCalls: unknown[] }).__syncCalls);
  expect(calls).toEqual(
    expect.arrayContaining([
      { command: "sync_replies_allowed", args: { agent: "claude" } },
      { command: "sync_replies_allowed", args: { agent: "agy" } },
      { command: "set_sync_replies_allowed", args: { agent: "agy", enabled: true } },
    ]),
  );
  expect(calls.filter((call) => (call as { command: string }).command === "set_sync_replies_allowed")).toHaveLength(1);
});

