import { expect, test } from "@playwright/test";

test("the sync panel walks create, join and disconnect, and shows a refusal where it happened", async ({ page }) => {
  await page.addInitScript(() => {
    // A room lives in the bridge; here it lives in the page so the panel can be driven
    // through every state without one.
    let room: { room: string | null; members: unknown[] } = { room: null, members: [] };
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: Record<string, string>) => {
        if (command === "set_keep_awake") return false;
        if (command === "sync_room") return room;
        if (command === "sync_create") {
          room = {
            room: "sync-4f2a",
            members: [{ conversationId: "me", provider: "Claude Code", pending: 0, you: true }],
          };
          return room;
        }
        if (command === "sync_join") {
          // The one refusal a person will actually hit: a code that names nothing.
          if (args?.code !== "sync-4f2a") throw new Error("No room with that code");
          room = {
            room: "sync-4f2a",
            members: [
              { conversationId: "me", provider: "Claude Code", pending: 0, you: true },
              { conversationId: "peer", provider: "Codex", pending: 2, you: false },
            ],
          };
          return room;
        }
        if (command === "sync_leave") {
          room = { room: null, members: [] };
          return null;
        }
        throw new Error(`${command} unavailable`);
      },
    };
  });

  await page.goto("/?demo=1&demoScenario=long-llm");
  await page.locator(".session-row-main").click();

  const sync = page.locator(".session-sync");
  await expect(sync).toBeVisible();
  // Nothing to type a message into, and nothing to describe a session with: this
  // panel connects sessions and stops there.
  await expect(sync.locator("textarea")).toHaveCount(0);
  await expect(sync.getByText("Put this session in a room with another")).toBeVisible();

  // A code that names nothing has to say so next to the field that caused it.
  await sync.getByRole("button", { name: "Join sync" }).click();
  await sync.getByRole("textbox", { name: "Room code to join" }).fill("sync-nope");
  await sync.getByRole("button", { name: "Connect" }).click();
  await expect(sync.locator('.session-sync-note[data-error="true"]')).toHaveText("No room with that code");

  await sync.getByRole("textbox", { name: "Room code to join" }).fill("sync-4f2a");
  await sync.getByRole("button", { name: "Connect" }).click();

  // Connected: the code and who is in the room take the place of the buttons that put
  // it there, so Create and Join cannot be pressed again by mistake. Create already
  // joined, so nothing is left to confirm — just the code and the two things worth
  // doing with it.
  await expect(sync.locator(".session-sync-code")).toHaveText("sync-4f2a");
  await expect(sync.getByRole("button", { name: "Copy room code sync-4f2a" })).toBeVisible();
  await expect(sync.getByRole("button", { name: "Disconnect from sync room" })).toBeVisible();
  await expect(sync.getByRole("button", { name: "Create sync" })).toHaveCount(0);
  await expect(sync.getByRole("button", { name: "Join sync" })).toHaveCount(0);
  // Members are named and nothing more: what each session is for came from its own
  // user in its own terminal, so there is no role to show and none to fill in.
  await expect(sync.getByText("This session")).toBeVisible();
  await expect(sync.getByText("Codex")).toBeVisible();
  await expect(sync.locator("input")).toHaveCount(0);
  // What is waiting for the other member, so the person can see a handover stall.
  await expect(sync.locator(".session-sync-pending")).toHaveText("2");

  await sync.getByRole("button", { name: "Disconnect from sync room" }).click();
  await expect(sync.getByRole("button", { name: "Create sync" })).toBeVisible();
});
