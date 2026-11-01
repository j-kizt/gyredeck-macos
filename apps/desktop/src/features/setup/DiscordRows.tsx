import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, KeyRound, MessageSquareDashed, RefreshCw, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { IUseDiscord } from "./useDiscord";

/** Lucide carries no brand marks, so the Discord logo is drawn here. */
export const DiscordLogo = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    <path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.25a18.3 18.3 0 0 0-5.49 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.7 19.7 0 0 0-4.88 1.52.07.07 0 0 0-.04.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .09-.03c.46-.63.87-1.3 1.22-1.99a.08.08 0 0 0-.04-.1 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1 0-.12l.37-.3a.07.07 0 0 1 .08-.01 14.2 14.2 0 0 0 12.06 0 .07.07 0 0 1 .08 0l.37.3a.08.08 0 0 1 0 .13c-.6.35-1.22.65-1.87.9a.08.08 0 0 0-.04.1c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .09.03 19.8 19.8 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Z" />
  </svg>
);

const ERROR_COPY: Record<string, string> = {
  bad_token: "Discord refused this token. Copy it again from your app's Bot page and save it here.",
  missing_intent: "Turn on Message Content Intent on your app's Bot page in the Discord Developer Portal.",
  missing_permission: "The bot is missing a permission in your server. Invite it again with the button below.",
  no_forum: "The bot can see no forum channel. Make one in your server, then pick it here.",
  rate_limited: "Discord is slowing the bot down. Messages go out as soon as it allows.",
  discord_down: "Can't reach Discord right now. Messages wait and go out in order when it is back.",
  room_unknown: "That room is no longer open, so it can't be followed.",
  pairing_locked: "Too many wrong codes were sent to the bot. Press Pair again for a new code.",
};

const errorCopy = (error: { code: string; message: string }) =>
  ERROR_COPY[error.code] ?? `The Discord connector stopped on an error: ${error.message}`;

/** Settings → Permission → Remote access (#199): a bot that follows sync rooms into a Discord forum. */
export const DiscordRows = ({ discord, canUseNativeControls }: { discord: IUseDiscord; canUseNativeControls: boolean }) => {
  const { status, failure, busy, run } = discord;
  const [token, setToken] = useState("");
  const [confirming, setConfirming] = useState(false);
  const autoPicked = useRef<string | null>(null);
  const bot = status?.bot ?? null;
  const forums = status?.forums ?? [];
  const onlyForum = bot && !status?.forumId && forums.length === 1 ? forums[0]!.id : null;

  // One forum leaves nothing to choose, so it is picked once rather than waiting for a click.
  useEffect(() => {
    if (!onlyForum || autoPicked.current === onlyForum) return;
    autoPicked.current = onlyForum;
    void run("discord_set_forum", { forumId: onlyForum });
  }, [onlyForum, run]);

  const save = () => {
    const value = token.trim();
    // Cleared before the call returns: the token is never left in the page, whatever happens.
    setToken("");
    if (value) void run("discord_set_token", { token: value });
  };

  const askToken = !status?.configured || status.error?.code === "bad_token";
  const detail = !canUseNativeControls ? "Desktop runtime required"
    : !status ? "Checking…"
    : !status.configured ? "Follow your sync rooms from Discord. Make an app at discord.com/developers, open Bot, copy its token and paste it here."
    : bot ? `Bot · ${bot.username}`
    : status.error ? "Not connected"
    : "Connecting…";

  return (
    <>
      <div className="setup-subheading">Remote access</div>
      <div className="setup-row setup-row-stack" data-discord="bot">
        <div className="setup-row-main">
          <span className="status-slot setup-icon"><DiscordLogo /></span>
          <span className="setup-copy">
            <span className="setup-title">Discord</span>
            <span className="setup-detail">{detail}</span>
            {status?.error ? <span className="setup-detail" role="status" data-discord-error={status.error.code}>{errorCopy(status.error)}</span> : null}
            {failure ? <span className="setup-detail" role="status">{failure}</span> : null}
            {confirming ? <span className="setup-detail" role="alert">Remove Discord? The bot stops and its token is deleted. Posts already in Discord stay there.</span> : null}
          </span>
          {status?.configured && !confirming ? (
            <button className="pill-btn danger" type="button" disabled={busy} onClick={() => setConfirming(true)} data-tauri-drag-region="false"><Trash2 size={12} strokeWidth={2.3} />Remove</button>
          ) : null}
        </div>
        {confirming ? (
          <span className="setup-row-actions">
            <button className="pill-btn" type="button" onClick={() => setConfirming(false)} data-tauri-drag-region="false">Cancel</button>
            <button className="pill-btn danger" type="button" disabled={busy} onClick={() => { setConfirming(false); void run("discord_remove"); }} data-tauri-drag-region="false">Remove Discord</button>
          </span>
        ) : canUseNativeControls && status && askToken ? (
          <span className="setup-row-actions full">
            <input className="setup-input" type="password" value={token} onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") save(); }} disabled={busy} autoComplete="off" spellCheck={false} placeholder="Bot token" aria-label="Discord bot token" data-tauri-drag-region="false" />
            <button className="pill-btn accent" type="button" disabled={busy || !token.trim()} onClick={save} data-tauri-drag-region="false"><Check size={12} strokeWidth={2.3} />Save</button>
          </span>
        ) : null}
      </div>
      {Object.entries(status?.leaving ?? {}).map(([room, reason]) => (
        // Shown with or without a token: the member still sits in the room, holding it up.
        <div className="setup-row" data-discord="leaving" key={`leaving-${room}`}>
          <span className="status-slot"><RefreshCw className="setup-icon" size={14} strokeWidth={2.3} /></span>
          <span className="setup-copy">
            <span className="setup-title">{`Discord is still in room ${room}`}</span>
            <span className="setup-detail">{`Could not leave: ${reason}`}</span>
          </span>
          <button className="pill-btn" type="button" disabled={busy} onClick={() => void run("discord_retry_leave", { code: room })} data-tauri-drag-region="false">Try leaving again</button>
        </div>
      ))}
      {(["behind", "dropped"] as const).flatMap((kind) => Object.entries(status?.[kind] ?? {}).map(([room, count]) => (
        <div className="setup-row passive" data-discord={kind} key={`${kind}-${room}`}>
          <span className="status-slot"><MessageSquareDashed className="setup-icon" size={14} strokeWidth={2.3} /></span>
          <span className="setup-copy">
            <span className="setup-title">{`Room ${room}`}</span>
            <span className="setup-detail">{`${count} message${count === 1 ? "" : "s"} ${kind === "behind" ? "waiting for" : "could not be sent to"} Discord${kind === "dropped" && status?.droppedLines?.[room] ? `: ${status.droppedLines[room]}` : ""}`}</span>
          </span>
        </div>
      )))}
      {bot && status ? (
        <>
          <div className="setup-row" data-discord="forum">
            <span className="status-slot"><MessageSquareDashed className="setup-icon" size={14} strokeWidth={2.3} /></span>
            <span className="setup-copy">
              <span className="setup-title">Forum</span>
              <span className="setup-detail">{forums.length > 0 ? "Each room you connect gets its own post here" : "No forum channel yet — invite the bot to a server that has one"}</span>
            </span>
            {forums.length > 0 ? (
              <select className="setup-select" value={status.forumId ?? ""} disabled={busy} onChange={(event) => void run("discord_set_forum", { forumId: event.target.value })} data-tauri-drag-region="false" aria-label="Discord forum">
                {status.forumId ? null : <option value="" disabled>Pick a forum</option>}
                {forums.map((forum) => <option key={forum.id} value={forum.id}>{forum.guildName ? `${forum.name} · ${forum.guildName}` : forum.name}</option>)}
              </select>
            ) : null}
          </div>
          <div className="setup-row" data-discord="invite">
            <span className="status-slot"><ExternalLink className="setup-icon" size={14} strokeWidth={2.3} /></span>
            <span className="setup-copy">
              <span className="setup-title">Invite the bot</span>
              <span className="setup-detail">Add it to the server that holds the forum</span>
            </span>
            {status.inviteUrl ? (
              <button className="pill-btn" type="button" onClick={() => void invoke("open_external_url", { url: status.inviteUrl }).catch(() => undefined)} data-tauri-drag-region="false">Invite the bot</button>
            ) : null}
          </div>
          <div className="setup-row" data-discord="owner">
            <span className="status-slot"><KeyRound className="setup-icon" size={14} strokeWidth={2.3} /></span>
            <span className="setup-copy">
              <span className="setup-title">{status.owner ? `Paired with ${status.owner.username ?? status.owner.id}` : status.pairingCode ? status.pairingCode : "Pair your Discord account"}</span>
              <span className="setup-detail">{status.owner ? "Only this account can use the bot" : status.pairingCode ? `Send this code to ${bot.username} in a direct message on Discord` : "So the bot answers only you"}</span>
            </span>
            {status.owner ? null : (
              <button className="pill-btn accent" type="button" disabled={busy} onClick={() => void run("discord_start_pairing")} data-tauri-drag-region="false">{busy ? <RefreshCw className="setup-spin" size={12} strokeWidth={2.3} /> : null}{status.pairingCode ? "New code" : "Pair"}</button>
            )}
          </div>
        </>
      ) : null}
    </>
  );
};
