import { expect, test } from "@playwright/test";

/**
 * The machine's one heavy-run slot (#223), folded into the Heavy commands card under Settings →
 * Sync (#376): it shows the run holding the slot, what runs outside the helper and who waits,
 * and its one action kills the run holding the slot (#243) — never anything that reorders the line.
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

type Page = import("@playwright/test").Page;

const mock = (page: Page, status: (held: typeof HELD) => unknown) =>
  page.addInitScript(([held, source]) => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    const make = new Function("held", `return (${source})(held)`) as (h: unknown) => unknown;
    (window as typeof window & { __heavyCalls: typeof calls }).__heavyCalls = calls;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: unknown) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return make(held);
        if (command === "heavy_patterns") return { defaults: ["pnpm test:*"], custom: [] };
        throw new Error(`${command} unavailable`);
      },
    };
  }, [HELD, status.toString()] as const);

const openSync = async (page: Page) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Sync" }).click();
  await expect(page.getByRole("tabpanel", { name: "Sync" })).toBeVisible();
  return page.locator("[data-heavy-patterns]");
};

test("the Heavy commands card shows the run holding the slot and the line, and kills the run it names after asking in the row", async ({ page }) => {
  await page.addInitScript((held) => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    let stopped = false;
    (window as typeof window & { __heavyCalls: typeof calls }).__heavyCalls = calls;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: unknown) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return stopped ? { ...held, holder: null, queue: [], waiting: 0, observed: [] } : held;
        if (command === "heavy_patterns") return { defaults: ["pnpm test:*"], custom: [] };
        if (command === "heavy_stop") {
          calls.push({ command, args });
          stopped = true;
          return "stopping";
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);

  const card = await openSync(page);
  // One card, no separate slot row (#376).
  await expect(page.locator(".setup-row").filter({ hasText: "Heavy-run slot" })).toHaveCount(0);
  const run = card.locator("[data-heavy-run='holder']");
  // Two lines: the command, then the session's own name (no "Provider / ") and the age.
  await expect(run.locator(".setup-run-what")).toHaveText("pnpm test:demo --workers=3");
  await expect(run).toContainText("Gyre Assistant · 12 min · started under load");
  await expect(run).not.toContainText("Claude Code /");
  await expect(run).toContainText("Helper gone, command still running");
  await expect(card.locator("[data-heavy-queued] .setup-detail")).toHaveText(["1 · cargo check · Gyredesk Audit"]);
  await expect(card).not.toContainText("waiting");
  await expect(card.locator("[data-heavy-observed='48211']")).toHaveText("cargo test|build|checkTerminal · 3 min · outside the queue");

  // Asked in the row, where Kill is pressed: the macOS webview has no window.confirm, so a
  // native dialog here fails this test. The row stays; only its buttons change.
  page.on("dialog", () => { throw new Error("no native dialog may be used"); });
  await run.getByRole("button", { name: "Kill pnpm test:demo --workers=3", exact: true }).click();
  await expect(run.getByRole("button")).toHaveText(["Cancel", "Kill"]);
  await expect(run.locator(".setup-run-what")).toHaveText("pnpm test:demo --workers=3");
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(card).not.toContainText("Stop");
  await run.getByRole("button", { name: "Cancel" }).click();
  await expect(run.getByRole("button")).toHaveText(["Kill"]);
  await run.getByRole("button", { name: "Kill pnpm test:demo --workers=3", exact: true }).click();
  await run.getByRole("button", { name: "Kill pnpm test:demo --workers=3 now" }).click();
  // Idle: the card says nothing about the slot — no "Free" line.
  await expect(card.locator(".setup-runs")).toHaveCount(0);
  await expect(card).not.toContainText("Free");
  const calls = await page.evaluate(() => (window as typeof window & { __heavyCalls: Array<{ command: string; args?: { holderId?: string } }> }).__heavyCalls);
  expect(calls).toEqual([{ command: "heavy_stop", args: { holderId: "a1a1a1a1a1a1a1a1" } }]);
});

test("Remove takes the waiting run it names out of the line, and never the run holding the slot (#376)", async ({ page }) => {
  await page.addInitScript((held) => {
    const calls: Array<{ command: string; args?: unknown }> = [];
    let queue = [...held.queue, { position: 2, as: "old-b", label: "Codex / Old", what: "cargo build", waitedMs: 1_000 }];
    (window as typeof window & { __heavyCalls: typeof calls }).__heavyCalls = calls;
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: unknown) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return { ...held, queue };
        if (command === "heavy_patterns") return { defaults: ["pnpm test:*"], custom: [] };
        if (command === "heavy_remove" || command === "heavy_stop") {
          calls.push({ command, args });
          queue = queue.filter((entry) => entry.id !== (args as { entryId?: string }).entryId).map((entry, index) => ({ ...entry, position: index + 1 }));
          return null;
        }
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);
  const card = await openSync(page);
  const waiting = card.locator("[data-heavy-queued='1']");
  // An entry from an older bridge has no id to name, so it offers no Remove.
  await expect(card.locator("[data-heavy-queued='2']").getByRole("button")).toHaveCount(0);
  await waiting.getByRole("button", { name: "Remove cargo check from the queue" }).click();
  await expect(card.locator("[data-heavy-queued] .setup-detail")).toHaveText(["1 · cargo build · Old"]);
  await expect(card.locator("[data-heavy-run='holder'] .setup-run-what")).toHaveText("pnpm test:demo --workers=3");
  const calls = await page.evaluate(() => (window as typeof window & { __heavyCalls: unknown[] }).__heavyCalls);
  expect(calls).toEqual([{ command: "heavy_remove", args: { entryId: "c3c3c3c3c3c3c3c3" } }]);
});

test("a refused Remove or Kill stays said while the status keeps reading, until the next one is pressed (#376 audit)", async ({ page }) => {
  await page.addInitScript((held) => {
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "heavy_status") return held;
        if (command === "heavy_patterns") return { defaults: ["pnpm test:*"], custom: [] };
        if (command === "heavy_remove") throw new Error("That run is no longer waiting; nothing was removed");
        if (command === "heavy_stop") throw new Error("Could not check that run just now, so nothing was stopped. Try again");
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);
  await page.clock.install();
  const card = await openSync(page);
  await card.locator("[data-heavy-queued='1']").getByRole("button", { name: "Remove cargo check from the queue" }).click();
  await expect(card.getByRole("alert")).toHaveText("That run is no longer waiting; nothing was removed");
  // Two polls that succeed: the refusal is still there.
  await page.clock.runFor(11_000);
  await expect(card.getByRole("alert")).toHaveText("That run is no longer waiting; nothing was removed");
  const run = card.locator("[data-heavy-run='holder']");
  await run.getByRole("button", { name: "Kill pnpm test:demo --workers=3", exact: true }).click();
  await run.getByRole("button", { name: "Kill pnpm test:demo --workers=3 now" }).click();
  await expect(card.getByRole("alert")).toHaveText("Could not check that run just now, so nothing was stopped. Try again");
  await page.clock.runFor(6_000);
  await expect(card.getByRole("alert")).toHaveText("Could not check that run just now, so nothing was stopped. Try again");
});

test("a run that took the slot while Kill was being confirmed is not the one killed (#243)", async ({ page }) => {
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
        if (command === "heavy_patterns") return { defaults: ["pnpm test:*"], custom: [] };
        if (command === "heavy_stop") { calls.push(command); return "stopping"; }
        throw new Error(`${command} unavailable`);
      },
    };
  }, HELD);
  await page.clock.install();
  const card = await openSync(page);
  const run = card.locator("[data-heavy-run='holder']");
  await run.getByRole("button", { name: "Kill pnpm test:demo --workers=3", exact: true }).click();
  await expect(run.getByRole("button")).toHaveText(["Cancel", "Kill"]);
  // A finishes and B takes the slot; the next poll shows B.
  await page.evaluate(() => (window as typeof window & { __swap: () => void }).__swap());
  await page.clock.runFor(6_000);
  await expect(run).toContainText("Gyredesk Audit · 12 min");
  await expect(run.locator(".setup-run-what")).toHaveText("cargo check");
  await expect(run.getByRole("button")).toHaveText(["Kill"]);
  await expect(run.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as typeof window & { __heavyCalls: string[] }).__heavyCalls);
  expect(calls).toEqual([]);
});

test("the card says nothing about the slot when nothing holds it", async ({ page }) => {
  await mock(page, (held) => ({ ...held, holder: null, queue: [], waiting: 0, observed: [] }));
  const card = await openSync(page);
  await expect(card).toContainText("pnpm test:*");
  await expect(card.locator(".setup-runs")).toHaveCount(0);
  await expect(card).not.toContainText("Free");
  await expect(card.getByRole("button", { name: /^Kill/ })).toHaveCount(0);
});

test("a run recorded before this version shows how to stop it, and no Kill button (#243)", async ({ page }) => {
  await mock(page, (held) => ({ ...held, holder: { ...held.holder, verified: false } }));
  const card = await openSync(page);
  const run = card.locator("[data-heavy-run='holder']");
  await expect(run).toContainText("Started before this version — stop it from its terminal.");
  await expect(run.getByRole("button")).toHaveCount(0);
});

test.describe("at the app's own window width", () => {
  test.use({ viewport: { width: 444, height: 560 } });

  test("a held slot's lines stay inside the Heavy commands card and below its heading (#243)", async ({ page }) => {
    await mock(page, (held) => held);
    const card = await openSync(page);
    const runs = card.locator(".setup-runs");
    await expect(runs).toContainText("Gyre Assistant");
    await runs.scrollIntoViewIfNeeded();
    const cardBox = await card.boundingBox();
    const runsBox = await runs.boundingBox();
    const headBox = await page.locator(".setup-subheading", { hasText: "Heavy runs" }).boundingBox();
    if (!cardBox || !runsBox || !headBox) throw new Error("card, runs or heading not laid out");
    expect(runsBox.y).toBeGreaterThanOrEqual(cardBox.y);
    expect(runsBox.y + runsBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
    expect(runsBox.x + runsBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
    expect(cardBox.y).toBeGreaterThanOrEqual(headBox.y + headBox.height);
  });
});

test("an observed run shows what matched and who started it, and has no Kill (#245)", async ({ page }) => {
  await mock(page, (held) => ({
    ...held,
    holder: null,
    queue: [],
    observed: [
      { pid: 48211, pattern: "cargo test|build|check", exe: "cargo", cwd: "/Users/demo/Workspace/altrix", label: "Terminal", elapsedMs: 185_000 },
      { pid: 48300, pattern: "pnpm test:*", exe: "pnpm", cwd: null, label: "Codex / Gyredesk Audit", elapsedMs: 9_000 },
    ],
  }));
  const card = await openSync(page);
  // Premise: the observed runs are on screen, so "no Kill" is said of a card that shows them.
  await expect(card.locator("[data-heavy-observed]")).toHaveCount(2);
  await expect(card.locator("[data-heavy-observed='48300'] .setup-run-what")).toHaveText("pnpm test:*");
  await expect(card.locator("[data-heavy-observed='48300']")).toContainText("Codex / Gyredesk Audit · 9s · outside the queue");
  await expect(card.locator("[data-heavy-observed='48211']")).toHaveAttribute("title", "/Users/demo/Workspace/altrix");
  await expect(card.locator(".setup-runs").getByRole("button")).toHaveCount(0);
});

test("the heavy commands list adds and removes the person's own patterns behind + Add, and shows a refusal (#245, #376)", async ({ page }) => {
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
  const row = await openSync(page);
  const toggle = row.getByRole("button", { name: "Add a heavy command" });
  const field = row.getByRole("textbox", { name: "Heavy command pattern" });
  await expect(row).toContainText("pnpm test:* · cargo test|build|check");
  await expect(row.locator("[data-heavy-pattern]")).toHaveText(["make check"]);
  // Closed: the patterns are listed, but no field and no Remove.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveText("Add");
  await expect(field).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Remove make check" })).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(field).toBeFocused();
  await field.fill("node scripts/full-check.mjs");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.locator("[data-heavy-pattern]")).toHaveText(["make check", "node scripts/full-check.mjs"]);
  // A save that took closes the editor.
  await expect(field).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await row.getByRole("button", { name: "Remove make check" }).click();
  await expect(row.locator("[data-heavy-pattern]")).toHaveText(["node scripts/full-check.mjs"]);

  await field.fill("*");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Every word of a pattern says something besides *");
  await expect(field).toHaveValue("*");

  // Opening again starts clean: the refusal and the half-typed pattern are not this attempt's.
  await toggle.click();
  await toggle.click();
  await expect(field).toHaveValue("");
  await expect(row).not.toContainText("Every word of a pattern says something besides *");
  const saved = await page.evaluate(() => (window as typeof window & { __saved: string[][] }).__saved);
  expect(saved).toEqual([["make check", "node scripts/full-check.mjs"], ["node scripts/full-check.mjs"], ["node scripts/full-check.mjs", "*"]]);
});

test("every Settings text field reads as a text field: left-aligned, regular weight, never centred (#376)", async ({ page }) => {
  await mock(page, (held) => held);
  const card = await openSync(page);
  await card.getByRole("button", { name: "Add a heavy command" }).click();
  await expect(page.locator(".setup-input")).toHaveCount(1);
  const looks = async () => page.locator(".setup-input").evaluateAll((els) => els.map((el) => {
    const style = getComputedStyle(el);
    return { align: style.textAlign, weight: style.fontWeight };
  }));
  const sync = await looks();
  await page.getByRole("tab", { name: "Connection" }).click();
  await page.getByRole("button", { name: "Edit bridge port" }).click();
  await expect(page.locator(".setup-input")).toHaveCount(1);
  for (const look of [...sync, ...(await looks())]) {
    expect(["left", "start"]).toContain(look.align);
    expect(look.weight).toBe("400");
  }
});
