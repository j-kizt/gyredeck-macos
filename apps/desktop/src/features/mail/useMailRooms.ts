import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

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
