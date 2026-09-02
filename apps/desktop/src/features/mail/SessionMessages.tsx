import { Send } from "lucide-react";
import { useState } from "react";
import { formatTime } from "../session/activity";
import type { ISessionSummary } from "../session/types";
import { useMailThread, type MailDelivery } from "./useMailRooms";

/**
 * How a message will reach a session, stated before it is sent.
 *
 * A person needs this up front, not afterwards: mail to an Antigravity or Claude Code
 * session sits in its room until that session next runs, which can be minutes or never.
 * Without saying so, a send that goes quiet looks like a bug rather than a wait.
 */
const reachability = (
  provider: string,
): { canSend: boolean; note: string } => {
  if (provider === "Codex") {
    return { canSend: true, note: "Delivered straight away — Codex reads it without waiting to be prompted." };
  }
  if (provider === "Antigravity" || provider === "Claude Code") {
    return { canSend: true, note: `Arrives the next time this ${provider} session runs.` };
  }
  return { canSend: false, note: "Gyredeck cannot deliver to this agent yet." };
};

const DELIVERY_LABEL: Record<MailDelivery, string> = {
  queued: "delivered",
  on_next_turn: "waiting for this session to run",
  unknown_recipient: "no session found to deliver to",
  unavailable: "the agent's CLI could not be found",
};

/**
 * The message thread with one session, and a box to add to it.
 *
 * Everything a person needs is here: no room names, no tokens, no commands. The room
 * is the session's own id, which the card already holds, and both reading and sending
 * go through the native side so the webview never handles the ingest token.
 */
export const SessionMessages = ({
  session,
  canUseNativeControls,
}: {
  session: ISessionSummary;
  canUseNativeControls: boolean;
}) => {
  const [draft, setDraft] = useState("");
  const { messages, send, sending, error, lastDelivery } = useMailThread({
    room: session.conversationId,
    canUseNativeControls,
  });
  const { canSend, note } = reachability(session.provider);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    await send(text);
  };

  return (
    <section className="session-messages" aria-labelledby="session-messages-heading">
      <div className="session-messages-head">
        <span id="session-messages-heading">Messages</span>
        {messages.length > 0 ? <span className="session-messages-count">{messages.length}</span> : null}
      </div>

      {messages.length === 0 ? (
        <p className="session-messages-empty">
          Nothing yet. A message you send here is delivered to this session — and to any
          other agent that writes to it.
        </p>
      ) : (
        <ul className="session-messages-list">
          {messages.map((message) => {
            // A message from the room's own id came from the session; anything else
            // came from the person, or from another agent on this machine.
            const mine = message.from === "gyredeck";
            const fromSession = message.from === session.conversationId;
            return (
              <li key={message.seq} className="session-message" data-origin={mine ? "user" : fromSession ? "session" : "peer"}>
                <span className="session-message-who">
                  {mine ? "You" : fromSession ? session.provider : message.from}
                  {message.ts ? <span className="session-message-time">{formatTime(message.ts)}</span> : null}
                </span>
                <span className="session-message-text">{message.text}</span>
              </li>
            );
          })}
        </ul>
      )}

      {canUseNativeControls && canSend ? (
        <div className="session-messages-compose">
          <textarea
            className="session-messages-input"
            placeholder={`Message this ${session.provider} session…`}
            value={draft}
            rows={2}
            disabled={sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            aria-label={`Message this ${session.provider} session`}
          />
          <button
            className="session-messages-send"
            type="button"
            onClick={() => void submit()}
            disabled={sending || draft.trim().length === 0}
            data-tauri-drag-region="false"
            aria-label="Send message"
          >
            <Send size={12} strokeWidth={2.4} />
          </button>
        </div>
      ) : null}

      <p className="session-messages-note">
        {error
          ? error
          : lastDelivery
            ? `Last message: ${DELIVERY_LABEL[lastDelivery]}.`
            : canUseNativeControls
              ? note
              : "Browser demo cannot send messages."}
      </p>
    </section>
  );
};
