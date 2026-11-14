import { Check, Copy, Crown, DoorClosed, KeyRound, Link2, Link2Off } from "lucide-react";
import { useEffect, useState } from "react";
import type { ISessionSummary } from "../session/types";
import type { ISyncRoomState } from "./useSyncRoom";

/**
 * Connecting one session to another, and nothing else.
 *
 * This is wiring, not a conversation: the person puts two sessions in a room and steps
 * back. There is no message list, no compose box and no roster on purpose — the
 * exchange happens in the agents' own terminals, and a person in the middle of it is
 * the thing being designed out. What is left is the room's code and the two things
 * worth doing to it.
 */
export const SessionSyncPanel = ({
  session,
  sync,
  canUseNativeControls,
  hookInstalled,
}: {
  session: ISessionSummary;
  /** Read by whoever owns the detail view, so the tabs beside this cannot disagree with it. */
  sync: ISyncRoomState;
  canUseNativeControls: boolean;
  /** Whether this session's own agent has the Gyredeck hook. Null while unknown. */
  hookInstalled: boolean | null;
}) => {
  const { room, busy, error, canAct, isFounder, issueJoinCode, create, join, leave, clearError } = sync;
  const [mode, setMode] = useState<"idle" | "joining">("idle");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [invited, setInvited] = useState(false);

  useEffect(() => {
    if (!room) return;
    setMode("idle");
    setCode("");
  }, [room]);

  // The key copies a one-time join code for this session alone (#331). It has to be typed
  // into this session's own terminal — which is the point: the person proves which session
  // it is from where it lives, not from another window. The code works once, for two
  // minutes, and a new press kills the last one.
  const copyInvite = async () => {
    const joinCode = await issueJoinCode();
    if (!joinCode) return;
    try {
      await navigator.clipboard.writeText(joinCode);
      setInvited(true);
      window.setTimeout(() => setInvited(false), 1_600);
    } catch {
      // Denied clipboard access would leave the code minted and unusable, so say so
      // rather than pretending it was copied.
      window.prompt("Copy this session's join code and paste it into its terminal", joinCode);
    }
  };

  const copyCode = async () => {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      // Denied clipboard access is not worth an error row: the code is on screen.
    }
  };

  // Nothing here works without the hook for this particular agent: the room is joined
  // from the app, but every message is collected and answered by the hook. Offering to
  // connect a session that cannot hear the room would be offering a dead end, so the
  // panel is absent rather than disabled — unlike a setting, there is no state worth
  // showing.
  if (hookInstalled !== true) return null;

  if (!canUseNativeControls) {
    return (
      <section className="session-sync" aria-labelledby="session-sync-heading">
        <div className="session-sync-head"><span id="session-sync-heading">Sync session</span></div>
        <p className="session-sync-note">Browser demo cannot connect sessions.</p>
      </section>
    );
  }

  return (
    <section className="session-sync" aria-labelledby="session-sync-heading" data-connected={Boolean(room)}>
      <div className="session-sync-head">
        <span id="session-sync-heading">Sync session</span>
        {room ? (
          // Create already puts this session in the room, so there is nothing left to
          // confirm: the code and the two things worth doing with it are all there is.
          <span className="session-sync-room">
            <span className="session-sync-code" title={isFounder ? "You own this room" : undefined}>
              {isFounder ? <Crown size={11} strokeWidth={2.3} className="session-sync-crown" /> : null}
              {room}
            </span>
            <button
              className="session-sync-icon"
              type="button"
              onClick={() => void copyCode()}
              data-tauri-drag-region="false"
              title="Copy room code"
              aria-label={`Copy room code ${room}`}
            >
              {copied ? <Check size={13} strokeWidth={2.6} /> : <Copy size={13} strokeWidth={2.3} />}
            </button>
            <button
              className="session-sync-icon"
              type="button"
              onClick={() => void copyInvite()}
              disabled={busy}
              data-tauri-drag-region="false"
              title="Copy a one-time join code for this session"
              aria-label="Copy this session's join code"
            >
              {invited ? <Check size={13} strokeWidth={2.6} /> : <KeyRound size={13} strokeWidth={2.3} />}
            </button>
            {/* A room does not outlive its founder, so the founder's leave closes it for everyone. */}
            <button
              className="session-sync-icon danger"
              type="button"
              onClick={() => void leave()}
              disabled={busy}
              data-tauri-drag-region="false"
              title={isFounder ? "Close this room for everyone" : "Leave this room"}
              aria-label="Disconnect from sync room"
            >
              {isFounder ? <DoorClosed size={13} strokeWidth={2.3} /> : <Link2Off size={13} strokeWidth={2.3} />}
            </button>
          </span>
        ) : null}
      </div>

      {mode === "joining" && !room ? (
        <div className="session-sync-row">
          <input
            className="session-sync-input"
            value={code}
            placeholder="Room code"
            disabled={busy}
            autoFocus
            onChange={(event) => { setCode(event.target.value); clearError(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void join(code);
              if (event.key === "Escape") { setMode("idle"); clearError(); }
            }}
            aria-label="Room code to join"
          />
          <button
            className="session-sync-btn primary"
            type="button"
            onClick={() => void join(code)}
            disabled={busy || code.trim().length === 0}
            data-tauri-drag-region="false"
          >
            Connect
          </button>
        </div>
      ) : room ? null : (
        <div className="session-sync-row" data-split="true">
          <button
            className="session-sync-btn"
            type="button"
            onClick={() => void create()}
            disabled={busy || !canAct}
            data-tauri-drag-region="false"
          >
            <Link2 size={11} strokeWidth={2.3} />
            Create sync
          </button>
          <button
            className="session-sync-btn"
            type="button"
            onClick={() => { setMode("joining"); clearError(); }}
            disabled={busy || !canAct}
            data-tauri-drag-region="false"
          >
            Join sync
          </button>
        </div>
      )}

      <p className="session-sync-note" data-error={Boolean(error)} role={error ? "alert" : undefined}>
        {error
          ? error
          : room
            ? invited
              ? "Join code copied — paste it into this session's terminal within two minutes."
              : isFounder
                ? "You own this room. Closing it ends it for every member. Key copies a one-time join code for this session only."
                : "Leaving takes only this session out. The room stays open for the others. Key copies a one-time join code for this session only."
            : "Put this session in a room with another, then say what each is for."}
      </p>
    </section>
  );
};
