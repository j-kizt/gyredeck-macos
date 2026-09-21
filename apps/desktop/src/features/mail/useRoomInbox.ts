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
  /** The room these messages belong to. Leaving it ends them. */
  room: string;
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
 * Record a message against the session it was addressed to.
 *
 * A different room is a different conversation: carrying the old list forward would mix
 * two rooms into one and count replies nobody in this room ever sent. Returns the
 * registry unchanged when the message is already held, which a backfill replays.
 */
export const recordMessage = (
  registry: RoomInboxRegistry,
  conversationId: string,
  message: IRoomMessage,
): RoomInboxRegistry => {
  const held = registry[conversationId];
  const inbox: IRoomInbox =
    held && held.room === message.room ? held : { room: message.room, messages: [], readAt: null };
  if (inbox.messages.some((held) => held.seq === message.seq)) return registry;
  return {
    ...registry,
    [conversationId]: { ...inbox, messages: [...inbox.messages, message].slice(-MAX_MESSAGES) },
  };
};

/**
 * Keep only what belongs to the room this session is in now.
 *
 * Messages outlive rooms otherwise: leaving one left its replies sitting under the
 * session, counted as unread and shown in a tab, for a conversation that had ended.
 * `null` means the session is in no room at all, and then there is nothing to keep.
 */
export const retainedRegistry = (
  registry: RoomInboxRegistry,
  conversationId: string,
  room: string | null,
): RoomInboxRegistry => {
  const held = registry[conversationId];
  if (!held || held.room === room) return registry;
  const { [conversationId]: _left, ...rest } = registry;
  return rest;
};

/**
 * A room code rather than a session's own mailbox name.
 *
 * Deliberately looser than the alphabet the bridge mints from (which leaves out the
 * characters that read alike): all this has to do is tell a four-character room code
 * apart from a conversation id, which is a UUID. Tying it to the exact alphabet would
 * make a change there silently stop this from recognising rooms at all.
 */
const SYNC_CODE = /^sync-[a-z0-9]{4}$/i;

/**
 * Drop what belongs to rooms that no longer exist.
 *
 * `retainedRegistry` above is the same idea for one session, and it only ever runs for
 * the session whose detail is open — which is not where the unread chip is. A room
 * closing while its session sat unopened in the list left the chip claiming messages for
 * a conversation that had ended, and nothing would clear it until somebody happened to
 * click that session.
 *
 * `openRooms` must come from a listing that actually answered: an empty one means every
 * room ended, and a failed read looks exactly the same from here. Only sync rooms are
 * judged — a private mailbox is named after its session and is not in the room listing to
 * be missing from.
 */
export const retainOpenRooms = (
  registry: RoomInboxRegistry,
  openRooms: ReadonlySet<string>,
  takenAt: number,
): RoomInboxRegistry => {
  const dead = Object.keys(registry).filter((conversationId) => {
    const held = registry[conversationId];
    const room = held?.room;
    if (typeof room !== "string" || !SYNC_CODE.test(room) || openRooms.has(room)) return false;
    // A listing speaks only for when it was taken. A room made after it is missing from
    // it because it did not exist yet, not because it ended — and deleting on that reads
    // a brand-new room's first message as the last word of a room that is over. So the
    // listing has to be newer than everything it is about to throw away.
    const newest = held.messages.reduce((latest, message) => Math.max(latest, Date.parse(message.at) || 0), 0);
    return takenAt > newest;
  });
  if (dead.length === 0) return registry;
  const next = { ...registry };
  for (const conversationId of dead) delete next[conversationId];
  return next;
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
      const next = recordMessage(current, conversationId, {
        seq: data.seq,
        room: data.room,
        from: data.from,
        fromLabel: data.fromLabel,
        kind: data.kind,
        preview: data.preview,
        at: lastLiveEvent.timestamp,
      });
      if (next !== current) write(next);
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

  /**
   * Keep only what belongs to the room this session is in now.
   *
   * Messages outlive rooms otherwise: leaving one left its replies sitting under the
   * session, counted as unread and shown in a tab, for a conversation that had ended.
   * `null` means the session is in no room at all, and then there is nothing to keep.
   */
  const retain = useCallback((conversationId: string, room: string | null) => {
    setRegistry((current) => {
      const next = retainedRegistry(current, conversationId, room);
      if (next !== current) write(next);
      return next;
    });
  }, []);

  /** Clear every session whose room has ended, not only the one on screen. */
  const pruneClosedRooms = useCallback((openRooms: ReadonlySet<string>, takenAt: number) => {
    setRegistry((current) => {
      const next = retainOpenRooms(current, openRooms, takenAt);
      if (next !== current) write(next);
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

  return { inbox: registry, markRead, retain, pruneClosedRooms, forget };
};
