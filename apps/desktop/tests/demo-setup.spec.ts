import { expect, test } from "@playwright/test";

test("keep awake follows any working session instead of ambient attention priority", async ({ page }) => {
  await page.goto("/?demo=1&demoScenario=idle");
  const result = await page.evaluate(async () => {
    const { shouldKeepDisplayAwakeForActivity } = await import("/src/features/session/selectors.ts");
    return {
      attentionAndWorking: shouldKeepDisplayAwakeForActivity(
        [{ status: "attention" }, { status: "working" }],
        "attention",
      ),
      attentionOnly: shouldKeepDisplayAwakeForActivity([{ status: "attention" }], "attention"),
      fallbackWorking: shouldKeepDisplayAwakeForActivity([], "working"),
      completedOnly: shouldKeepDisplayAwakeForActivity([{ status: "done" }], "done"),
    };
  });

  expect(result).toEqual({
    attentionAndWorking: true,
    attentionOnly: false,
    fallbackWorking: true,
    completedOnly: false,
  });
});

test("keep awake retries a transient native synchronization failure", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("gyredeck.keep-awake-while-working", "true");
    const calls: Array<{ active: boolean }> = [];
    let activeAttempts = 0;
    (window as typeof window & { __keepAwakeCalls: Array<{ active: boolean }> }).__keepAwakeCalls = calls;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: { active?: boolean }) => {
        if (command !== "set_keep_awake") return null;
        const active = args?.active === true;
        calls.push({ active });
        if (active) {
          activeAttempts += 1;
          if (activeAttempts === 1) throw new Error("transient IOKit failure");
        }
        return active;
      },
    };
  });

  await page.goto("/?demo=1&demoScenario=long-llm");
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __keepAwakeCalls: Array<{ active: boolean }> }
  ).__keepAwakeCalls)).toEqual([{ active: false }, { active: true }, { active: true }]);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Display" }).click();
  await expect(
    page.locator(".setup-row").filter({ hasText: "Keep awake while working" }),
  ).toContainText("Active · agent working");
});

test("setup view stays capability-aware in browser demo", async ({ page }) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();

  // Connection: bridge status and native guidance are demo-aware.
  await expect(page.getByRole("tabpanel", { name: "Connection" })).toBeVisible();
  await expect(page.getByText("Bridge", { exact: true })).toBeVisible();
  await expect(page.getByText("Demo mode")).toBeVisible();
  await expect(page.getByText("Open desktop runtime")).toBeVisible();
  await expect(page.getByText("Browser demo cannot install or check hooks")).toBeVisible();

  // Plugins: both agent hook rows fall back to "Tauri runtime needed" in the browser demo.
  await page.getByRole("tab", { name: "Plugins" }).click();
  const claudeRow = page.locator(".setup-row").filter({ hasText: "Claude Code hooks" });
  const agyRow = page.locator(".setup-row").filter({ hasText: "Antigravity hooks" });
  await expect(claudeRow.getByText("Tauri runtime needed")).toBeVisible();
  await expect(agyRow.getByText("Tauri runtime needed")).toBeVisible();
  await expect(claudeRow.getByRole("button", { name: "Install" })).toBeVisible();
  await expect(agyRow.getByRole("button", { name: "Install" })).toBeVisible();
  // Attempting a native install in the browser demo records the runtime hint, which
  // surfaces on the Connection panel.
  await claudeRow.getByRole("button", { name: "Install" }).click();
  await page.getByRole("tab", { name: "Connection" }).click();
  await expect(page.getByText("Open with pnpm desktop:dev")).toBeVisible();
  await page.getByRole("tab", { name: "Plugins" }).click();

  // Display: keep-awake needs the native runtime in the browser demo.
  await page.getByRole("tab", { name: "Display" }).click();
  const keepAwakeRow = page.locator(".setup-row").filter({ hasText: "Keep awake while working" });
  await expect(keepAwakeRow.getByText("Off · display follows macOS idle settings")).toBeVisible();
  // The control is a switch, and with no native runtime behind it the demo
  // disables it outright rather than letting it flip and quietly do nothing.
  await expect(keepAwakeRow.getByRole("switch", { name: "Enable keep display awake" })).toBeDisabled();
});

test("keep awake already enabled reports the missing runtime in browser demo", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("gyredeck.keep-awake-while-working", "true");
  });
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Display" }).click();

  const keepAwakeRow = page.locator(".setup-row").filter({ hasText: "Keep awake while working" });
  await expect(keepAwakeRow.getByText("Desktop runtime required")).toBeVisible();
  await expect(keepAwakeRow.getByRole("switch", { name: "Disable keep display awake" })).toBeDisabled();
});
