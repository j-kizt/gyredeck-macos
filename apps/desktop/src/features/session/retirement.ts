import type { GyredeckEvent } from "@gyredeck/protocol";

/**
 * Codex front ends whose sessions exist for one command and then do not exist.
 *
 * `codex exec` opens a real Codex session, takes a turn and closes again inside a couple
 * of seconds, reporting every step. A completed row is sticky by design
 * (`.claude/context/presence-model.md`) — that contract was written for a session a
 * person is sitting in, and it turned those two seconds into a row that outlived the
 * command by days, indistinguishable from a session still in use.
 */
const ONE_SHOT_CLIENTS = new Set(["codex_exec"]);

/**
 * How long a finished one-shot stays on screen.
 *
 * Not zero: a command whose row never appeared, or appeared and vanished in the same
 * frame, cannot be seen to have succeeded. Not sticky either, or a day of batch commands
 * becomes the session list.
 */
export const ONE_SHOT_GRACE_MS = 8_000;

/**
 * Whether this session is a finished one-shot that has had its moment on screen.
 *
 * Three questions, and all three are answered from the session's own events rather than
 * from the order they arrived in. The close is published before the completion that names
 * the client — that is the real order, measured, not a hypothetical — so a rule that read
 * the client off the close event would never fire.
 *
 * An unknown client is never treated as one-shot. Only Codex's `notify` is told which
 * front end ran, so a machine without that adapter says nothing here, and saying nothing
 * leaves the row where it was.
 */
export const isRetiredOneShot = (events: GyredeckEvent[], now: Date) => {
  const latest = events[0];
  if (!latest) return false;

  let closed = false;
  let oneShot = false;
  for (const event of events) {
    if (event.type === "conversation_close") closed = true;
    if (event.type === "turn_complete") {
      const client = event.data.client;
      if (typeof client === "string" && ONE_SHOT_CLIENTS.has(client)) oneShot = true;
    }
    if (closed && oneShot) break;
  }
  if (!closed || !oneShot) return false;

  return now.getTime() - Date.parse(latest.timestamp) >= ONE_SHOT_GRACE_MS;
};

/**
 * Whether this session should leave the list now.
 *
 * Its own function, and in this file rather than in the selector, for the same reason
 * `grouping.ts` exists: the selector cannot be imported by a plain Node test — its
 * extensionless relative imports do not resolve under type stripping — so a rule left
 * inside it is a rule nothing can hold to account.
 */
export const shouldRetireFromList = (
  conversationId: string,
  events: GyredeckEvent[],
  now: Date,
  selectedConversationId: string | null,
) => conversationId !== selectedConversationId && isRetiredOneShot(events, now);
