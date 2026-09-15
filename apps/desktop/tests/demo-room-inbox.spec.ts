import { expect, test } from "@playwright/test";

/**
 * Messages belong to a room, and leaving one ends them. Everything here is about the
 * moment that decision is made rather than the rule itself, which is covered by
 * tests/room-inbox.test.mjs — the fault these exist for was a lifetime, not a rule:
 * `canAct` is true from the first render, so a guard on it read the not-yet-loaded
 * `room: null` as "in no room" and deleted the inbox of every session on opening it.
 */

const INBOX = {
  demo: {
    room: "sync-4f2a",
    readAt: null,
    messages: [
      {
        seq: 1,
        room: "sync-4f2a",
        from: "peer",
        fromLabel: "Codex",
        kind: "ask",
        preview: "kept across the wait",
        at: "2026-09-15T10:00:00Z",
      },
    ],
  },
};

/** Stub the native side with a sync_room that answers only after `delayMs`. */
const harness = (room: { room: string | null; members: unknown[] }, delayMs: number) => `
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "set_keep_awake") return false;
      if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
      if (command === "sync_room") {
        await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
        return ${JSON.stringify(room)};
      }
      throw new Error(command + " unavailable");
    },
  };
`;

/**
 * Seed the inbox against the id the demo actually uses, then open that session.
 *
 * Read from the DOM rather than written down: a seed under a key nothing touches makes
 * every assertion about "the messages survived" pass for the wrong reason, which is how
 * the first version of this file passed against the very bug it was written for.
 */
const seedAndOpen = async (page: import("@playwright/test").Page) => {
  await page.goto("/?demo=1&demoScenario=long-llm");
  const row = page.locator(".session-row-main").first();
  await row.waitFor();
  const conversationId = await row.getAttribute("data-session-id");
  expect(conversationId).toBeTruthy();

  await page.evaluate(([id, inbox]) => {
    window.localStorage.setItem("gyredeck.room-inbox", JSON.stringify({ [id as string]: inbox }));
  }, [conversationId, INBOX.demo] as const);

  await page.reload();
  await page.locator(".session-row-main").first().click();
  return conversationId as string;
};

test("a slow room reading does not delete the messages it has not read yet", async ({ page }) => {
  // The regression: the inbox was cleared in the same commit the panel mounted, long
  // before the room came back, so opening a session destroyed what it was opened to read.
  await page.addInitScript(harness({ room: "sync-4f2a", members: [] }, 1_200));
  await seedAndOpen(page);

  const held = async () =>
    await page.evaluate(() => {
      const raw = window.localStorage.getItem("gyredeck.room-inbox");
      const parsed = raw ? JSON.parse(raw) : {};
      return Object.values(parsed).flatMap((inbox: { messages?: unknown[] }) => inbox.messages ?? []).length;
    });

  expect(await held()).toBe(1);
  await expect(page.getByRole("tab", { name: "Messages" })).toBeVisible();
  expect(await held()).toBe(1);
});

test("the Messages tab stays away until a room has actually been read", async ({ page }) => {
  // Not merely absent at the end: absent throughout, because appearing and vanishing is
  // how a person learns to distrust it.
  await page.addInitScript(harness({ room: null, members: [] }, 800));
  await seedAndOpen(page);

  await expect(page.getByRole("tab", { name: "Recent activity" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Messages" })).toHaveCount(0);
  await page.waitForTimeout(1_200);
  await expect(page.getByRole("tab", { name: "Messages" })).toHaveCount(0);
});

test("a session in no room loses the messages of the room it left", async ({ page }) => {
  // The other half of the same rule: once the reading says there is no room, what was
  // said in the last one is over rather than waiting under the session as unread.
  await page.addInitScript(harness({ room: null, members: [] }, 100));
  await seedAndOpen(page);

  await expect
    .poll(async () =>
      await page.evaluate(() => {
        const raw = window.localStorage.getItem("gyredeck.room-inbox");
        return Object.keys(raw ? JSON.parse(raw) : {}).length;
      }),
    )
    .toBe(0);
});

test("a late answer for one session does not describe the next one", async ({ page }) => {
  // `loadedFor` shields the inbox and the tab, but the panel renders `sync.room` raw —
  // so A's answer arriving after B is open shows A's room code on B, and the Disconnect
  // beside it would act on A's code with B's conversation.
  //
  // Deferred rather than timed: resolving A by hand after B has answered is the only way
  // to state the ordering instead of hoping for it. An earlier version of this test used
  // sleeps and passed against the bug it was written for.
  await page.addInitScript(() => {
    const state = window as unknown as { __releaseA?: () => void };
    window.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: Record<string, string>) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "sync_room") {
          if (args?.conversationId === "local-conv-demo-active") {
            await new Promise<void>((resolve) => { state.__releaseA = resolve; });
            return { room: "sync-aaaa", members: [] };
          }
          return { room: null, members: [] };
        }
        throw new Error(command + " unavailable");
      },
    };
  });

  await page.goto("/?demo=1&demoScenario=multi");
  await page.locator('[data-session-id="local-conv-demo-active"]').first().click();
  // A's request must exist before the selection moves, or there is no late answer at all.
  await expect.poll(async () =>
    await page.evaluate(() => typeof (window as unknown as { __releaseA?: () => void }).__releaseA === "function"),
  ).toBe(true);

  await page.getByRole("button", { name: /Back to all \d+ sessions?/i }).click();
  await page.locator('[data-session-id="local-conv-demo-paoplew"]').first().click();
  await expect(page.locator(".session-sync-code")).toHaveCount(0);

  // Watched rather than sampled. A leak here is corrected by the next poll a few seconds
  // later, so "is it there now" answers no whether or not it ever appeared.
  await page.evaluate(() => {
    const seen = window as unknown as { __leaked?: boolean };
    seen.__leaked = false;
    new MutationObserver(() => {
      if (document.body.textContent?.includes("sync-aaaa")) seen.__leaked = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  await page.evaluate(() => (window as unknown as { __releaseA: () => void }).__releaseA());
  await page.waitForTimeout(1_000);

  expect(await page.evaluate(() => (window as unknown as { __leaked: boolean }).__leaked)).toBe(false);
});
