import { expect, test } from "@playwright/test";

/**
 * #383: the Messages tab names a sender as the room shows it — `<provider> / <name>`, or
 * `<provider> / #<id>` — on one line. A long name is cut with "…", the later twin's ` #id` is
 * never cut, and the whole form is on hover. A message kept from before #383 shows its label.
 */

const LONG = "TeamSync Altrix Integration Audit Nights";
const message = (seq: number, fromLabel: string, fromShown: string | undefined, preview: string) => ({
  seq, room: "sync-9782", from: `m${seq}`, fromLabel, ...(fromShown ? { fromShown } : {}), kind: "tell", preview, at: `2026-11-27T07:0${seq}:00Z`,
});
const MESSAGES = [
  message(1, "Claude Code · Worker #eb5183", "Claude Code / Gyre Assistant", "plain name"),
  message(2, "Codex", "Codex / #a89722", "no name"),
  message(3, "Claude Code · Worker #4f2c1d", `Claude Code / ${LONG} #4f2c1d`, "long twin"),
  message(4, "Antigravity · Worker", undefined, "kept from before"),
];

test("a sender is its shown form on one line: a long name is cut, a twin's id never is, the whole form on hover", async ({ page }) => {
  await page.setViewportSize({ width: 444, height: 560 });
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "sync_room") return { room: "sync-9782", members: [] };
        throw new Error(command + " unavailable");
      },
    };
  });
  await page.goto("/?demo=1&demoScenario=long-llm");
  const row = page.locator(".session-row-main").first();
  await row.waitFor();
  const conversationId = await row.getAttribute("data-session-id");
  expect(conversationId).toBeTruthy();
  await page.evaluate(([id, messages]) => {
    window.localStorage.setItem("gyredeck.room-inbox", JSON.stringify({ [id as string]: { room: "sync-9782", readAt: null, messages } }));
  }, [conversationId, MESSAGES] as const);
  await page.reload();
  await page.locator(".session-row-main").first().click();
  await page.getByRole("tab", { name: /^Messages/ }).click();

  const byPreview = (text: string) => page.locator(".session-sync-message").filter({ hasText: text });
  await expect(byPreview("plain name").locator(".session-sync-message-from")).toHaveText("Claude Code / Gyre Assistant");
  await expect(byPreview("no name").locator(".session-sync-message-who")).toHaveText("Codex / #a89722");
  await expect(byPreview("no name").locator(".session-sync-message-twin")).toHaveCount(0);
  await expect(byPreview("kept from before").locator(".session-sync-message-from")).toHaveText("Antigravity · Worker");

  const twin = byPreview("long twin");
  await expect(twin.locator(".session-sync-message-twin")).toHaveText(/#4f2c1d$/);
  const box = await twin.evaluate((element) => {
    const from = element.querySelector<HTMLElement>(".session-sync-message-from")!;
    const who = element.querySelector<HTMLElement>(".session-sync-message-who")!;
    const id = element.querySelector<HTMLElement>(".session-sync-message-twin")!;
    const meta = element.querySelector<HTMLElement>(".session-sync-message-meta")!;
    const r = (node: HTMLElement) => node.getBoundingClientRect();
    return {
      whoCut: who.scrollWidth > who.clientWidth && getComputedStyle(who).overflowX === "hidden" && getComputedStyle(who).textOverflow === "ellipsis",
      idWhole: id.scrollWidth <= id.clientWidth + 1,
      idInside: r(id).right <= r(from).right + 0.5 && r(id).left >= r(who).right - 0.5,
      oneLine: Math.round(r(from).height) === Math.round(r(who).height) && r(from).height < 20,
      metaClear: r(meta).left >= r(from).right,
      noSideways: element.scrollWidth <= element.clientWidth,
    };
  });
  expect(box).toEqual({ whoCut: true, idWhole: true, idInside: true, oneLine: true, metaClear: true, noSideways: true });

  await twin.locator(".session-sync-message-who").hover();
  await expect(page.locator(".app-tooltip")).toHaveText(`Claude Code / ${LONG} #4f2c1d`);
});

type Delivered = { identifier: string; title: string; subtitle?: string | null; body: string };
type Win = typeof window & { __appEmit: (payload: unknown) => void; __delivered: Delivered[]; __listening: () => boolean };

test("a room notification is titled with the sender as shown, the room on the line below; an older bridge's label stands in", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as Win;
    const callbacks = new Map<number, (event: unknown) => void>();
    let next = 1;
    let listener: number | null = null;
    w.__delivered = [];
    w.__listening = () => listener !== null;
    w.__appEmit = (payload) => { if (listener !== null) callbacks.get(listener)?.({ event: "app_event", id: 1, payload }); };
    (w as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    (w as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      transformCallback: (callback: (event: unknown) => void) => { const id = next++; callbacks.set(id, callback); return id; },
      invoke: async (command: string, args?: { event?: string; handler?: number } & Delivered) => {
        if (command === "set_keep_awake") return false;
        if (command.endsWith("_hook_status")) return ["/Users/demo/.config/gyredeck/hook.mjs", true];
        if (command === "notification_permission_state") return "authorized";
        if (command === "app_events") return [];
        if (command === "plugin:event|listen") { if (args?.event === "app_event") listener = args.handler ?? null; return 1; }
        if (command === "plugin:event|unlisten") return null;
        if (command === "plugin:window|is_visible") return false;
        if (command === "deliver_notification") { w.__delivered.push({ identifier: args!.identifier, title: args!.title, subtitle: args!.subtitle ?? null, body: args!.body }); return null; }
        throw new Error(`${command} unavailable`);
      },
    };
  });
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (window as Win).__listening())).toBe(true);
  const roomMessage = (n: number, conversationId: string, data: Record<string, unknown>) => ({
    n, event: { version: 2, id: `room-${n}`, type: "room_message", timestamp: "2026-11-27T07:00:00Z", conversationId, data: { room: "sync-9782", seq: n, from: "m", kind: "ask", ...data } },
  });
  await page.evaluate((p) => (window as Win).__appEmit(p), roomMessage(1, "s-1", { fromLabel: "Claude Code · Worker #4f2c1d", fromShown: `Claude Code / ${LONG} #4f2c1d`, preview: "merge it?" }));
  await expect.poll(() => page.evaluate(() => (window as Win).__delivered.length)).toBe(1);
  await page.evaluate((p) => (window as Win).__appEmit(p), roomMessage(2, "s-2", { fromLabel: "Codex", preview: "from before" }));
  await expect.poll(() => page.evaluate(() => (window as Win).__delivered)).toEqual([
    { identifier: "gyredeck.room.s-1", title: `Claude Code / ${LONG} #4f2c1d`, subtitle: "sync-9782", body: "merge it?" },
    { identifier: "gyredeck.room.s-2", title: "Codex", subtitle: "sync-9782", body: "from before" },
  ]);
});
