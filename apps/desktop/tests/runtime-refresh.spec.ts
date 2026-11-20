import { expect, test, type Page } from "@playwright/test";

/**
 * Listening Ports: a refresh the person asks for stays busy for at least one turn of the spin
 * (0.8 s) even when the scan answers at once, while the snapshot still lands the moment it
 * arrives. The 5 s automatic scan is not held, so the toolbar does not pulse (#376).
 *
 * Demo mode never scans, so the native side is mocked. Every look at "Checking…" is recorded
 * by a MutationObserver from the page's own clock, not sampled, so a hold cannot slip between
 * two polls.
 */

type Win = typeof window & {
  __scans: number;
  __scanDelayMs: number;
  __busy: Array<{ shownAt: number; hiddenAt: number | null }>;
  __clickedAt: number;
};

const service = (port: number) => ({
  processId: 4000 + port, processStartTimeMs: 1_790_000_000_000, processName: "node", parentProcessId: null, parentProcessName: null,
  executablePath: null, commandLine: null, userId: 501, physicalFootprintBytes: null, residentSizeBytes: null,
  bindAddress: "127.0.0.1", port, kind: "tcp", webFrontend: false, httpTitle: null, url: null, cwd: null, owner: null,
  controlAvailable: true, controlUnavailableReason: null,
});

const open = async (page: Page) => {
  await page.addInitScript(([first, later]) => {
    const w = window as Win;
    w.__scans = 0;
    w.__scanDelayMs = 0;
    w.__busy = [];
    (w as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "local_services") {
          w.__scans += 1;
          // The first scan finds one listener and every later one two, so a test can see the
          // later snapshot land while the busy state is still held.
          const services = w.__scans === 1 ? [first] : [first, later];
          if (w.__scanDelayMs) await new Promise((resolve) => setTimeout(resolve, w.__scanDelayMs));
          return { services, error: null };
        }
        throw new Error(`${command} unavailable`);
      },
    };
    const watch = () => {
      const isShown = () => Array.from(document.querySelectorAll(".runtime-toolbar [role='status']")).some((el) => el.textContent === "Checking…");
      let shown = false;
      new MutationObserver(() => {
        const now = isShown();
        if (now === shown) return;
        shown = now;
        if (now) w.__busy.push({ shownAt: performance.now(), hiddenAt: null });
        else w.__busy[w.__busy.length - 1].hiddenAt = performance.now();
      }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    };
    if (document.documentElement) watch();
    else document.addEventListener("DOMContentLoaded", watch);
  }, [service(3000), service(5173)]);
  await page.goto("/");
  await page.getByRole("tab", { name: "Listening Ports" }).click();
  await expect(page.getByText("1 local listeners")).toBeVisible();
  // Settle: the first, automatic scan has come and gone.
  await expect(page.getByRole("button", { name: "Refresh listening ports" })).toBeEnabled();
};

const clickRefresh = async (page: Page) => {
  await page.evaluate(() => {
    const w = window as Win;
    w.__busy = [];
    w.__clickedAt = performance.now();
  });
  await page.getByRole("button", { name: "Refresh listening ports" }).click();
};

const busyRun = (page: Page) => page.evaluate(() => {
  const w = window as Win;
  return { clickedAt: w.__clickedAt, runs: w.__busy };
});

test("a manual refresh that answers at once stays busy for a full turn, and its snapshot lands at once", async ({ page }) => {
  await open(page);
  await clickRefresh(page);
  // The second scan's snapshot is on screen while the busy state is still held.
  await expect(page.getByText("2 local listeners")).toBeVisible();
  await expect(page.locator(".runtime-toolbar [role='status']")).toHaveText("Checking…");
  await expect(page.getByRole("button", { name: "Refreshing listening ports" })).toBeDisabled();
  await expect(page.locator(".runtime-toolbar .is-spinning")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Refresh listening ports" })).toBeEnabled({ timeout: 3_000 });
  const { clickedAt, runs } = await busyRun(page);
  expect(runs).toHaveLength(1);
  expect(runs[0].hiddenAt! - clickedAt).toBeGreaterThanOrEqual(800);
  expect(runs[0].hiddenAt! - clickedAt).toBeLessThan(1_500);
  expect(await page.evaluate(() => (window as Win).__scans)).toBe(2);
});

test("a manual refresh whose scan is slow stays busy until the scan ends, not just for the turn", async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as Win).__scanDelayMs = 1_600; });
  await clickRefresh(page);
  await expect(page.getByRole("button", { name: "Refresh listening ports" })).toBeEnabled({ timeout: 4_000 });
  const { clickedAt, runs } = await busyRun(page);
  expect(runs).toHaveLength(1);
  expect(runs[0].hiddenAt! - clickedAt).toBeGreaterThanOrEqual(1_600);
  await expect(page.getByText("2 local listeners")).toBeVisible();
});

test("the automatic scan every 5 s is not held: its busy state lasts only as long as the scan", async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as Win).__busy = []; });
  // Premise: an automatic scan has run (no click), and has landed its snapshot.
  await expect(page.getByText("2 local listeners")).toBeVisible({ timeout: 7_000 });
  await expect.poll(() => page.evaluate(() => (window as Win).__busy.every((run) => run.hiddenAt !== null))).toBe(true);
  const { runs } = await busyRun(page);
  for (const run of runs) expect(run.hiddenAt! - run.shownAt).toBeLessThan(400);
});

test("with reduced motion the icon does not spin, and Checking… is still held for the turn", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  await clickRefresh(page);
  await expect(page.locator(".runtime-toolbar [role='status']")).toHaveText("Checking…");
  expect(await page.locator(".runtime-toolbar svg").evaluate((icon) => getComputedStyle(icon).animationName)).toBe("none");
  await expect(page.getByRole("button", { name: "Refresh listening ports" })).toBeEnabled({ timeout: 3_000 });
  const { clickedAt, runs } = await busyRun(page);
  expect(runs).toHaveLength(1);
  expect(runs[0].hiddenAt! - clickedAt).toBeGreaterThanOrEqual(800);
});

test("without reduced motion the held busy state spins the icon", async ({ page }) => {
  await open(page);
  await clickRefresh(page);
  await expect(page.locator(".runtime-toolbar [role='status']")).toHaveText("Checking…");
  expect(await page.locator(".runtime-toolbar svg").evaluate((icon) => getComputedStyle(icon).animationName)).toBe("runtime-spin");
});
