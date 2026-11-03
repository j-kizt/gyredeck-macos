import { expect, test, type Page } from "@playwright/test";

// #211, #278: every set_keep_awake answers with what Rust holds and why, and it is sent again on
// a beat, so the row follows Rust with no event to miss.
type Answer = { display: boolean; system: boolean; why: string | null; error: string | null; rev: number } | "unreachable" | "hang";

const ROOM = "sync-ab12 connected to Discord — the Mac won't idle-sleep";
const HEAVY = "heavy run: vitest — the Mac won't idle-sleep";
const held = (why: string | null, rev: number, error: string | null = null): Answer => ({ display: false, system: why !== null, why, error, rev });

const open = async (page: Page, first: Answer) => {
  await page.clock.install();
  await page.addInitScript((answer) => {
    window.localStorage.setItem("gyredeck.keep-awake-while-working", "true");
    const w = window as typeof window & { __TAURI_INTERNALS__: unknown; __answer: unknown; __calls: number; __sent: unknown[]; __out: number; __most: number };
    Object.assign(w, { __answer: answer, __calls: 0, __sent: [], __out: 0, __most: 0, __late: [] });
    w.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: unknown) => {
        if (command === "keep_awake_page") {
          const pages = (w as unknown as { __pages: number }).__pages = ((w as unknown as { __pages?: number }).__pages ?? 0) + 1;
          if ((w as unknown as { __pageHangs?: boolean }).__pageHangs) return new Promise((resolve) => { (w as unknown as { __pageLate: Array<(v: unknown) => void> }).__pageLate = [...((w as unknown as { __pageLate?: Array<(v: unknown) => void> }).__pageLate ?? []), resolve]; });
          return 6 + pages;
        }
        if (command === "set_keep_awake") {
          w.__calls += 1;
          w.__sent.push(args);
          if (w.__answer === "hang") {
            w.__out += 1;
            w.__most = Math.max(w.__most, w.__out);
            return new Promise((resolve) => { (w as unknown as { __late: Array<(v: unknown) => void> }).__late.push(resolve); });
          }
          if (w.__answer === "unreachable") throw new Error("the app did not answer");
          return w.__answer;
        }
        if (command === "mail_rooms") return [];
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        throw new Error(`${command} unavailable`);
      },
    };
  }, first);
  await page.goto("/?demo=1&demoScenario=idle");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Display" }).click();
  return page.locator(".setup-row").filter({ hasText: "Keep awake while working" });
};

const answer = (page: Page, next: Answer) => page.evaluate((value) => { (window as typeof window & { __answer: unknown }).__answer = value; }, next);
const beat = (page: Page) => page.clock.runFor(5_000);

test("a room on Discord is named as what keeps the Mac awake", async ({ page }) => {
  const row = await open(page, held(ROOM, 1));
  await expect(row.getByText(`Active · ${ROOM}`)).toBeVisible();
});

test("with nothing held, the row says when it would stay awake", async ({ page }) => {
  const row = await open(page, held(null, 1));
  await expect(row.getByText("On · stays awake for agents, Discord rooms and heavy runs")).toBeVisible();
});

test("what changed in Rust since the last answer is read on the next beat", async ({ page }) => {
  const row = await open(page, held(HEAVY, 1));
  await expect(row.getByText(`Active · ${HEAVY}`)).toBeVisible();
  await answer(page, held(ROOM, 2));
  await beat(page);
  await expect(row.getByText(`Active · ${ROOM}`)).toBeVisible();
});

test("a refusal in Rust's answer is shown, and goes once an answer says it holds", async ({ page }) => {
  const row = await open(page, held(null, 1, "Failed to acquire keep-awake assertion (-1)"));
  await expect(row.getByText("Unavailable · Failed to acquire keep-awake assertion (-1)")).toBeVisible();
  await answer(page, held(ROOM, 2));
  await beat(page);
  await expect(row.getByText(`Active · ${ROOM}`)).toBeVisible();
  await expect(row.getByText(/Unavailable/)).toHaveCount(0);
});

test("a call Rust never answered is shown, then made good when it answers again", async ({ page }) => {
  const row = await open(page, "unreachable");
  await page.clock.runFor(3_500);
  await expect(row.getByText("Unavailable · the app did not answer")).toBeVisible();
  await answer(page, held(ROOM, 7));
  await beat(page);
  await expect(row.getByText(`Active · ${ROOM}`)).toBeVisible();
  await expect(row.getByText(/Unavailable/)).toHaveCount(0);
});

test("with the switch turned off while Rust does not answer, the row says so rather than Off", async ({ page }) => {
  const row = await open(page, held(ROOM, 1));
  await expect(row.getByText(`Active · ${ROOM}`)).toBeVisible();
  await answer(page, "unreachable");
  await row.getByRole("switch").click();
  await page.clock.runFor(3_500);
  await expect(row.getByText("Unavailable · the app did not answer")).toBeVisible();
});

test("an answer older than the one shown never replaces it", async ({ page }) => {
  const row = await open(page, held(ROOM, 5));
  await expect(row.getByText(`Active · ${ROOM}`)).toBeVisible();
  await answer(page, held(HEAVY, 3));
  await beat(page);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __calls: number }).__calls)).toBeGreaterThan(1);
  await expect(row.getByText(`Active · ${ROOM}`)).toBeVisible();
});

const stats = (page: Page) => page.evaluate(() => {
  const w = window as typeof window & { __sent: Array<{ enabled: boolean; seq: number }>; __most: number };
  return { sent: w.__sent.length, last: w.__sent.at(-1), seqs: w.__sent.map((call) => call.seq), most: w.__most };
});

test("a call that hangs holds nothing up: changes meanwhile go once, latest only, when it is given up on", async ({ page }) => {
  const row = await open(page, "hang");
  await expect.poll(async () => (await stats(page)).sent).toBe(1);
  const toggle = row.getByRole("switch");
  await toggle.click();
  await toggle.click();
  await toggle.click();
  expect((await stats(page)).sent, "nothing sent behind the call that is out").toBe(1);
  await answer(page, held(null, 9));
  await page.clock.runFor(3_500);
  const after = await stats(page);
  expect(after.sent, "the latest wish, sent once").toBe(2);
  expect(after.last).toMatchObject({ enabled: false });
  await expect(row.getByText("Off · display follows macOS idle settings")).toBeVisible();
});

test("a call that keeps hanging is shown as unanswered, never as Off", async ({ page }) => {
  const row = await open(page, "hang");
  await row.getByRole("switch").click();
  await page.clock.runFor(12_000);
  await expect(row.getByText("Unavailable · Gyredeck did not answer")).toBeVisible();
});

test("a switch-on given up on and answered late never turns the row back on", async ({ page }) => {
  const row = await open(page, "hang");
  await expect.poll(async () => (await stats(page)).sent).toBe(1);
  await row.getByRole("switch").click();
  await answer(page, held(null, 5));
  await page.clock.runFor(3_500);
  await expect(row.getByText("Off · display follows macOS idle settings")).toBeVisible();
  const { seqs } = await stats(page);
  expect(seqs, "each call later than the one before, so Rust applies none older").toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
  // The switch-on sent first is answered now, with what Rust held when it took it.
  await page.evaluate(() => (window as typeof window & { __late: Array<(v: unknown) => void> }).__late[0]({ display: false, system: true, why: "sync-ab12 connected to Discord — the Mac won't idle-sleep", error: null, rev: 1 }));
  await page.clock.runFor(100);
  await expect(row.getByText("Off · display follows macOS idle settings")).toBeVisible();
});

test("past two calls unanswered, nothing more is sent into a channel that does not answer", async ({ page }) => {
  const row = await open(page, "hang");
  await page.clock.runFor(30_000);
  const { sent, most } = await stats(page);
  expect(most, "never more than two out at once").toBeLessThanOrEqual(2);
  expect(sent).toBeLessThanOrEqual(2);
  await expect(row.getByText("Unavailable · Gyredeck did not answer")).toBeVisible();
});

test("every call carries the page number Rust gave this page, asked once", async ({ page }) => {
  await open(page, held(null, 1));
  await page.clock.runFor(5_100);
  const pages = await page.evaluate(() => (window as typeof window & { __sent: Array<{ page: number }> }).__sent.map((call) => call.page));
  expect(pages.length).toBeGreaterThan(1);
  expect(new Set(pages)).toEqual(new Set([7]));
});

test("the page number is asked once, however long it takes, so no two requests can cross", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => { (window as unknown as { __pageHangs: boolean }).__pageHangs = true; });
  const row = await open(page, held(ROOM, 1));
  await page.clock.runFor(12_000);
  expect(await page.evaluate(() => (window as unknown as { __pages: number }).__pages), "one request out, however many flights gave up on it").toBe(1);
  await page.evaluate(() => (window as unknown as { __pageLate: Array<(v: unknown) => void> }).__pageLate[0](7));
  await page.clock.runFor(5_100);
  const pages = await page.evaluate(() => (window as typeof window & { __sent: Array<{ page: number }> }).__sent.map((call) => call.page));
  expect(new Set(pages)).toEqual(new Set([7]));
  await expect(row.getByText(`Active · ${ROOM}`)).toBeVisible();
});
