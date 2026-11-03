import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { disconnectAll, type IDisconnectAllResult } from "./disconnectAll";

/** `discord_status()`, as the native side answers it (#199). */
export interface IDiscordStatus {
  configured: boolean;
  running: boolean;
  /** The current connector said ready and nothing since undid it; Connect is offered only then. */
  ready: boolean;
  bot: { id: string; username: string } | null;
  forums: Array<{ id: string; name: string; guildName?: string | null }>;
  forumId: string | null;
  owner: { id: string; username: string | null } | null;
  inviteUrl: string | null;
  connectedRooms: string[];
  /** Per connected room, lines handed to the bot that Discord has not yet accepted. */
  behind?: Record<string, number>;
  /** A saved token or owner macOS would not hand over, by which (#288). */
  keychainRefused?: Record<string, string>;
  /** Rooms the Discord member could not be taken out of, with why; kept after Remove. */
  leaving?: Record<string, string>;
  /** What Remove had to leave undelivered, per room; kept after Remove. */
  dropped?: Record<string, number>;
  /** Which those were, per room: seq ranges and senders ("#41–#43 from Codex"). */
  droppedLines?: Record<string, string>;
  pairingCode: string | null;
  error: { code: string; message: string } | null;
}

export interface IUseDiscord {
  status: IDiscordStatus | null;
  /** Why the last command failed, as the native side said it. */
  failure: string | null;
  busy: boolean;
  run: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Disconnect these rooms from Discord; what failed is kept until the next try (#205). */
  disconnectAll: (rooms: readonly string[]) => Promise<void>;
  stillConnected: IDisconnectAllResult["failed"];
}

const DISCORD_POLL_MS = 5_000;

/** Read every five seconds while Settings is mounted, so closing Settings stops it. */
export const useDiscord = (canUseNativeControls: boolean): IUseDiscord => {
  const [status, setStatus] = useState<IDiscordStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stillConnected, setStillConnected] = useState<IDisconnectAllResult["failed"]>([]);

  const read = useCallback(async () => {
    try {
      setStatus(await invoke<IDiscordStatus>("discord_status"));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    if (!canUseNativeControls) return;
    void read();
    const timer = window.setInterval(read, DISCORD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [canUseNativeControls, read]);

  const run = useCallback(async (command: string, args?: Record<string, unknown>) => {
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
  }, [read]);

  const disconnectEvery = useCallback(async (rooms: readonly string[]) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await disconnectAll(rooms, (code) => invoke("discord_disconnect", { code }));
      setStillConnected(result.failed);
    } finally {
      await read();
      setBusy(false);
    }
  }, [read]);

  return { status, failure, busy, run, disconnectAll: disconnectEvery, stillConnected };
};
