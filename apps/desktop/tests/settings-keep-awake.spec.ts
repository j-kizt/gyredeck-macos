import { expect, test, type Page } from "@playwright/test";

// #211, #278: Rust says what holds the Mac awake, and the row says it — with no agent working.
const mock = async (page: Page, why: string | null) => {
  await page.addInitScript((reason) => {
    window.localStorage.setItem("gyredeck.keep-awake-while-working", "true");
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "keep_awake_status") return { display: false, system: reason !== null, why: reason, error: null };
        if (command === "mail_rooms") return [];
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        throw new Error(`${command} unavailable`);
      },
    };
  }, why);
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
