import { expect, test } from "@playwright/test";

const dismissedStorageKey = "gyredeck.dismissed-sessions";
const deletedStorageKey = "gyredeck.deleted-sessions";
const sessionEventsStorageKey = "gyredeck.session-events";

/**
 * Split in two, because the original raced the demo stream and lost about one run in eight
 * under load.
 *
 * `?demo=1` pushes an event every 800 ms and cycles the conversation it belongs to every
 * ten of them — `local-conv-demo-1` is alive for the first eight seconds, quiet for sixteen,
 * then alive again. Clearing it and then asserting it stayed cleared is a bet on where in
 * that cycle the click landed: near the end of it, fresh activity revives the session before
 * the assertion can read the key, which is correct behaviour and a failing test.
 *
 * So each half is asked of a page where its answer cannot move. Clearing is asked of a
 * static scenario with no stream at all; reviving is asked of a fresh `?demo=1` load, where
 * the very first event — pushed synchronously, before the interval starts — belongs to
 * `local-conv-demo-1`.
 */
test("clear hides a session that has ended", async ({ page }) => {
  await page.goto("/?demo=1&demoScenario=done");
  await page.evaluate((key) => window.localStorage.removeItem(key), dismissedStorageKey);
  await page.reload();

  const clearButton = page.getByRole("button", { name: /Clear completed .* session/ });
  await clearButton.waitFor({ state: "visible", timeout: 10_000 });
  await clearButton.click();

  // Nothing is pushing events at this page, so the dismissal is the only thing that can
  // move the key, and the row is the only thing that can leave the list.
  await expect
    .poll(async () => page.evaluate((key) => window.localStorage.getItem(key), dismissedStorageKey))
    .toContain("local-conv-demo-done");
  await expect(page.getByText("Waiting for Claude Code")).toBeVisible({ timeout: 10_000 });
});

test("fresh activity brings a cleared session back", async ({ page }) => {
  // Seeded as already cleared, then handed a page whose first event is for that very
  // conversation. The demo script restarts at index 0 on every load and pushes once
  // immediately, before the 800 ms interval starts, so this waits on nothing.
  //
  // Two details, both load-bearing, both found by Codex reviewing the first version of
  // this. The dismissal is written by `addInitScript`, which runs before the app does, so
  // there is one load and no doubt about which event arrived first. And it is stamped a
  // second in the past, because a session counts as still cleared while its dismissal is
  // **at or after** its latest event — a dismissal written in the same millisecond as the
  // first event would keep it hidden, correctly, and fail this test on a fast machine.
  await page.addInitScript(
    ([key, conversationId]) => {
      window.localStorage.setItem(key, JSON.stringify({ [conversationId]: Date.now() - 1_000 }));
    },
    [dismissedStorageKey, "local-conv-demo-1"],
  );
  await page.goto("/?demo=1");

  await expect
    .poll(
      async () => page.evaluate((key) => window.localStorage.getItem(key), dismissedStorageKey),
      { timeout: 10_000 },
    )
    .not.toContain("local-conv-demo-1");
  await expect(page.getByText("gyredeck").first()).toBeVisible({ timeout: 10_000 });
});

test("delete removes a stuck session registry locally", async ({ page }) => {
  await page.goto("/?demo=1");
  await page.evaluate(
    ([dismissedKey, deletedKey, sessionKey]) => {
      window.localStorage.removeItem(dismissedKey);
      window.localStorage.removeItem(deletedKey);
      window.localStorage.removeItem(sessionKey);
    },
    [dismissedStorageKey, deletedStorageKey, sessionEventsStorageKey],
  );
  await page.reload();

  await page.getByRole("button", { name: /Clear completed .* session/ }).waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".session-row-main").first().click();
  await page.getByRole("button", { name: "Remove history" }).click();
  await page.getByRole("button", { name: "Confirm remove" }).click();

  await expect.poll(async () =>
    page.evaluate(
      ([deletedKey, sessionKey]) => {
        const deleted = JSON.parse(window.localStorage.getItem(deletedKey) ?? "{}");
        const sessions = JSON.parse(window.localStorage.getItem(sessionKey) ?? "{}");
        return {
          deleted: typeof deleted["local-conv-demo-1"] === "number",
          hasSessionEvents: Object.hasOwn(sessions, "local-conv-demo-1"),
        };
      },
      [deletedStorageKey, sessionEventsStorageKey],
    ),
  ).toEqual({ deleted: true, hasSessionEvents: false });
});

test("completed session survives a quiet reload until explicitly cleared", async ({ page }) => {
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  await page.route("http://127.0.0.1:47621/**", (route) => route.abort());
  await page.goto("/");
  await page.evaluate(
    ({ sessionKey, dismissedKey, deletedKey, eventTimestamp }) => {
      window.localStorage.setItem(sessionKey, JSON.stringify({
        "local-conv-quiet-done": [
          {
            version: 2,
            id: "quiet-done",
            timestamp: eventTimestamp,
            agentId: "agent-demo",
            agentName: "Mahiro Code",
            conversationId: "local-conv-quiet-done",
            cwd: "/Users/mahiro/ghq/github.com/j-kizt/gyredeck-macos",
            model: "gpt-5.6-sol",
            permissionMode: "unrestricted",
            type: "turn_complete",
            data: { hookEventName: "Stop", source: "hook", message: "Quiet completion" },
          },
        ],
      }));
      window.localStorage.removeItem(dismissedKey);
      window.localStorage.removeItem(deletedKey);
    },
    { sessionKey: sessionEventsStorageKey, dismissedKey: dismissedStorageKey, deletedKey: deletedStorageKey, eventTimestamp: timestamp },
  );

  await page.reload();
  await page.locator(".halo-surface").hover();
  await expect(page.locator('.session-row[data-status="done"]')).toBeVisible();
  await page.reload();
  await page.locator(".halo-surface").hover();
  await expect(page.locator('.session-row[data-status="done"]')).toBeVisible();
});
