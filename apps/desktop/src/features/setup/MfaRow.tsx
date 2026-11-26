import { useCallback, useEffect, useState } from "react";
import { Check, ShieldCheck, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

type MfaState = "off" | "settingUp" | "on" | "locked" | "unreadable";

const MFA_DETAIL: Record<MfaState, string> = {
  off: "Ask for a code from an authenticator app before anything you approve from outside this Mac goes through",
  settingUp: "Setup was not finished. Set it up again",
  on: "On. Anything you approve from outside this Mac waits for a code",
  locked: "Locked after three wrong codes. Nothing can be approved until you unlock it",
  unreadable: "The saved secret cannot be read. Set it up again",
};

/**
 * Multi-factor authentication (#207, moved to Settings → Connection → Security in #376): set up
 * here once with a QR code, and checked by the app when an approval arrives from outside this
 * Mac. The secret is shown only while setting up. It stands on its own, apart from the Discord
 * connector, so it says its own failures rather than borrowing the bot row's.
 */
export const MfaRow = ({ canUseNativeControls }: { canUseNativeControls: boolean }) => {
  const [state, setState] = useState<MfaState | null>(null);
  const [setup, setSetup] = useState<{ svg: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const read = useCallback(async () => {
    setState(await invoke<MfaState>("discord_approvals").catch(() => null));
  }, []);
  useEffect(() => { if (canUseNativeControls) void read(); }, [canUseNativeControls, read]);

  const run = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    setBusy(true);
    setFailure(null);
    try {
      return await invoke(command, args);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      await read();
      setBusy(false);
    }
  };

  const start = async () => {
    setSetup(((await run("discord_approvals_setup")) as { svg: string; secret: string } | undefined) ?? null);
  };
  const confirm = async () => {
    const value = code.trim();
    setCode("");
    if ((await run("discord_approvals_confirm", { code: value })) !== undefined) setSetup(null);
  };

  const remove = async () => {
    setConfirming(false);
    await run("discord_approvals_remove");
  };

  return (
    <div className="setup-row setup-row-stack" data-mfa="row">
      <div className="setup-row-main">
        <span className="status-slot setup-icon"><ShieldCheck size={14} strokeWidth={2.3} /></span>
        <span className="setup-copy">
          <span className="setup-title">Multi-factor authentication</span>
          <span className="setup-detail">{!canUseNativeControls ? "Desktop runtime required" : setup ? "Scan this with an authenticator app, then type the code it shows. It is shown only now" : state ? MFA_DETAIL[state] : "Checking…"}</span>
        </span>
        {!canUseNativeControls || !state ? null : state === "locked" && !setup ? (
          <button className="pill-btn" type="button" disabled={busy} onClick={() => void run("discord_approvals_unlock")} data-tauri-drag-region="false">Unlock</button>
        ) : confirming && state === "on" && !setup ? null : (
          <>
            <button className="pill-btn" type="button" disabled={busy} onClick={() => void start()} data-tauri-drag-region="false">{setup ? "Start over" : state === "on" ? "Reset" : "Set up"}</button>
            {state === "on" && !setup ? (
              <button className="pill-btn danger icon-only" type="button" disabled={busy} onClick={() => setConfirming(true)} aria-label="Remove multi-factor authentication" title="Remove" data-tauri-drag-region="false"><Trash2 size={12} strokeWidth={2.3} /></button>
            ) : null}
          </>
        )}
      </div>
      {failure ? <span className="setup-detail" role="alert" data-mfa="failure">{failure}</span> : null}
      {confirming && state === "on" && !setup ? (
        <>
          <span className="setup-detail" role="alert" data-mfa="confirm">Remove multi-factor authentication? The codes in your authenticator app stop working, and approvals sent from outside this Mac are refused until you set it up again.</span>
          <span className="setup-row-actions">
            <button className="pill-btn" type="button" disabled={busy} onClick={() => setConfirming(false)} data-tauri-drag-region="false">Cancel</button>
            <button className="pill-btn danger" type="button" disabled={busy} onClick={() => void remove()} data-tauri-drag-region="false"><Trash2 size={12} strokeWidth={2.3} />Remove</button>
          </span>
        </>
      ) : null}
      {setup ? (
        <>
          <img className="setup-qr" src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.svg)}`} width={192} height={192} alt="Multi-factor authentication QR" />
          <span className="setup-detail setup-secret" aria-label="Multi-factor authentication secret">{setup.secret}</span>
          <span className="setup-row-actions full">
            <input className="setup-input" value={code} onChange={(event) => setCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void confirm(); }} disabled={busy} inputMode="numeric" autoComplete="one-time-code" spellCheck={false} placeholder="6-digit code" aria-label="Multi-factor authentication" data-tauri-drag-region="false" />
            <button className="pill-btn accent" type="button" disabled={busy || !code.trim()} onClick={() => void confirm()} data-tauri-drag-region="false"><Check size={12} strokeWidth={2.3} />Turn on</button>
          </span>
        </>
      ) : null}
    </div>
  );
};
