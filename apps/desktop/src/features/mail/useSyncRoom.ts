import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

export interface ISyncMember {
  conversationId: string;
  provider: string;
  /** Whether this member may speak in the room, not merely read it. */
  confirmed: boolean;
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
  /** False when the room could not be read at all, so acting on it would guess. */
  canAct: boolean;
  /** True when this session created the room, which is who may invite. */
  isFounder: boolean;
  /** Read the room's password, to hand to a session being let in. */
  issuePassword: () => Promise<string | null>;
  create: () => Promise<void>;
  join: (code: string) => Promise<void>;
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
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [founder, setFounder] = useState<string | null>(null);

  const apply = (next: { room: string | null; founder?: string | null; members: ISyncMember[] }) => {
    setRoom(next.room ?? null);
    setFounder(next.founder ?? null);
    setMembers(Array.isArray(next.members) ? next.members : []);
  };

  const read = useCallback(async () => {
    if (!conversationId || !canUseNativeControls) return;
    try {
      const next = await invoke<{ room: string | null; founder: string | null; members: ISyncMember[] }>("sync_room", {
        conversationId,
      });
      apply(next);
      setReadFailure(null);
      // A read that succeeds is the newer truth about the room, so a refusal from an
      // earlier action stops applying. Without this a 409 from Create stayed on screen
      // beside the very state it was complaining about.
      if (next.room) setError(null);
    } catch (cause) {
      // "No room" and "could not ask" have to stay distinguishable. Treating a failed
      // read as an empty room offers Create on a session that is already in one, and
      // the refusal that follows contradicts the buttons that invited it.
      apply({ room: null, members: [] });
      setReadFailure(cause instanceof Error ? cause.message : String(cause));
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
        const next = await invoke<{ room: string | null; founder: string | null; members: ISyncMember[] } | null>(command, {
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
    // An action's refusal is the more specific of the two and wins; a read that cannot
    // reach the bridge still has to say so rather than look like an empty room.
    error: error ?? readFailure,
    isFounder: founder !== null && founder === conversationId,
    issuePassword: async () => {
      if (!conversationId || !canUseNativeControls || !room) return null;
      setBusy(true);
      setError(null);
      try {
        return await invoke<string>("sync_issue_password", { code: room, conversationId });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    create: () => act("sync_create", {}),
    join: (code) => act("sync_join", { code: code.trim() }),
    leave: () => act("sync_leave", { code: room }),
    clearError: () => setError(null),
    canAct: readFailure === null,
  };
};
