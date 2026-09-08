import { Check, Copy, KeyRound, Link2, Link2Off } from "lucide-react";
import { useEffect, useState } from "react";
import type { ISessionSummary } from "../session/types";
import { useSyncRoom } from "./useSyncRoom";

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
  canUseNativeControls,
  hookInstalled,
}: {
  session: ISessionSummary;
  canUseNativeControls: boolean;
  /** Whether this session's own agent has the Gyredeck hook. Null while unknown. */
  hookInstalled: boolean | null;
}) => {
  const { room, busy, error, canAct, isFounder, issuePassword, create, join, leave, clearError } = useSyncRoom({
    conversationId: session.conversationId,
    canUseNativeControls,
  });
  const [mode, setMode] = useState<"idle" | "joining">("idle");
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [invited, setInvited] = useState(false);

  useEffect(() => {
    if (!room) return;
    setMode("idle");
    setCode("");
  }, [room]);

  // The key copies the room's password. It has to be typed into the terminal of the
  // session being let in — which is the point: the person authorises where the session
  // lives, not from another window. From then on that session presents it in the
  // x-gyredeck-token header of every read and every send: password and token are one
  // thing said two ways, so authorising and authenticating are the same act.
  const copyInvite = async () => {
    const password = await issuePassword();
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setInvited(true);
      window.setTimeout(() => setInvited(false), 1_600);
    } catch {
      // Denied clipboard access would leave the password minted and unusable, so say so
      // rather than pretending it was copied.
      window.prompt("Copy this room's password and paste it into the joining session", password);
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
            <span className="session-sync-code">{room}</span>
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
            {isFounder ? (
              <button
                className="session-sync-icon"
                type="button"
                onClick={() => void copyInvite()}
                disabled={busy}
                data-tauri-drag-region="false"
                title="Copy this room's password for a session you are inviting"
                aria-label="Copy this room's password"
              >
                {invited ? <Check size={13} strokeWidth={2.6} /> : <KeyRound size={13} strokeWidth={2.3} />}
              </button>
            ) : null}
            <button
              className="session-sync-icon danger"
              type="button"
              onClick={() => void leave()}
              disabled={busy}
              data-tauri-drag-region="false"
              title="Disconnect from this room"
              aria-label="Disconnect from sync room"
            >
              <Link2Off size={13} strokeWidth={2.3} />
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
              ? "Password copied — paste it into the joining session's terminal."
              : isFounder
                ? "Key copies this room's password. Paste it into a joining session to let it read and speak here."
                : "Messages between members arrive in each session's own terminal."
            : "Put this session in a room with another, then say what each is for."}
      </p>
    </section>
  );
};
