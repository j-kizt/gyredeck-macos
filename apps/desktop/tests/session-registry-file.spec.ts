import { expect, test, type Page } from "@playwright/test";

/**
 * In the desktop app the session registry lives in a file, not localStorage (#280): the old
 * copy is moved in and removed only once the file holds it, saves are ordered and spaced,
 * and the app never writes the registry to localStorage again.
 */

const KEY = "gyredeck.session-events";

type Mode = { load: "absent" | "ok" | "okBadShape" | "corrupt" | "unreadable" | "throws"; loadFailures?: number; failFirstSave?: boolean; failSaves?: number; saveDelayMs?: number; firstSaveDelayMs?: number };

const event = (conversationId: string, message: string) => ({
  version: 2,
  id: `${conversationId}-done`,
  timestamp: new Date(Date.now() - 60_000).toISOString(),
  agentId: "agent-demo",
  agentName: "Mahiro Code",
  conversationId,
  cwd: "/Users/mahiro/ghq/github.com/j-kizt/gyredeck-macos",
  model: "gpt-5.6-sol",
  permissionMode: "unrestricted",
  type: "turn_complete",
  data: { hookEventName: "Stop", source: "hook", message },
});

const open = async (page: Page, mode: Mode, legacy: Record<string, unknown[]> | null, demo = true) => {
  await page.route("http://127.0.0.1:47621/**", (route) => route.abort());
  await page.addInitScript(
    ([mode, legacy, key, fileRegistry]) => {
      const log: { at: number; what: string; detail?: unknown }[] = [];
      (window as typeof window & { __registryLog: typeof log }).__registryLog = log;
      if (legacy && !sessionStorage.getItem("seeded")) {
        localStorage.setItem(key, JSON.stringify(legacy));
        sessionStorage.setItem("seeded", "1");
      }
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name: string, value: string) {
        if (name === key) log.push({ at: performance.now(), what: "localStorage.setItem" });
        return setItem.call(this, name, value);
      };
      const removeItem = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (name: string) {
        if (name === key) log.push({ at: performance.now(), what: "localStorage.removeItem" });
        return removeItem.call(this, name);
      };
      let saves = 0;
      let loads = 0;
      let revision = 7;
      (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (command: string, args?: { registry: Record<string, unknown> }) => {
          if (command === "set_keep_awake") return false;
          if (command === "session_registry_load") {
            loads += 1;
            log.push({ at: performance.now(), what: "load" });
            if (loads <= (mode.loadFailures ?? 0)) throw new Error("app data folder busy");
            if (mode.load === "ok") return { state: "ok", revision: 7, registry: fileRegistry };
            if (mode.load === "okBadShape") return { state: "ok", revision: 7, registry: { "file-conv": [{ id: "e", timestamp: new Date().toISOString() }] } };
            if (mode.load === "corrupt") return { state: "corrupt", kept: "/tmp/session-events.corrupt-1.json" };
            if (mode.load === "unreadable") return { state: "unreadable", reason: "permission denied" };
            if (mode.load === "throws") throw new Error("no app data folder");
            return { state: "absent" };
          }
          if (command === "session_registry_save") {
            saves += 1;
            const failed = saves <= (mode.failSaves ?? (mode.failFirstSave ? 1 : 0));
            const count = Object.values(args?.registry ?? {}).reduce((sum: number, events) => sum + (events as unknown[]).length, 0);
            log.push({ at: performance.now(), what: "save", detail: { keys: Object.keys(args?.registry ?? {}), failed, count } });
            await new Promise((resolve) => setTimeout(resolve, saves === 1 && mode.firstSaveDelayMs ? mode.firstSaveDelayMs : mode.saveDelayMs ?? 0));
            if (failed) {
              log.push({ at: performance.now(), what: "save failed" });
              throw new Error("disk full");
            }
            revision += 1;
            log.push({ at: performance.now(), what: "save done", detail: { revision, count } });
            return revision;
          }
          throw new Error(`${command} unavailable`);
        },
      };
    },
    [mode, legacy, KEY, { "file-conv": [event("file-conv", "From the file")] }] as const,
  );
  await page.goto(demo ? "/?demo=1" : "/");
};

const log = (page: Page) =>
  page.evaluate(() => (window as typeof window & { __registryLog: { at: number; what: string; detail?: { revision?: number; keys?: string[]; failed?: boolean; count?: number } }[] }).__registryLog);

test("in the desktop app the registry is saved to the file, in order and spaced, and never to localStorage", async ({ page }) => {
  await open(page, { load: "absent" }, null);
  await page.waitForTimeout(6_000);
  const entries = await log(page);
  expect(entries.filter((entry) => entry.what === "localStorage.setItem")).toEqual([]);
  const saves = entries.filter((entry) => entry.what === "save");
  expect(saves.length).toBeGreaterThan(0);
  // Demo events arrive every 800 ms; a save at most every two seconds.
  expect(saves.length).toBeLessThanOrEqual(4);
  // One window's saves reach the store one after another: each starts after the last ended.
  const order = entries.filter((entry) => entry.what === "save" || entry.what === "save done").map((entry) => entry.what);
  expect(order.every((what, index) => what === (index % 2 === 0 ? "save" : "save done"))).toBe(true);
});

test("the old localStorage copy is moved into the file and removed only after the file holds it", async ({ page }) => {
  await open(page, { load: "absent", saveDelayMs: 500 }, { "legacy-conv": [event("legacy-conv", "From localStorage")] }, false);
  await expect(page.locator(".session-row").first()).toBeVisible();
  await expect.poll(async () => (await log(page)).map((entry) => entry.what)).toContain("localStorage.removeItem");
  const entries = await log(page);
  const save = entries.find((entry) => entry.what === "save");
  const done = entries.find((entry) => entry.what === "save done");
  const removed = entries.find((entry) => entry.what === "localStorage.removeItem");
  expect(save?.detail?.keys).toContain("legacy-conv");
  expect(removed!.at).toBeGreaterThanOrEqual(done!.at);
});

test("a migration save that fails keeps the old copy until a later save succeeds", async ({ page }) => {
  await open(page, { load: "absent", failFirstSave: true }, { "legacy-conv": [event("legacy-conv", "From localStorage")] });
  await expect.poll(async () => (await log(page)).map((entry) => entry.what)).toContain("save failed");
  const failedAt = (await log(page)).find((entry) => entry.what === "save failed")!.at;
  await expect.poll(async () => (await log(page)).find((entry) => entry.what === "localStorage.removeItem")?.at ?? -1, { timeout: 10_000 }).toBeGreaterThan(failedAt);
  const removedAt = (await log(page)).find((entry) => entry.what === "localStorage.removeItem")!.at;
  expect((await log(page)).some((entry) => entry.what === "save done" && entry.at <= removedAt)).toBe(true);
});

test("a file already holding the registry wins, and a leftover localStorage copy is removed unread", async ({ page }) => {
  await open(page, { load: "ok" }, { "legacy-conv": [event("legacy-conv", "From localStorage")] }, false);
  await expect(page.locator(".session-row")).toHaveCount(1);
  await expect(page.locator(".session-row").first()).toContainText("gyredeck-macos");
  const entries = await log(page);
  expect(entries.map((entry) => entry.what)).toContain("localStorage.removeItem");
  expect(entries.filter((entry) => entry.what === "save").flatMap((entry) => entry.detail?.keys ?? [])).not.toContain("legacy-conv");
});

test("a corrupt file is not read as empty: the old copy is used and saved", async ({ page }) => {
  await open(page, { load: "corrupt" }, { "legacy-conv": [event("legacy-conv", "From localStorage")] }, false);
  await expect(page.locator(".session-row").first()).toBeVisible();
  await expect.poll(async () => (await log(page)).find((entry) => entry.what === "save")?.detail?.keys ?? []).toContain("legacy-conv");
});

test("leaving the page saves what is pending at once", async ({ page }) => {
  await open(page, { load: "absent" }, null);
  await expect.poll(async () => (await log(page)).filter((entry) => entry.what === "save").length).toBeGreaterThan(0);
  // A demo event lands right after a save, so one is pending inside the two-second wait.
  await page.waitForTimeout(900);
  const before = (await log(page)).filter((entry) => entry.what === "save").length;
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect.poll(async () => (await log(page)).filter((entry) => entry.what === "save").length, { timeout: 500 }).toBeGreaterThan(before);
});

test("a quiet app clears data that ages past 30 days within the hour, and saves the result", async ({ page }) => {
  // No demo events: nothing arrives, so only the hourly sweep can clear it.
  await page.clock.install({ time: new Date("2026-11-02T03:00:00.000Z") });
  const almostOld = { ...event("ageing-conv", "Ages out"), timestamp: new Date(Date.parse("2026-11-02T03:00:00.000Z") - 30 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString() };
  await open(page, { load: "absent" }, { "ageing-conv": [almostOld], "fresh-conv": [event("fresh-conv", "Stays")] }, false);
  await expect.poll(async () => (await log(page)).filter((entry) => entry.what === "save done").length).toBeGreaterThan(0);
  const first = (await log(page)).find((entry) => entry.what === "save");
  expect(first?.detail?.keys?.sort()).toEqual(["ageing-conv", "fresh-conv"]);
  await page.clock.fastForward("01:01:00");
  await expect.poll(async () => (await log(page)).filter((entry) => entry.what === "save").at(-1)?.detail?.keys).toEqual(["fresh-conv"]);
});

for (const [why, load] of [["the store cannot be reached", "throws"], ["the file is there but unreadable", "unreadable"]] as const) {
  test(`when ${why}, nothing is saved anywhere, the read is retried, and the sessions tab says so`, async ({ page }) => {
    const legacy = { "legacy-conv": [event("legacy-conv", "From localStorage")] };
    await open(page, { load }, legacy);
    await page.waitForTimeout(3_000);
    const entries = await log(page);
    expect(entries.map((entry) => entry.what)).not.toContain("localStorage.setItem");
    expect(entries.map((entry) => entry.what)).not.toContain("localStorage.removeItem");
    expect(entries.map((entry) => entry.what)).not.toContain("save");
    expect(entries.filter((entry) => entry.what === "load").length, "the read is tried again").toBeGreaterThan(1);
    expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), KEY)) ?? "null")).toEqual(legacy);
    await expect(page.getByRole("status").filter({ hasText: "Session history is not being saved" })).toBeVisible();
  });
}

test("on a quiet app a save that failed is tried again until it lands, and only then is the old copy removed", async ({ page }) => {
  // Three failures in a row: the migration's own save, then the first two retries.
  await open(page, { load: "absent", failSaves: 3 }, { "legacy-conv": [event("legacy-conv", "From localStorage")] }, false);
  await expect.poll(async () => (await log(page)).map((entry) => entry.what), { timeout: 10_000 }).toContain("save done");
  const entries = await log(page);
  const failedAt = entries.find((entry) => entry.what === "save failed")!.at;
  const doneAt = entries.find((entry) => entry.what === "save done")!.at;
  expect(doneAt).toBeGreaterThan(failedAt);
  expect(entries.filter((entry) => entry.what === "localStorage.removeItem").every((entry) => entry.at >= doneAt)).toBe(true);
  await expect.poll(async () => (await log(page)).map((entry) => entry.what)).toContain("localStorage.removeItem");
});

test("a read that fails for a while is retried, and what arrived meanwhile is kept and saved once it reads", async ({ page }) => {
  await open(page, { load: "absent", loadFailures: 2 }, null);
  await expect(page.getByRole("status").filter({ hasText: "Session history is not being saved" })).toBeVisible();
  await expect.poll(async () => (await log(page)).map((entry) => entry.what), { timeout: 10_000 }).toContain("save done");
  const entries = await log(page);
  const firstSave = entries.findIndex((entry) => entry.what === "save");
  expect(entries.slice(0, firstSave).filter((entry) => entry.what === "load").length, "no save before a read succeeded").toBe(3);
  expect(entries[firstSave].detail?.count ?? 0).toBeGreaterThan(1);
  await expect(page.getByRole("status").filter({ hasText: "Session history is not being saved" })).toHaveCount(0);
});

test("a slow save that fails never brings an older registry back over a newer one", async ({ page }) => {
  // The first save fails after 5 s, while newer ones succeed behind it.
  await open(page, { load: "absent", failSaves: 1, firstSaveDelayMs: 5_000 }, null);
  await page.waitForTimeout(12_000);
  const done = (await log(page)).filter((entry) => entry.what === "save done").map((entry) => entry.detail?.count ?? 0);
  expect(done.length).toBeGreaterThan(1);
  expect(done, "what is kept never shrinks").toEqual([...done].sort((a, b) => a - b));
});

test("a stored registry this version cannot read is never replaced by the old copy: nothing is saved, and the sessions tab says so", async ({ page }) => {
  const legacy = { "legacy-conv": [event("legacy-conv", "From localStorage")] };
  await open(page, { load: "okBadShape" }, legacy);
  await expect(page.getByRole("status").filter({ hasText: "Session history is not being saved" })).toBeVisible();
  await page.waitForTimeout(3_000);
  const entries = await log(page);
  expect(entries.map((entry) => entry.what)).not.toContain("save");
  expect(entries.map((entry) => entry.what)).not.toContain("localStorage.removeItem");
  expect(entries.map((entry) => entry.what)).not.toContain("localStorage.setItem");
  expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), KEY)) ?? "null")).toEqual(legacy);
});
