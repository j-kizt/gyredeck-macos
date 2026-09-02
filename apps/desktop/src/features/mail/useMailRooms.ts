import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

export interface IMailRoom {
  room: string;
  seq: number;
  pending: number;
  subscribers: number;
  lastMessageAt: string | null;
  lastReadAt: string | null;
}

const POLL_INTERVAL_MS = 5_000;

/**
 * Mail waiting for each session, keyed by conversation id.
 *
 * A room is named after the conversation it belongs to, so its key is the same id a
 * session card already holds. Polled rather than streamed: mail is not part of the
 * presence event protocol, and a few seconds of lag on "something is waiting" is a
 * better trade than widening the event union — and than letting a mail message
 * decide a session's status.
 *
 * The token stays native. The webview asks this process for room state instead of
 * holding a credential it has no other use for.
 */
export const useMailRooms = ({
  active,
  canUseNativeControls,
}: {
  active: boolean;
  canUseNativeControls: boolean;
}): Record<string, IMailRoom> => {
  const [rooms, setRooms] = useState<Record<string, IMailRoom>>({});

  useEffect(() => {
    if (!active || !canUseNativeControls) return;
    let cancelled = false;

    const read = async () => {
      try {
        const next = await invoke<IMailRoom[]>("mail_rooms");
        if (cancelled) return;
        const entries = Array.isArray(next) ? next : [];
        setRooms(Object.fromEntries(entries.map((room) => [room.room, room])));
      } catch {
        // A bridge that predates mail rooms answers 404, and one that is still
        // starting answers nothing. Clear rather than keep the last reading: showing
        // mail as waiting when it may already have been delivered is worse than
        // showing nothing.
        if (!cancelled) setRooms({});
      }
    };

    void read();
    const timer = window.setInterval(read, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, canUseNativeControls]);

  return rooms;
};

export interface IMailMessage {
  seq: number;
  from: string;
  text: string;
  replyTo: string | null;
  ts: string | null;
}

/** What the bridge managed to do with a message, in the order of how good it is. */
export type MailDelivery = "queued" | "on_next_turn" | "unknown_recipient" | "unavailable";

export interface IMailThread {
  messages: IMailMessage[];
  send: (text: string) => Promise<void>;
  sending: boolean;
  error: string | null;
  lastDelivery: MailDelivery | null;
}

const THREAD_POLL_INTERVAL_MS = 3_000;

/**
 * The message thread with one session.
 *
 * A room is named after the conversation, so the room and the session are the same
 * thing under two names — the caller passes a conversation id and gets its thread.
 * Sending goes through the native side too, so the ingest token is never handed to
 * the webview.
 */
export const useMailThread = ({
  room,
  canUseNativeControls,
}: {
  room: string | null;
  canUseNativeControls: boolean;
}): IMailThread => {
  const [messages, setMessages] = useState<IMailMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDelivery, setLastDelivery] = useState<MailDelivery | null>(null);

  const read = useCallback(async () => {
    if (!room || !canUseNativeControls) return;
    try {
      const next = await invoke<IMailMessage[]>("mail_thread", { room });
      setMessages(Array.isArray(next) ? next : []);
    } catch {
      // A bridge that is starting, or one predating mail rooms, has no thread to show.
      setMessages([]);
    }
  }, [canUseNativeControls, room]);

  useEffect(() => {
    setMessages([]);
    setError(null);
    setLastDelivery(null);
    if (!room || !canUseNativeControls) return;
    void read();
    // Polled because a reply arrives on the agent's schedule, not ours — a Codex
    // session answers within seconds, one waiting for a hook can take much longer.
    const timer = window.setInterval(() => void read(), THREAD_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [canUseNativeControls, read, room]);

  const send = useCallback(
    async (text: string) => {
      if (!room || !canUseNativeControls || !text.trim()) return;
      setSending(true);
      setError(null);
      try {
        const result = await invoke<{ seq: number; delivery: MailDelivery }>("mail_send", {
          room,
          text: text.trim(),
        });
        setLastDelivery(result.delivery);
        await read();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSending(false);
      }
    },
    [canUseNativeControls, read, room],
  );

  return { messages, send, sending, error, lastDelivery };
};
