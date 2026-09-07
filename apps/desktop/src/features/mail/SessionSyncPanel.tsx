import { Check, Copy, Link2, Link2Off } from "lucide-react";
import { useEffect, useState } from "react";
import type { ISessionSummary } from "../session/types";
import { useSyncRoom } from "./useSyncRoom";

/**
 * Connecting one session to another, and nothing else.
 *
 * This is wiring, not a conversation: the person puts two sessions in a room, says
 * what each is for, and steps back. There is no message list and no compose box on
 * purpose — the exchange happens in the agents' own terminals, and a person in the
 * middle of it is the thing being designed out.
 */
export const SessionSyncPanel = ({
  session,
  canUseNativeControls,
}: {
  session: ISessionSummary;
  canUseNativeControls: boolean;
}) => {
  const { room, members, busy, error, canAct, create, join, leave, clearError } = useSyncRoom({
    conversationId: session.conversationId,
    canUseNativeControls,
  });
  const [mode, setMode] = useState<"idle" | "joining">("idle");
  const [code, setCode] = useState("");
  const [role, setRole] = useState("");
  const [copied, setCopied] = useState(false);

  const mine = members.find((member) => member.you);
  // The role field starts from whatever this session already told the room, so editing
  // it does not begin by wiping it.
  useEffect(() => {
    setRole(mine?.role ?? "");
  }, [mine?.role]);

  useEffect(() => {
    if (!room) return;
    setMode("idle");
    setCode("");
  }, [room]);

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

  if (!canUseNativeControls) {
    return (
      <section className="session-sync" aria-labelledby="session-sync-heading">
        <div className="session-sync-head"><span id="session-sync-heading">Sync</span></div>
        <p className="session-sync-note">Browser demo cannot connect sessions.</p>
      </section>
    );
  }

  return (
    <section className="session-sync" aria-labelledby="session-sync-heading" data-connected={Boolean(room)}>
      <div className="session-sync-head">
        <span id="session-sync-heading">Sync</span>
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
              {copied ? <Check size={11} strokeWidth={2.6} /> : <Copy size={11} strokeWidth={2.3} />}
            </button>
            <button
              className="session-sync-icon"
              type="button"
              onClick={() => void leave()}
              disabled={busy}
              data-tauri-drag-region="false"
              title="Disconnect from this room"
              aria-label="Disconnect from sync room"
            >
              <Link2Off size={11} strokeWidth={2.3} />
            </button>
          </span>
        ) : null}
      </div>

      {room ? (
        <>
          <ul className="session-sync-members">
            {members.map((member) => (
              <li className="session-sync-member" key={member.conversationId} data-you={member.you}>
                <span className="session-sync-provider">{member.you ? "This session" : member.provider}</span>
                <span className="session-sync-role">{member.role || "no role set"}</span>
                {member.pending > 0 && !member.you ? (
                  <span className="session-sync-pending" title={`${member.pending} waiting to be collected`}>
                    {member.pending}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <input
            className="session-sync-input"
            value={role}
            placeholder="What is this session for?"
            disabled={busy}
            onChange={(event) => setRole(event.target.value)}
            onBlur={() => { if (room && role !== (mine?.role ?? "")) void join(room, role); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && room) void join(room, role);
            }}
            aria-label="This session's role in the room"
          />
        </>
      ) : mode === "joining" ? (
        <div className="session-sync-row">
          <input
            className="session-sync-input"
            value={code}
            placeholder="Room code"
            disabled={busy}
            autoFocus
            onChange={(event) => { setCode(event.target.value); clearError(); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void join(code, role);
              if (event.key === "Escape") { setMode("idle"); clearError(); }
            }}
            aria-label="Room code to join"
          />
          <button
            className="session-sync-btn primary"
            type="button"
            onClick={() => void join(code, role)}
            disabled={busy || code.trim().length === 0}
            data-tauri-drag-region="false"
          >
            Connect
          </button>
        </div>
      ) : (
        <div className="session-sync-row">
          <button
            className="session-sync-btn"
            type="button"
            onClick={() => void create(role)}
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
            ? "Messages between members arrive in each session's own terminal."
            : "Put this session in a room with another, then say what each is for."}
      </p>
    </section>
  );
};
