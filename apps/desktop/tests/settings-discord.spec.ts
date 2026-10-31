import { expect, test, type Page } from "@playwright/test";

/**
 * Settings → Permission → Remote access: the Discord bot that follows sync rooms (#199), and the
 * per-room Discord button on the founder's rows under Settings → Connection. The native commands
 * are mocked with the `discord_status` shape the Rust side answers.
 */

type Status = {
  configured: boolean;
  running: boolean;
  ready: boolean;
  bot: { id: string; username: string } | null;
  forums: Array<{ id: string; name: string; guildName?: string | null }>;
  forumId: string | null;
  owner: { id: string; username: string | null } | null;
  inviteUrl: string | null;
  connectedRooms: string[];
  pairingCode: string | null;
  error: { code: string; message: string } | null;
  behind?: Record<string, number>;
  leaving?: Record<string, string>;
  dropped?: Record<string, number>;
  droppedLines?: Record<string, string>;
  /** The mock's own switch: a leave the bridge refuses. */
  failLeave?: boolean;
};
type Call = { command: string; args?: Record<string, unknown> };

const INVITE = "https://discord.com/oauth2/authorize?client_id=1234&scope=bot&permissions=309237763088";
const BOT = { id: "1234", username: "Gyre Bot" };
const FORUM = { id: "f1", name: "rooms", guildName: "Home" };
const OWNER = { id: "u1", username: "james" };
const TOKEN = "MTIzNDU2Nzg5MDEy.GaBcDe.secret-token-value-that-must-never-show";

// Discord's own limits: a username is at most 32 characters, a channel or server name 100.
const LONG_BOT = { id: "1234", username: "a_bot_with_the_longest_name_32ch" };
const LONG_FORUM = { id: "f1", name: "x".repeat(100), guildName: "y".repeat(100) };
// The fallback carries the connector's own message, so it is the longest error the block can show.
const LONG_ERROR = { code: "internal", message: `ENOENT: no such file /Users/a_rather_long_account_name_for_this_mac/.config/gyredeck/${"z".repeat(80)}.json` };

// The longest reason a refused leave carries: the bridge was reached, but not with the app's word.
const LONG_LEAVE = "Gyredeck could not vouch for itself to its own bridge. Quit and reopen Gyredeck";

const ERROR_COPY: Record<string, string> = {
  bad_token: "Discord refused this token. Copy it again from your app's Bot page and save it here.",
  missing_intent: "Turn on Message Content Intent on your app's Bot page in the Discord Developer Portal.",
  missing_permission: "The bot is missing a permission in your server. Invite it again with the button below.",
  no_forum: "The bot can see no forum channel. Make one in your server, then pick it here.",
  rate_limited: "Discord is slowing the bot down. Messages go out as soon as it allows.",
  discord_down: "Can't reach Discord right now. Messages wait and go out in order when it is back.",
  room_unknown: "That room is no longer open, so it can't be followed.",
  pairing_locked: "Too many wrong codes were sent to the bot. Press Pair again for a new code.",
  internal: "The Discord connector stopped on an error: boom",
};

const blank: Status = { configured: false, running: false, ready: false, bot: null, forums: [], forumId: null, owner: null, inviteUrl: null, connectedRooms: [], pairingCode: null, error: null };
const withBot = (extra: Partial<Status> = {}): Status => ({ ...blank, configured: true, running: true, ready: true, bot: BOT, inviteUrl: INVITE, ...extra });
const paired = (extra: Partial<Status> = {}): Status => withBot({ forums: [FORUM], forumId: FORUM.id, owner: OWNER, ...extra });

// One founder room, one joined room, so the button can be seen to pick the founder's.
const ROOMS = [
  { room: "sync-abcd", seq: 3, members: ["claude", "codex"], founder: "claude", pending: 999, subscribers: 2, lastMessageAt: null, lastReadAt: null },
  { room: "sync-wxyz", seq: 1, members: ["claude"], founder: null, pending: 0, subscribers: 1, lastMessageAt: null, lastReadAt: null },
];

const mock = async (page: Page, status: Status) => {
  await page.addInitScript(([initial, rooms]) => {
    const state = structuredClone(initial) as Status;
    const calls: Call[] = [];
    Object.assign(window, { __discord: state, __discordCalls: calls });
    (window as typeof window & { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === "set_keep_awake") return false;
        if (command === "mail_rooms") return rooms;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "sync_replies_allowed") return false;
        if (command === "discord_status") return structuredClone(state);
        if (command.startsWith("discord_") || command === "open_external_url") calls.push(args && Object.keys(args).length > 0 ? { command, args } : { command });
        if (command === "open_external_url") return null;
        // Every command but pairing answers with the status it leaves behind, as the native side does.
        const after = () => structuredClone(state);
        if (command === "discord_set_token") {
          Object.assign(state, { configured: true, running: true, ready: true, bot: { id: "1234", username: "Gyre Bot" }, inviteUrl: "https://discord.com/", error: null });
          return after();
        }
        if (command === "discord_set_forum") { state.forumId = String(args?.forumId); return after(); }
        if (command === "discord_start_pairing") { state.pairingCode = "482913"; return "482913"; }
        if (command === "discord_remove") {
          // A leave the bridge refuses leaves the room listed, as the native side keeps it.
          if (state.failLeave) state.leaving = Object.fromEntries(state.connectedRooms.map((code) => [code, "Gyredeck could not vouch for itself to its own bridge. Quit and reopen Gyredeck"]));
          Object.assign(state, { configured: false, running: false, ready: false, bot: null, forums: [], forumId: null, owner: null, inviteUrl: null, connectedRooms: [], pairingCode: null, error: null });
          return after();
        }
        if (command === "discord_retry_leave") {
          if (state.failLeave) throw new Error("the Discord member is still in the room");
          delete state.leaving?.[String(args?.code)];
          return after();
        }
        if (command === "discord_connect") { state.connectedRooms.push(String(args?.code)); return after(); }
        if (command === "discord_disconnect") { state.connectedRooms = state.connectedRooms.filter((code) => code !== args?.code); return after(); }
        throw new Error(`${command} unavailable`);
      },
    };
  }, [status, ROOMS] as const);
};

const open = async (page: Page, status: Status, tab: "Permission" | "Connection" = "Permission") => {
  await mock(page, status);
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: tab }).click();
  await expect(page.getByRole("tabpanel", { name: tab })).toBeVisible();
};

const calls = (page: Page) => page.evaluate(() => (window as typeof window & { __discordCalls: Call[] }).__discordCalls);
const commands = async (page: Page, command: string) => (await calls(page)).filter((call) => call.command === command);
const row = (page: Page, name: string) => page.locator(`.setup-row[data-discord='${name}']`);

test("not configured: a password field with Save and where to get a token, nothing else", async ({ page }) => {
  await open(page, blank);
  await expect(page.locator(".setup-subheading", { hasText: "Remote access" })).toBeVisible();
  const field = page.getByLabel("Discord bot token");
  await expect(field).toHaveAttribute("type", "password");
  await expect(row(page, "bot").locator(".setup-detail").first()).toContainText("discord.com/developers");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(page.locator("[data-discord='forum'], [data-discord='invite'], [data-discord='owner']")).toHaveCount(0);
});

test("a saved token goes to the native side once and is never shown again", async ({ page }) => {
  await open(page, blank);
  const field = page.getByLabel("Discord bot token");
  await field.fill(TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(row(page, "bot").locator(".setup-detail").first()).toHaveText("Bot · Gyre Bot");
  expect(await commands(page, "discord_set_token")).toEqual([{ command: "discord_set_token", args: { token: TOKEN } }]);
  await expect(field).toHaveCount(0);
  // Not in the markup, not in any field's value, not in any text.
  expect(await page.content()).not.toContain(TOKEN);
  expect(await page.evaluate(() => [...document.querySelectorAll("input")].map((input) => input.value))).not.toContain(TOKEN);
});

test("a token field is cleared as soon as Save is pressed, even before the answer", async ({ page }) => {
  await open(page, blank);
  await page.evaluate(() => {
    const internals = (window as typeof window & { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const real = internals.invoke;
    internals.invoke = (command, args) => (command === "discord_set_token" ? new Promise(() => {}) : real(command, args));
  });
  const field = page.getByLabel("Discord bot token");
  await field.fill(TOKEN);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(field).toHaveValue("");
});

test("configured with several forums: a forum select, an invite button that opens the invite link, and Pair", async ({ page }) => {
  await page.clock.install();
  await open(page, withBot({ forums: [FORUM, { id: "f2", name: "work", guildName: "Office" }] }));
  await expect(row(page, "bot").locator(".setup-detail").first()).toHaveText("Bot · Gyre Bot");
  await expect(page.getByLabel("Discord bot token")).toHaveCount(0);
  const select = page.getByRole("combobox", { name: "Discord forum" });
  await expect(select.locator("option")).toHaveText(["Pick a forum", "rooms · Home", "work · Office"]);
  // Two forums are a choice, so nothing is picked for the owner.
  expect(await commands(page, "discord_set_forum")).toEqual([]);
  await select.selectOption("f2");
  await expect.poll(() => commands(page, "discord_set_forum")).toEqual([{ command: "discord_set_forum", args: { forumId: "f2" } }]);

  await page.getByRole("button", { name: "Invite the bot" }).click();
  await expect.poll(() => commands(page, "open_external_url")).toEqual([{ command: "open_external_url", args: { url: INVITE } }]);

  await page.getByRole("button", { name: "Pair" }).click();
  await expect(row(page, "owner").locator(".setup-title")).toHaveText("482913");
  await expect(row(page, "owner").locator(".setup-detail")).toHaveText("Send this code to Gyre Bot in a direct message on Discord");
  expect(await commands(page, "discord_start_pairing")).toHaveLength(1);

  // The owner answers the DM; the next poll shows who is paired and Pair goes away.
  await page.evaluate(() => Object.assign((window as typeof window & { __discord: Status }).__discord, { owner: { id: "u1", username: "james" }, pairingCode: null }));
  await page.clock.runFor(5_100);
  await expect(row(page, "owner").locator(".setup-title")).toHaveText("Paired with james");
  await expect(row(page, "owner").getByRole("button")).toHaveCount(0);
});

test("one forum is picked by itself, once", async ({ page }) => {
  await page.clock.install();
  await open(page, withBot({ forums: [FORUM] }));
  await expect(page.getByRole("combobox", { name: "Discord forum" })).toHaveValue("f1");
  await page.clock.runFor(15_000);
  expect(await commands(page, "discord_set_forum")).toEqual([{ command: "discord_set_forum", args: { forumId: "f1" } }]);
});

test("a forum with no server name shows its own name, and an owner with no name shows the id", async ({ page }) => {
  await open(page, withBot({ forums: [{ id: "f1", name: "rooms" }, { id: "f2", name: "work", guildName: null }], forumId: "f1", owner: { id: "4242", username: null } }));
  await expect(page.getByRole("combobox", { name: "Discord forum" }).locator("option")).toHaveText(["rooms", "work"]);
  await expect(row(page, "owner").locator(".setup-title")).toHaveText("Paired with 4242");
});

test("no forum yet: no select, the invite is still offered", async ({ page }) => {
  await open(page, withBot());
  await expect(row(page, "forum").locator(".setup-detail")).toHaveText("No forum channel yet — invite the bot to a server that has one");
  await expect(page.getByRole("combobox", { name: "Discord forum" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Invite the bot" })).toBeVisible();
});

test("Remove asks first, says the posts stay, and Cancel removes nothing", async ({ page }) => {
  await open(page, paired());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row(page, "bot").getByRole("alert")).toHaveText("Remove Discord? The bot stops and its token is deleted. Posts already in Discord stay there.");
  expect(await commands(page, "discord_remove")).toEqual([]);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(row(page, "bot").getByRole("alert")).toHaveCount(0);
  expect(await commands(page, "discord_remove")).toEqual([]);

  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Remove Discord" }).click();
  await expect(page.getByLabel("Discord bot token")).toBeVisible();
  expect(await commands(page, "discord_remove")).toEqual([{ command: "discord_remove" }]);
});

for (const [code, copy] of Object.entries(ERROR_COPY)) {
  test(`error ${code} is said in plain words`, async ({ page }) => {
    await open(page, { ...blank, configured: true, error: { code, message: "boom" } });
    await expect(row(page, "bot").locator(`[data-discord-error='${code}']`)).toHaveText(copy);
    // A refused token can be replaced from here; any other error leaves the token alone.
    await expect(page.getByLabel("Discord bot token")).toHaveCount(code === "bad_token" ? 1 : 0);
  });
}

test.describe("the room button", () => {
  const founderRow = (page: Page) => page.locator(".setup-account-row", { hasText: "sync-abcd" });
  const joinedRow = (page: Page) => page.locator(".setup-account-row", { hasText: "sync-wxyz" });

  test("sits only on the founder's row, tinted while followed, and toggles", async ({ page }) => {
    await open(page, paired({ connectedRooms: ["sync-abcd"] }), "Connection");
    await expect(joinedRow(page)).toBeVisible();
    await expect(joinedRow(page).getByRole("button", { name: /Discord/ })).toHaveCount(0);
    const button = founderRow(page).getByRole("button", { name: "Disconnect from Discord" });
    // Named by aria-label itself, not only by the title a name lookup would fall back to.
    await expect(button).toHaveAttribute("aria-label", "Disconnect from Discord");
    await expect(button).toHaveAttribute("title", "Disconnect from Discord");
    await expect(button).toHaveAttribute("data-active", "true");
    await button.click();
    const again = founderRow(page).getByRole("button", { name: "Connect to Discord" });
    await expect(again).toHaveAttribute("data-active", "false");
    await expect(again).toHaveAttribute("aria-label", "Connect to Discord");
    await expect(again).toHaveAttribute("title", "Connect to Discord");
    await again.click();
    await expect(founderRow(page).getByRole("button", { name: "Disconnect from Discord" })).toBeVisible();
    expect((await calls(page)).filter((call) => call.command.startsWith("discord_") && call.command !== "discord_status")).toEqual([
      { command: "discord_disconnect", args: { code: "sync-abcd" } },
      { command: "discord_connect", args: { code: "sync-abcd" } },
    ]);
  });

  for (const [name, status, shown] of [
    ["not configured", blank, /discord\.com\/developers/],
    ["no bot yet", { ...blank, configured: true }, "Connecting…"],
    ["no forum yet", withBot({ forums: [FORUM, { id: "f2", name: "work", guildName: "Office" }], owner: OWNER }), "Bot · Gyre Bot"],
    ["no owner yet", withBot({ forums: [FORUM], forumId: FORUM.id }), "Bot · Gyre Bot"],
    // Everything else in place, but the connector is not ready: a token refused after a good one.
    ["the connector is not ready", paired({ ready: false }), "Bot · Gyre Bot"],
  ] as const) {
    test(`is hidden while ${name}`, async ({ page }) => {
      await open(page, status, "Permission");
      // Premise: this status has been read and rendered — Settings holds one reading for both tabs.
      await expect(row(page, "bot").locator(".setup-detail").first()).toHaveText(shown);
      await page.getByRole("tab", { name: "Connection" }).click();
      await expect(founderRow(page).getByRole("button", { name: "Close room sync-abcd" })).toBeVisible();
      await expect(founderRow(page).getByRole("button", { name: /Discord/ })).toHaveCount(0);
    });
  }
});

test("a room the Discord member could not leave stays listed after Remove and a remount, until a retry works", async ({ page }) => {
  await open(page, paired({ connectedRooms: ["sync-abcd"], failLeave: true }));
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Remove Discord" }).click();
  await expect(page.getByLabel("Discord bot token")).toBeVisible();
  // Settings closed and opened again: nothing held in the page survives that.
  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(page.getByRole("tabpanel", { name: "Permission" })).toHaveCount(0);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Permission" }).click();
  const leaving = row(page, "leaving");
  await expect(leaving.locator(".setup-title")).toHaveText("Discord is still in room sync-abcd");
  await expect(leaving.locator(".setup-detail")).toHaveText("Could not leave: Gyredeck could not vouch for itself to its own bridge. Quit and reopen Gyredeck");
  await page.evaluate(() => { (window as typeof window & { __discord: { failLeave: boolean } }).__discord.failLeave = false; });
  await leaving.getByRole("button", { name: "Try leaving again" }).click();
  await expect(row(page, "leaving")).toHaveCount(0);
  expect(await commands(page, "discord_retry_leave")).toEqual([{ command: "discord_retry_leave", args: { code: "sync-abcd" } }]);
});

test("what Remove could not hand to Discord is said, after Remove too", async ({ page }) => {
  await open(page, { ...blank, dropped: { "sync-abcd": 4 } });
  await expect(row(page, "dropped").locator(".setup-title")).toHaveText("Room sync-abcd");
  await expect(row(page, "dropped").locator(".setup-detail")).toHaveText("4 messages could not be sent to Discord");
  await open(page, { ...blank, dropped: { "sync-abcd": 3 }, droppedLines: { "sync-abcd": "#41–#43 from Codex, Gyre Assistant" } });
  await expect(row(page, "dropped").locator(".setup-detail")).toHaveText("3 messages could not be sent to Discord: #41–#43 from Codex, Gyre Assistant");
});

test("a connected room says how many messages wait for Discord", async ({ page }) => {
  await open(page, paired({ connectedRooms: ["sync-abcd"], behind: { "sync-abcd": 3 } }));
  await expect(row(page, "behind").locator(".setup-title")).toHaveText("Room sync-abcd");
  await expect(row(page, "behind").locator(".setup-detail")).toHaveText("3 messages waiting for Discord");
});

// Layout, per lessons.md (#243): at the window's minimum and at a height that makes the column
// scroll, with the longest strings each row can show.
const LAYOUT_STATES = {
  "token field": blank,
  "longest names, code and error": withBot({ bot: LONG_BOT, forums: [LONG_FORUM], forumId: LONG_FORUM.id, pairingCode: "482913", error: LONG_ERROR }),
  "remove confirmation": withBot({ bot: LONG_BOT, forums: [LONG_FORUM], forumId: LONG_FORUM.id, pairingCode: "482913", error: LONG_ERROR }),
  "a room left behind and one waiting": withBot({ bot: LONG_BOT, forums: [LONG_FORUM], forumId: LONG_FORUM.id, pairingCode: "482913", error: LONG_ERROR, leaving: { "sync-abcd": LONG_LEAVE }, behind: { "sync-wxyz": 1000 } }),
  "a room left behind, no token": { ...blank, leaving: { "sync-abcd": LONG_LEAVE } },
  "messages that could not be sent": { ...blank, leaving: { "sync-abcd": LONG_LEAVE }, dropped: { "sync-abcd": 1000, "sync-wxyz": 1 } },
} as const;

for (const viewport of [{ width: 444, height: 560 }, { width: 444, height: 280 }]) test.describe(`at ${viewport.width} × ${viewport.height}`, () => {
  test.use({ viewport });

  for (const [name, status] of Object.entries(LAYOUT_STATES)) {
    test(`the Discord rows stay inside their boxes, below the heading and apart: ${name}`, async ({ page }) => {
      await open(page, status);
      const panel = page.getByRole("tabpanel", { name: "Permission" });
      const extra = [...Object.keys(status.leaving ?? {}).map(() => "leaving"), ...Object.keys(status.behind ?? {}).map(() => "behind"), ...Object.keys(status.dropped ?? {}).map(() => "dropped")];
      const expected = status.bot ? ["bot", ...extra, "forum", "invite", "owner"] : ["bot", ...extra];
      if (status.leaving) {
        await expect(row(page, "leaving").locator(".setup-detail")).toHaveText(`Could not leave: ${LONG_LEAVE}`);
        await expect(row(page, "leaving").getByRole("button", { name: "Try leaving again" })).toBeVisible();
      }
      if (status.behind) await expect(row(page, "behind").locator(".setup-detail")).toHaveText("1000 messages waiting for Discord");
      if (status.dropped) await expect(row(page, "dropped").first().locator(".setup-detail")).toHaveText("1000 messages could not be sent to Discord");
      // Premise: each row shows its longest text, so the layout is measured on it.
      if (status.bot) {
        await expect(row(page, "bot").locator(".setup-detail").first()).toHaveText(`Bot · ${LONG_BOT.username}`);
        await expect(row(page, "bot").locator("[data-discord-error]")).toHaveText(`The Discord connector stopped on an error: ${LONG_ERROR.message}`);
        await expect(page.getByRole("combobox", { name: "Discord forum" })).toHaveValue(LONG_FORUM.id);
        await expect(row(page, "owner").locator(".setup-detail")).toHaveText(`Send this code to ${LONG_BOT.username} in a direct message on Discord`);
      } else {
        await expect(page.getByLabel("Discord bot token")).toBeVisible();
      }
      if (name === "remove confirmation") {
        await page.getByRole("button", { name: "Remove", exact: true }).click();
        await expect(row(page, "bot").getByRole("alert")).toBeVisible();
      }
      const { head, rows } = await panel.evaluate((element, names) => {
        const rect = (node: Element | null) => {
          if (!node) throw new Error("not laid out");
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        const heading = [...element.querySelectorAll(".setup-subheading")].find((node) => node.textContent === "Remote access") ?? null;
        return {
          head: rect(heading),
          rows: names.map((name, index) => {
            // The nth row of a kind that repeats (one per room), not its first again.
            const nth = names.slice(0, index).filter((earlier) => earlier === name).length;
            const row = element.querySelectorAll(`.setup-row[data-discord='${name}']`)[nth] ?? null;
            return { name, row: rect(row), copy: rect(row?.querySelector(".setup-copy") ?? null) };
          }),
        };
      }, expected);
      for (const { name: which, row: box, copy } of rows) {
        expect(copy.x, which).toBeGreaterThanOrEqual(box.x);
        expect(copy.x + copy.width, which).toBeLessThanOrEqual(box.x + box.width + 0.5);
        expect(copy.y, which).toBeGreaterThanOrEqual(box.y);
        expect(copy.y + copy.height, which).toBeLessThanOrEqual(box.y + box.height + 0.5);
        expect(box.y, which).toBeGreaterThanOrEqual(head.y + head.height);
      }
      for (let index = 1; index < rows.length; index += 1) {
        expect(rows[index]!.row.y, rows[index]!.name).toBeGreaterThanOrEqual(rows[index - 1]!.row.y + rows[index - 1]!.row.height);
      }
      if (viewport.height < 560) {
        expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      }
      const overflow = await panel.evaluate((element) => {
        const all = [element, ...element.querySelectorAll<HTMLElement>("[data-discord], [data-discord] .setup-copy, [data-discord] .setup-detail, [data-discord] .setup-title, [data-discord] .setup-row-main, [data-discord] .setup-row-actions")];
        return all.filter((node) => node.scrollWidth > node.clientWidth).map((node) => node.className);
      });
      expect(overflow).toEqual([]);
    });
  }

  test("the founder's room row with the Discord button stays in one piece", async ({ page }) => {
    await open(page, paired({ connectedRooms: ["sync-abcd"] }), "Connection");
    const founder = page.locator(".setup-account-row", { hasText: "sync-abcd" });
    // Premise: the longest the row gets — the waiting count, the Discord button and the close button.
    await expect(founder.getByText("999 waiting")).toBeVisible();
    await expect(founder.getByRole("button", { name: "Disconnect from Discord" })).toBeVisible();
    const boxes = await founder.evaluate((element) => {
      const rect = (node: Element | null) => {
        if (!node) throw new Error("not laid out");
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      const heading = [...document.querySelectorAll(".setup-subheading")].find((node) => node.textContent === "Sync rooms") ?? null;
      return {
        row: rect(element),
        head: rect(heading),
        parts: [...element.children].map((child) => ({ name: child.className || child.tagName, ...rect(child) })),
        overflow: [element, ...element.querySelectorAll<HTMLElement>("*")].filter((node) => !(node instanceof SVGElement) && node.scrollWidth > node.clientWidth).map((node) => node.className),
      };
    });
    expect(boxes.row.y).toBeGreaterThanOrEqual(boxes.head.y + boxes.head.height);
    for (const part of boxes.parts) {
      expect(part.x, part.name).toBeGreaterThanOrEqual(boxes.row.x);
      expect(part.x + part.width, part.name).toBeLessThanOrEqual(boxes.row.x + boxes.row.width + 0.5);
      expect(part.y, part.name).toBeGreaterThanOrEqual(boxes.row.y);
      expect(part.y + part.height, part.name).toBeLessThanOrEqual(boxes.row.y + boxes.row.height + 0.5);
    }
    // The parts sit side by side, none over another.
    for (let index = 1; index < boxes.parts.length; index += 1) {
      expect(boxes.parts[index]!.x, boxes.parts[index]!.name).toBeGreaterThanOrEqual(boxes.parts[index - 1]!.x + boxes.parts[index - 1]!.width);
    }
    expect(boxes.overflow).toEqual([]);
  });
});
