import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export interface IMailRoom {
  room: string;
  seq: number;
  /** Provider names of the sessions put into this room; empty for a plain mailbox. */
  members: string[];
  /** The session that created the room, and the only one that may close it. */
  founder: string | null;
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
export interface IMailRoomsState {
  rooms: Record<string, IMailRoom>;
  /**
   * Whether `rooms` is a current answer rather than a blank or a stale one.
   *
   * Three states collapse into one record otherwise — a real listing, a failed read, and
   * a reading nobody is refreshing any more — and the difference decides whether "this
   * room is not in the list" means the room ended or means nothing was asked. False
   * while polling is stopped, and false again after any read that failed. Anything that
   * acts on a room's *absence* must wait for this.
   */
  loaded: boolean;
  /**
   * When this listing was *asked for*, as epoch milliseconds. Zero while there is none.
   *
   * A listing can only speak for the moment it was taken. A room created after it is
   * missing from it for a reason that has nothing to do with having ended, so anything
   * acting on absence has to compare the two.
   */
  takenAt: number;
}

export const useMailRooms = ({
  active,
  canUseNativeControls,
}: {
  active: boolean;
  canUseNativeControls: boolean;
}): IMailRoomsState => {
  const [rooms, setRooms] = useState<Record<string, IMailRoom>>({});
  const [loaded, setLoaded] = useState(false);
  const [takenAt, setTakenAt] = useState(0);

  useEffect(() => {
    if (!active || !canUseNativeControls) {
      // A listing stops being an answer the moment we stop asking for it. Leaving
      // `loaded` true here left the last reading looking current while the app was on
      // another tab — and anything acting on a room's *absence* would then act on a
      // listing taken before that room existed.
      setLoaded(false);
      return;
    }
    let cancelled = false;

    const read = async () => {
      // Stamped before the call, not after it. What comes back describes the bridge at
      // the moment it was asked, and a room made while the answer was in flight is
      // missing from it for that reason alone. Timing the arrival instead would date the
      // listing later than messages it never knew about, and anything acting on absence
      // would then throw those messages away.
      const askedAt = Date.now();
      try {
        const next = await invoke<IMailRoom[]>("mail_rooms");
        if (cancelled) return;
        const entries = Array.isArray(next) ? next : [];
        setRooms(Object.fromEntries(entries.map((room) => [room.room, room])));
        setLoaded(true);
        setTakenAt(askedAt);
      } catch {
        // A bridge that predates mail rooms answers 404, and one that is still
        // starting answers nothing. Clear rather than keep the last reading: showing
        // mail as waiting when it may already have been delivered is worse than
        // showing nothing.
        if (!cancelled) {
          setRooms({});
          setLoaded(false);
        }
      }
    };

    void read();
    const timer = window.setInterval(read, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, canUseNativeControls]);

  return { rooms, loaded, takenAt };
};
