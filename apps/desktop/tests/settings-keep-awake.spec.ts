import { expect, test, type Page } from "@playwright/test";

// #211, #278: Rust says what holds the Mac awake, and the row says it — with no agent working.
const mock = async (page: Page, why: string | null, error: string | null = null, options: { holdStatus?: boolean; failDisplay?: boolean } = {}) => {
  await page.addInitScript(([reason, failure, { holdStatus, failDisplay }]) => {
    window.localStorage.setItem("gyredeck.keep-awake-while-working", "true");
    const callbacks = new Map<number, (payload: unknown) => void>();
    let next = 0;
    const w = window as typeof window & { __TAURI_INTERNALS__: unknown; __emit: (event: string, payload: unknown) => void; __releaseStatus?: () => void };
    const listeners: Array<[string, number]> = [];
    Object.assign(w, { __listeners: listeners });
    w.__emit = (event, payload) => { for (const [name, id] of listeners) if (name === event) callbacks.get(id)?.({ event, id: 0, payload }); };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (payload: unknown) => void) => { next += 1; callbacks.set(next, callback); return next; },
      invoke: async (command: string, args?: { event?: string; handler?: number }) => {
        if (command === "plugin:event|listen") { listeners.push([String(args?.event), Number(args?.handler)]); return listeners.length; }
        if (command === "set_keep_awake") { if (failDisplay) throw new Error("display refused"); return false; }
        if (command === "keep_awake_status") {
          const snapshot = { display: false, system: false, why: reason, error: failure, rev: 1 };
          return holdStatus ? new Promise((resolve) => { w.__releaseStatus = () => resolve(snapshot); }) : snapshot;
        }
        if (command === "mail_rooms") return [];
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        throw new Error(`${command} unavailable`);
      },
    };
  }, [why, error, options] as const);
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Display" }).click();
  return page.locator(".setup-row").filter({ hasText: "Keep awake while working" });
};

test("a room on Discord is named as what keeps the Mac awake", async ({ page }) => {
  const row = await mock(page, "sync-ab12 connected to Discord — the Mac won't idle-sleep");
  await expect(row.getByText("Active · sync-ab12 connected to Discord — the Mac won't idle-sleep")).toBeVisible();
});

test("with nothing held, the row says when it would stay awake", async ({ page }) => {
  const row = await mock(page, null);
  await expect(row.getByText("On · stays awake for agents, Discord rooms and heavy runs")).toBeVisible();
});

test("a refusal from a background input is shown, and goes once Rust holds it after all", async ({ page }) => {
  const row = await mock(page, null, "Failed to acquire keep-awake assertion (-1)");
  await expect(row.getByText("Unavailable · Failed to acquire keep-awake assertion (-1)")).toBeVisible();
  await emit(page, { display: false, system: true, why: "sync-ab12 connected to Discord — the Mac won't idle-sleep", error: null, rev: 2 });
  await expect(row.getByText("Active · sync-ab12 connected to Discord — the Mac won't idle-sleep")).toBeVisible();
  await expect(row.getByText(/Unavailable/)).toHaveCount(0);
});

const emit = async (page: Page, payload: unknown) => {
  await page.waitForFunction(() => (window as typeof window & { __listeners: Array<[string, number]> }).__listeners.some(([name]) => name === "keep_awake"));
  await page.evaluate((p) => (window as typeof window & { __emit: (e: string, p: unknown) => void }).__emit("keep_awake", p), payload);
};

test("an older status answer never overwrites a newer event", async ({ page }) => {
  const row = await mock(page, "heavy run: vitest — the Mac won't idle-sleep", null, { holdStatus: true });
  await page.waitForFunction(() => typeof (window as typeof window & { __releaseStatus?: () => void }).__releaseStatus === "function");
  await emit(page, { display: false, system: true, why: "sync-ab12 connected to Discord — the Mac won't idle-sleep", error: null, rev: 5 });
  await page.evaluate(() => (window as typeof window & { __releaseStatus: () => void }).__releaseStatus());
  await expect(row.getByText("Active · sync-ab12 connected to Discord — the Mac won't idle-sleep")).toBeVisible();
  await expect(row.getByText(/heavy run: vitest/)).toHaveCount(0);
});

test("a display failure from the UI's own call goes once Rust says it holds again", async ({ page }) => {
  // The native call fails, as Rust's own record says, through the UI's retries.
  const row = await mock(page, null, "display refused", { failDisplay: true });
  await expect(row.getByText("Unavailable · display refused")).toBeVisible();
  await emit(page, { display: false, system: true, why: "heavy run: vitest — the Mac won't idle-sleep", error: null, rev: 9 });
  await expect(row.getByText("Active · heavy run: vitest — the Mac won't idle-sleep")).toBeVisible();
  // Held through the UI's next round of retries, not only between them.
  for (let i = 0; i < 20; i += 1) {
    expect(await row.textContent()).not.toContain("Unavailable");
    await page.waitForTimeout(200);
  }
});
