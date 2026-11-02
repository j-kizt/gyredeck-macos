import { expect, test, type Page } from "@playwright/test";

// #211, #278: Rust says what holds the Mac awake, and the row says it — with no agent working.
const mock = async (page: Page, why: string | null, error: string | null = null) => {
  await page.addInitScript(([reason, failure]) => {
    window.localStorage.setItem("gyredeck.keep-awake-while-working", "true");
    const callbacks = new Map<number, (payload: unknown) => void>();
    let next = 0;
    const w = window as typeof window & { __TAURI_INTERNALS__: unknown; __emit: (event: string, payload: unknown) => void };
    const listeners: Array<[string, number]> = [];
    w.__emit = (event, payload) => { for (const [name, id] of listeners) if (name === event) callbacks.get(id)?.({ event, id: 0, payload }); };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (payload: unknown) => void) => { next += 1; callbacks.set(next, callback); return next; },
      invoke: async (command: string, args?: { event?: string; handler?: number }) => {
        if (command === "plugin:event|listen") { listeners.push([String(args?.event), Number(args?.handler)]); return listeners.length; }
        if (command === "set_keep_awake") return false;
        if (command === "keep_awake_status") return { display: false, system: false, why: reason, error: failure };
        if (command === "mail_rooms") return [];
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        throw new Error(`${command} unavailable`);
      },
    };
  }, [why, error] as const);
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
  await expect(row.getByText("On · while an agent works, a room is on Discord, or a heavy run is live")).toBeVisible();
});

test("a refusal from a background input is shown, and goes once Rust holds it after all", async ({ page }) => {
  const row = await mock(page, null, "Failed to acquire keep-awake assertion (-1)");
  await expect(row.getByText("Unavailable · Failed to acquire keep-awake assertion (-1)")).toBeVisible();
  await page.evaluate(() => (window as typeof window & { __emit: (e: string, p: unknown) => void }).__emit("keep_awake", { display: false, system: true, why: "sync-ab12 connected to Discord — the Mac won't idle-sleep", error: null }));
  await expect(row.getByText("Active · sync-ab12 connected to Discord — the Mac won't idle-sleep")).toBeVisible();
  await expect(row.getByText(/Unavailable/)).toHaveCount(0);
});
