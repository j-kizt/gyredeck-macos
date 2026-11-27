import { expect, test, type Page } from "@playwright/test";

/**
 * In the desktop app the caches it rewrites often live in files, not localStorage (#300):
 * the old copy is moved in and removed only once the file holds it, saves are spaced and
 * skipped when nothing changed, a file that cannot be read is never saved over, and an app
 * that cannot be asked keeps localStorage as before.
 */

const KEY = "gyredeck.room-inbox";
/** A registry the inbox can render, tagged so each copy can be told apart. */
const inbox = (tag: string) => JSON.stringify({ [tag]: { room: "sync-a1b2", messages: [], readAt: null } });
type Load = "absent" | "ok" | "unreadable" | "throws" | "hangs" | "odd";
type Mode = { load: Load; failSaves?: number; saveDelayMs?: number };
type Entry = { at: number; what: string; name?: string; text?: string };

const open = async (page: Page, mode: Mode, legacy: string | null) => {
  await page.route("http://127.0.0.1:47621/**", (route) => route.abort());
  await page.addInitScript(
    ([mode, legacy, key, fileText]) => {
      const log: Entry[] = [];
      (window as typeof window & { __log: Entry[] }).__log = log;
      if (legacy !== null && !sessionStorage.getItem("seeded")) {
        localStorage.setItem(key, legacy);
        sessionStorage.setItem("seeded", "1");
      }
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name: string, value: string) {
        if (name === key) log.push({ at: performance.now(), what: "localStorage.setItem", text: value });
        return setItem.call(this, name, value);
      };
      const removeItem = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (name: string) {
        if (name === key) log.push({ at: performance.now(), what: "localStorage.removeItem" });
        return removeItem.call(this, name);
      };
      let saves = 0;
      (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (command: string, args?: { name: string; text?: string }) => {
          if (command === "app_file_load") {
            if (args?.name !== "room-inbox") return { state: "absent" };
            log.push({ at: performance.now(), what: "load" });
            if (mode.load === "throws") throw new Error("no app data folder");
            if (mode.load === "hangs") return new Promise(() => undefined);
            if (mode.load === "odd") return { state: "ok", text: 5 };
            if (mode.load === "unreadable") return { state: "unreadable", reason: "permission denied" };
            if (mode.load === "ok") return { state: "ok", text: fileText };
            return { state: "absent" };
          }
          if (command === "app_file_save") {
            if (args?.name !== "room-inbox") return null;
            saves += 1;
            log.push({ at: performance.now(), what: "save", text: args.text });
            await new Promise((resolve) => setTimeout(resolve, mode.saveDelayMs ?? 0));
            if (saves <= (mode.failSaves ?? 0)) {
              log.push({ at: performance.now(), what: "save failed" });
              throw new Error("disk full");
            }
            log.push({ at: performance.now(), what: "save done", text: args.text });
            return null;
          }
          throw new Error(`${command} unavailable`);
        },
      };
    },
    [mode, legacy, KEY, inbox("file")] as const,
  );
  await page.goto("/");
  await expect(page.locator("#root > *").first()).toBeAttached({ timeout: 10_000 });
  await expect(page.locator(".app-error")).toHaveCount(0);
};

const log = (page: Page) => page.evaluate(() => (window as typeof window & { __log: Entry[] }).__log);
const write = (page: Page, text: string) =>
  page.evaluate(async (text) => {
    const { writeAppFile } = await import("/src/features/storage/appFiles.ts");
    writeAppFile("room-inbox", text);
  }, text);
const read = (page: Page) =>
  page.evaluate(async () => (await import("/src/features/storage/appFiles.ts")).readAppFile("room-inbox"));

test("writes go to the file, spaced and only when changed, and never to localStorage", async ({ page }) => {
  await open(page, { load: "absent" }, null);
  for (let n = 0; n < 10; n += 1) await write(page, inbox(`n${n}`));
  expect(await read(page)).toBe(inbox("n9"));
  await expect.poll(async () => (await log(page)).filter((entry) => entry.what === "save done").map((entry) => entry.text)).toEqual([inbox("n9")]);
  await write(page, inbox("n9"));
  await page.waitForTimeout(2_500);
  const entries = await log(page);
  expect(entries.filter((entry) => entry.what === "save")).toHaveLength(1);
  expect(entries.filter((entry) => entry.what === "localStorage.setItem")).toEqual([]);
});

test("the old localStorage copy is moved into the file and removed only after the file holds it", async ({ page }) => {
  await open(page, { load: "absent", saveDelayMs: 500 }, inbox("legacy"));
  expect(await read(page)).toBe(inbox("legacy"));
  await expect.poll(async () => (await log(page)).map((entry) => entry.what)).toContain("localStorage.removeItem");
  const entries = await log(page);
  const done = entries.find((entry) => entry.what === "save done");
  expect(done?.text).toBe(inbox("legacy"));
  expect(entries.find((entry) => entry.what === "localStorage.removeItem")!.at).toBeGreaterThanOrEqual(done!.at);
});

test("a failed save keeps the old copy and is tried again until one lands", async ({ page }) => {
  await open(page, { load: "absent", failSaves: 2 }, inbox("legacy"));
  await expect.poll(async () => (await log(page)).filter((entry) => entry.what === "save done").length, { timeout: 10_000 }).toBe(1);
  const entries = await log(page);
  expect(entries.filter((entry) => entry.what === "save failed")).toHaveLength(2);
  const removed = entries.find((entry) => entry.what === "localStorage.removeItem");
  expect(removed!.at).toBeGreaterThanOrEqual(entries.find((entry) => entry.what === "save done")!.at);
});

test("a file already holding the cache wins, and a leftover localStorage copy is removed", async ({ page }) => {
  await open(page, { load: "ok" }, inbox("legacy"));
  expect(await read(page)).toBe(inbox("file"));
  const entries = await log(page);
  expect(entries.map((entry) => entry.what)).toContain("localStorage.removeItem");
  expect(entries.filter((entry) => entry.what === "save")).toEqual([]);
});

test("a file that cannot be read is never saved over, and nothing goes to localStorage", async ({ page }) => {
  await open(page, { load: "unreadable" }, inbox("legacy"));
  expect(await read(page)).toBe(inbox("legacy"));
  await write(page, inbox("n1"));
  expect(await read(page)).toBe(inbox("n1"));
  await page.waitForTimeout(2_500);
  const entries = await log(page);
  expect(entries.filter((entry) => entry.what === "save")).toEqual([]);
  expect(entries.filter((entry) => entry.what.startsWith("localStorage."))).toEqual([]);
});

for (const load of ["throws", "odd", "hangs"] as const) {
  test(`an app that ${load === "hangs" ? "does not answer" : load === "odd" ? "answers in a shape this side cannot read" : "fails to answer"} keeps localStorage as before, and the panel still opens`, async ({ page }) => {
    await open(page, { load }, inbox("legacy"));
    expect(await read(page)).toBe(inbox("legacy"));
    await write(page, inbox("n1"));
    const entries = await log(page);
    expect(entries.filter((entry) => entry.what === "localStorage.setItem").map((entry) => entry.text)).toEqual([inbox("n1")]);
    expect(entries.filter((entry) => entry.what === "save")).toEqual([]);
  });
}

test("leaving the page sends a pending save at once", async ({ page }) => {
  await open(page, { load: "absent" }, null);
  await write(page, inbox("n1"));
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect.poll(async () => (await log(page)).filter((entry) => entry.what === "save").map((entry) => entry.text), { timeout: 1_000 }).toEqual([inbox("n1")]); // inside the 2 s spacing
});
