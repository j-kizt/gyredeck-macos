import { useCallback, useEffect, useRef, useState } from "react";
import type { GyredeckEvent } from "@gyredeck/protocol";

/** One thing somebody said in a room, as this session received it. */
export interface IRoomMessage {
  seq: number;
  room: string;
  from: string;
  fromLabel: string;
  kind: string;
  preview: string;
  at: string;
}

export interface IRoomInbox {
  messages: IRoomMessage[];
  /** When this session's messages were last looked at. Null means never. */
  readAt: string | null;
}

export type RoomInboxRegistry = Record<string, IRoomInbox>;

const STORAGE_KEY = "gyredeck.room-inbox";
/** Per session. Enough to catch up on after being away, not a transcript. */
const MAX_MESSAGES = 20;

const read = (): RoomInboxRegistry => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as RoomInboxRegistry;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const write = (registry: RoomInboxRegistry) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // The running app still holds the state; losing the history is not worth an error.
  }
};

export const unreadIn = (inbox: IRoomInbox | undefined): number => {
  if (!inbox) return 0;
  if (!inbox.readAt) return inbox.messages.length;
  const readAt = Date.parse(inbox.readAt);
  return inbox.messages.filter((message) => Date.parse(message.at) > readAt).length;
};

/**
 * What was said to each session in a sync room, and whether it has been looked at.
 *
 * Kept from the event stream rather than from the room poller: that poller only runs
 * while the session list is on screen, so a reply arriving while the user is on another
 * tab would be missed by it entirely. The live event arrives regardless — that is the
 * reason `room_message` exists.
 *
 * Persisted because the question it answers is "what did I miss", and the answer must
 * survive the window being closed, which is exactly when messages arrive unseen.
 */
export const useRoomInbox = ({ lastLiveEvent }: { lastLiveEvent: GyredeckEvent | null }) => {
  const [registry, setRegistry] = useState<RoomInboxRegistry>(read);
  // The same event object can arrive again as other state settles; its id is the only
  // thing that says "already counted", and counting twice is the visible failure.
  const recordedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!lastLiveEvent || lastLiveEvent.type !== "room_message") return;
    if (recordedRef.current === lastLiveEvent.id) return;
    recordedRef.current = lastLiveEvent.id;

    const conversationId = lastLiveEvent.conversationId;
    if (!conversationId) return;
    const data = lastLiveEvent.data;

    setRegistry((current) => {
      const inbox = current[conversationId] ?? { messages: [], readAt: null };
      // Seq is unique within a room, and a room is what this event is about — so a
      // replayed backfill lands on the message it already recorded rather than beside it.
      if (inbox.messages.some((message) => message.seq === data.seq && message.room === data.room)) {
        return current;
      }
      const message: IRoomMessage = {
        seq: data.seq,
        room: data.room,
        from: data.from,
        fromLabel: data.fromLabel,
        kind: data.kind,
        preview: data.preview,
        at: lastLiveEvent.timestamp,
      };
      const next: RoomInboxRegistry = {
        ...current,
        [conversationId]: {
          ...inbox,
          messages: [...inbox.messages, message].slice(-MAX_MESSAGES),
        },
      };
      write(next);
      return next;
    });
  }, [lastLiveEvent]);

  const markRead = useCallback((conversationId: string) => {
    setRegistry((current) => {
      const inbox = current[conversationId];
      if (!inbox || unreadIn(inbox) === 0) return current;
      const next: RoomInboxRegistry = {
        ...current,
        [conversationId]: { ...inbox, readAt: new Date().toISOString() },
      };
      write(next);
      return next;
    });
  }, []);

  const forget = useCallback((conversationId: string) => {
    setRegistry((current) => {
      if (!current[conversationId]) return current;
      const { [conversationId]: _dropped, ...rest } = current;
      write(rest);
      return rest;
    });
  }, []);

  return { inbox: registry, markRead, forget };
};
