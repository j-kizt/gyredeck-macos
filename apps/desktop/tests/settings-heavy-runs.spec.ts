import { expect, test } from "@playwright/test";

/**
 * The Settings row for the machine's one heavy-run slot (#223): it shows who holds the
 * slot, what runs and who waits, and its one action stops the run holding the slot (#243) —
 * never anything that reorders the line.
 */

const HELD = {
  ok: true,
  v: 1,
  load: 6.2,
  loadLimit: 5,
  holder: { id: "a1a1a1a1a1a1a1a1", as: "claude-a", label: "Claude Code / Gyre Assistant", what: "pnpm test:demo --workers=3", state: "active", since: "2026-10-25T02:00:00Z", elapsedMs: 754_000, loadSkipped: true, helperGone: true },
  queue: [{ id: "c3c3c3c3c3c3c3c3", position: 1, as: "codex-b", label: "Codex / Gyredesk Audit", what: "cargo check", waitedMs: 42_000 }],
  observed: [{ pid: 48211, pattern: "cargo test|build|check", exe: "cargo", cwd: "/Users/demo/Workspace/altrix", label: "Terminal", elapsedMs: 185_000 }],
  waiting: 1,
  limit: "The queue is advisory. A command runs unqueued when the Gyredeck bridge cannot be reached or speaks another protocol version, even while Gyredeck is running, and a restart of Gyredeck resets the waiting line.",
};

test("the heavy-runs row shows the holder and the line, and stops the run it names after asking in the row", async ({ page }) => {
  await page.addInitScript((held) => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    let stopped = false;
    (window as typeof window & { __heavyCalls: typeof calls }).__heavyCalls = calls;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: unknown) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return stopped ? { ...held, holder: null, queue: [], waiting: 0, observed: [] } : held;
        if (command === "heavy_stop") {
          calls.push({ command, args });
          stopped = true;
          return "stopping";
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);

  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("tabpanel", { name: "Connection" })).toBeVisible();

  const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
  await expect(row).toContainText("Claude Code / Gyre Assistant · pnpm test:demo --workers=3 · 12 min · started under load");
  await expect(row).toContainText("Helper gone, command still running");
  await expect(row).toContainText("Waiting 1 · Codex / Gyredesk Audit · cargo check · 42s");
  await expect(row).toContainText("Runs outside the helper show as observed.");
  await expect(row).toContainText("Observed · Terminal · cargo test|build|check · cargo · pid 48211 · …/demo/Workspace/altrix · 3 min");

  // Asked in the row, where Stop is pressed: the macOS webview has no window.confirm, so a
  // native dialog here fails this test.
  page.on("dialog", () => { throw new Error("no native dialog may be used"); });
  await row.getByRole("button", { name: "Stop this run" }).click();
  await expect(row.getByRole("alert")).toHaveText("Stop pnpm test:demo --workers=3 of Claude Code / Gyre Assistant? Its command will be ended.");
  await row.getByRole("button", { name: "Cancel" }).click();
  await expect(row.getByRole("alert")).toHaveCount(0);
  await row.getByRole("button", { name: "Stop this run" }).click();
  await row.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(row.locator(".setup-detail").first()).toHaveText("Free");
  await expect(row.getByRole("button", { name: "Stop this run" })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as typeof window & { __heavyCalls: Array<{ command: string; args?: { holderId?: string } }> }).__heavyCalls);
  expect(calls).toEqual([{ command: "heavy_stop", args: { holderId: "a1a1a1a1a1a1a1a1" } }]);
});

test("a run that took the slot while Stop was being confirmed is not the one stopped (#243)", async ({ page }) => {
  await page.addInitScript((held) => {
    const calls: string[] = [];
    let holder = held.holder;
    (window as typeof window & { __heavyCalls: string[]; __swap: () => void }).__heavyCalls = calls;
    (window as typeof window & { __swap: () => void }).__swap = () => {
      holder = { ...held.holder, id: "b2b2b2b2b2b2b2b2", as: "codex-b", label: "Codex / Gyredesk Audit", what: "cargo check" };
    };
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return { ...held, holder };
        if (command === "heavy_stop") { calls.push(command); return "stopping"; }
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);
  await page.clock.install();
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
  await row.getByRole("button", { name: "Stop this run" }).click();
  await expect(row.getByRole("alert")).toContainText("Claude Code / Gyre Assistant");
  // A finishes and B takes the slot; the next poll shows B.
  await page.evaluate(() => (window as typeof window & { __swap: () => void }).__swap());
  await page.clock.runFor(6_000);
  await expect(row).toContainText("Codex / Gyredesk Audit · cargo check");
  await expect(row.getByRole("alert")).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as typeof window & { __heavyCalls: string[] }).__heavyCalls);
  expect(calls).toEqual([]);
});

test("the heavy-runs row says the slot is free when nothing holds it", async ({ page }) => {
  await page.addInitScript((held) => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return { ...held, holder: null, queue: [], waiting: 0, observed: [] };
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);

  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
  await expect(row.locator(".setup-detail").first()).toHaveText("Free");
  await expect(row.getByRole("button", { name: "Release stuck slot" })).toHaveCount(0);
});

test("a run recorded before this version shows how to stop it, and no Stop button (#243)", async ({ page }) => {
  await page.addInitScript((held) => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return { ...held, holder: { ...held.holder, verified: false } };
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);

  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
  await expect(row).toContainText("Started before this version — stop it from its terminal.");
  await expect(row.getByRole("button", { name: "Stop this run" })).toHaveCount(0);
});

test.describe("at the app's own window width", () => {
  test.use({ viewport: { width: 444, height: 560 } });

  test("a held slot's row stays inside its card and below its heading (#243)", async ({ page }) => {
    await page.addInitScript((held) => {
      (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: async (command: string) => {
          if (command === "set_keep_awake") return false;
          if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
          if (command === "heavy_status") return held;
          throw new Error(`${command} unavailable`);
        },
      };
    }, HELD);
    await page.goto("/?demo=1");
    await page.getByRole("button", { name: "Settings" }).click();
    const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
    await expect(row).toContainText("Claude Code / Gyre Assistant");
    await row.scrollIntoViewIfNeeded();
    const rowBox = await row.boundingBox();
    const copyBox = await row.locator(".setup-copy").boundingBox();
    const headBox = await page.locator(".setup-subheading", { hasText: "Heavy runs" }).boundingBox();
    if (!rowBox || !copyBox || !headBox) throw new Error("row, copy or heading not laid out");
    expect(copyBox.y).toBeGreaterThanOrEqual(rowBox.y);
    expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 0.5);
    expect(rowBox.y).toBeGreaterThanOrEqual(headBox.y + headBox.height);
  });
});

test("an observed run shows what matched and who started it, holds the slot, and has no Stop (#245)", async ({ page }) => {
  await page.addInitScript((held) => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") {
          return {
            ...held,
            holder: null,
            observed: [
              { pid: 48211, pattern: "cargo test|build|check", exe: "cargo", cwd: "/Users/demo/Workspace/altrix", label: "Terminal", elapsedMs: 185_000 },
              { pid: 48300, pattern: "pnpm test:*", exe: "pnpm", cwd: null, label: "Codex / Gyredesk Audit", elapsedMs: 9_000 },
            ],
          };
        }
        if (command === "heavy_patterns") return { defaults: ["pnpm test:*"], custom: [] };
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  const row = page.locator(".setup-row").filter({ hasText: "Heavy-run slot" });
  // Premise: the observed runs are on screen, so "no Stop" is said of a row that shows them.
  await expect(row.locator("[data-heavy-observed]")).toHaveCount(2);
  await expect(row.locator("[data-heavy-observed='48300']")).toHaveText("Observed · Codex / Gyredesk Audit · pnpm test:* · pnpm · pid 48300 · 9s");
  await expect(row.locator(".setup-detail").first()).toHaveText("Held by a run outside the helper");
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("the heavy commands list adds and removes the person's own patterns, and shows a refusal (#245)", async ({ page }) => {
  await page.addInitScript((held) => {
    const saved: string[][] = [];
    let custom: string[] = ["make check"];
    (window as typeof window & { __saved: string[][] }).__saved = saved;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: { patterns?: string[] }) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return { ...held, holder: null, queue: [], observed: [] };
        if (command === "heavy_patterns") return { defaults: ["pnpm test:*", "cargo test|build|check"], custom };
        if (command === "set_heavy_patterns") {
          const next = args?.patterns ?? [];
          saved.push(next);
          if (next.includes("*")) throw new Error("Every word of a pattern says something besides *");
          custom = next;
          return { defaults: ["pnpm test:*", "cargo test|build|check"], custom };
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  const row = page.locator("[data-heavy-patterns]");
  await expect(row).toContainText("pnpm test:* · cargo test|build|check");
  await expect(row.locator("[data-heavy-pattern]")).toHaveText(["make check"]);

  await row.getByRole("textbox", { name: "Heavy command pattern" }).fill("node scripts/full-check.mjs");
  await row.getByRole("button", { name: "Add" }).click();
  await expect(row.locator("[data-heavy-pattern]")).toHaveText(["make check", "node scripts/full-check.mjs"]);
  await expect(row.getByRole("textbox", { name: "Heavy command pattern" })).toHaveValue("");

  await row.getByRole("button", { name: "Remove make check" }).click();
  await expect(row.locator("[data-heavy-pattern]")).toHaveText(["node scripts/full-check.mjs"]);

  await row.getByRole("textbox", { name: "Heavy command pattern" }).fill("*");
  await row.getByRole("button", { name: "Add" }).click();
  await expect(row).toContainText("Every word of a pattern says something besides *");
  await expect(row.getByRole("textbox", { name: "Heavy command pattern" })).toHaveValue("*");
  const saved = await page.evaluate(() => (window as typeof window & { __saved: string[][] }).__saved);
  expect(saved).toEqual([["make check", "node scripts/full-check.mjs"], ["node scripts/full-check.mjs"], ["node scripts/full-check.mjs", "*"]]);
});
