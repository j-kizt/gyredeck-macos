import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

export interface ISyncMember {
  conversationId: string;
  provider: string;
  role: string;
  pending: number;
  you: boolean;
}

export interface ISyncRoomState {
  room: string | null;
  members: ISyncMember[];
  /** True while a create, join or leave is in flight. */
  busy: boolean;
  /** A refusal worth putting next to the field that caused it, or null. */
  error: string | null;
  create: (role: string) => Promise<void>;
  join: (code: string, role: string) => Promise<void>;
  leave: () => Promise<void>;
  clearError: () => void;
}

const POLL_INTERVAL_MS = 5_000;

/**
 * The sync room one session is in, and the three things a person can do about it.
 *
 * Polled rather than streamed: the room only changes when someone acts on it, from
 * this panel or from another session's, and a few seconds of lag on "who else joined"
 * costs nothing. Every call goes through the native side, so the ingest token stays
 * where it already lives.
 */
export const useSyncRoom = ({
  conversationId,
  canUseNativeControls,
}: {
  conversationId: string | null;
  canUseNativeControls: boolean;
}): ISyncRoomState => {
  const [room, setRoom] = useState<string | null>(null);
  const [members, setMembers] = useState<ISyncMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (next: { room: string | null; members: ISyncMember[] }) => {
    setRoom(next.room ?? null);
    setMembers(Array.isArray(next.members) ? next.members : []);
  };

  const read = useCallback(async () => {
    if (!conversationId || !canUseNativeControls) return;
    try {
      apply(await invoke("sync_room", { conversationId }));
    } catch {
      // A bridge that is starting, or one predating sync rooms, has no room to report.
      // Not an error to show: the panel simply offers to make one.
      apply({ room: null, members: [] });
    }
  }, [canUseNativeControls, conversationId]);

  useEffect(() => {
    setRoom(null);
    setMembers([]);
    setError(null);
    if (!conversationId || !canUseNativeControls) return;
    void read();
    const timer = window.setInterval(() => void read(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [canUseNativeControls, conversationId, read]);

  const act = useCallback(
    async (command: string, args: Record<string, unknown>) => {
      if (!conversationId || !canUseNativeControls) return;
      setBusy(true);
      setError(null);
      try {
        const next = await invoke<{ room: string | null; members: ISyncMember[] } | null>(command, {
          conversationId,
          ...args,
        });
        // Leaving answers with nothing, so re-read rather than guessing the new state.
        if (next && typeof next === "object" && "members" in next) apply(next);
        else await read();
      } catch (cause) {
        // The native side turns a refusal into a sentence: an unknown code, a session
        // already in another room. Showing it verbatim is the point.
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [canUseNativeControls, conversationId, read],
  );

  return {
    room,
    members,
    busy,
    error,
    create: (role) => act("sync_create", { role }),
    join: (code, role) => act("sync_join", { code: code.trim(), role }),
    leave: () => act("sync_leave", { code: room }),
    clearError: () => setError(null),
  };
};
