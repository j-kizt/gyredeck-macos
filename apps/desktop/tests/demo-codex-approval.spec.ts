import { expect, test, type Page } from "@playwright/test";

/**
 * The Codex hooks row, against a Codex that answers the approval question on a delay.
 *
 * What these pin is timing, which is where the false green lived: between pressing
 * Install and Codex answering, and between the person approving something in Codex and
 * coming back to this window. Neither is visible from the rule alone.
 */
type Trust = "approved" | "untrusted" | "modified" | "disabled" | "unknown";

const withCodex = async (page: Page, { installed = true, answers }: { installed?: boolean; answers: Trust[] }) => {
  await page.addInitScript(([startInstalled, queue]) => {
    const state = { installed: startInstalled as boolean, calls: 0 };
    (window as typeof window & { __trust: typeof state }).__trust = state;
    const path = "/Users/demo/.config/gyredeck/gyredeck-codex-hook.mjs";
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command === "codex_hook_status") return [path, state.installed, state.installed ? false : null];
        if (command.endsWith("_hook_status") || command === "codex_notify_status") return [path, true, false];
        if (command === "install_codex_hook") { state.installed = true; return path; }
        if (command === "codex_hook_trust") {
          const answer = (queue as string[])[Math.min(state.calls, (queue as string[]).length - 1)];
          state.calls += 1;
          // Slow enough that the moment between asking and answering can be looked at.
          await new Promise((resolve) => setTimeout(resolve, 700));
          return { ok: true, state: answer, hooks: [] };
        }
        return null;
      },
    };
  }, [installed, answers] as const);
};

const openPlugins = async (page: Page) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Plugins" }).click();
  return page.locator(".setup-row").filter({ hasText: "Codex hooks" });
};
const calls = (page: Page) => page.evaluate(() => (window as typeof window & { __trust: { calls: number } }).__trust.calls);

test("no checkmark while Codex is being asked, then the step to take", async ({ page }) => {
  await withCodex(page, { answers: ["untrusted"] });
  const row = await openPlugins(page);

  // The false green this work removes: installed and current, checkmark drawn, while the
  // question had not yet reached Codex.
  await expect(row.getByText("checking approval in Codex")).toBeVisible();
  await expect(row.locator(".setup-installed")).toHaveCount(0);

  await expect(row.getByText("waiting for approval in Codex")).toBeVisible();
  await expect(row.getByText("type /hooks")).toBeVisible();
  // Reinstalling an unapproved hook leaves it unapproved, so that is not what is offered.
  await expect(row.getByRole("button", { name: "Recheck" })).toBeVisible();
  await expect(row.getByRole("button", { name: /Reinstall/ })).toHaveCount(0);
});

test("installing does not finish on a checkmark Codex never gave", async ({ page }) => {
  await withCodex(page, { installed: false, answers: ["untrusted"] });
  const row = await openPlugins(page);
  await expect(row.getByText("Not installed")).toBeVisible();
  // Nothing of ours is installed, so Codex is not asked: that would start an app-server
  // on every visit to Settings, to be told nothing of ours exists. It also means nothing
  // is already in flight to paper over what Install does next.
  expect(await calls(page)).toBe(0);
  await row.getByRole("button", { name: "Install" }).click();

  // The moment a new person is looking at this row. It used to be set to installed and
  // current by hand, which drew the checkmark before Codex had been asked anything.
  await expect(row.locator(".setup-installed")).toHaveCount(0);
  await expect(row.getByText("waiting for approval in Codex")).toBeVisible();
  await expect(row.locator(".setup-installed")).toHaveCount(0);

  // And the notice says the same thing. "Restart Codex" here would send the person past
  // the step that makes the hook run, with the row and the notice disagreeing.
  await page.getByRole("tab", { name: "Connection" }).click();
  await expect(page.getByText(/Installed → .* · approve it in Codex: type \/hooks/)).toBeVisible();
  await expect(page.getByText(/restart Codex/)).toHaveCount(0);
});

test("coming back to the window asks again, even after an approval", async ({ page }) => {
  // Approval can be taken away in Codex as easily as given. A green read before the person
  // went and switched a hook off must not survive them coming back.
  await withCodex(page, { answers: ["approved", "disabled"] });
  const row = await openPlugins(page);
  await expect(row.locator(".setup-installed")).toBeVisible();
  const before = await calls(page);

  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(row.getByText("turned off in Codex")).toBeVisible();
  await expect(row.locator(".setup-installed")).toHaveCount(0);
  expect(await calls(page)).toBe(before + 1);
});

test("an approval that could not be checked offers Recheck and lights no danger dot", async ({ page }) => {
  await withCodex(page, { answers: ["unknown", "approved"] });
  const row = await openPlugins(page);
  await expect(row.getByText("could not check approval in Codex")).toBeVisible();
  await expect(row.locator(".setup-installed")).toHaveCount(0);

  await row.getByRole("button", { name: "Recheck" }).click();
  await expect(row.locator(".setup-installed")).toBeVisible();
});
