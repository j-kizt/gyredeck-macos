import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GyredeckEvent } from "@gyredeck/protocol";

export type NotificationPermission =
  | "notDetermined"
  | "denied"
  | "authorized"
  | "provisional"
  | "ephemeral"
  | "unsupported";

export interface INotificationSettings {
  /** An agent is waiting on an answer it cannot continue without. */
  attention: boolean;
  /** Somebody addressed this session in a sync room. */
  roomMessage: boolean;
}

export interface INotificationsState extends INotificationSettings {
  permission: NotificationPermission;
  /** Why the last attempt failed, or null. Shown rather than swallowed. */
  error: string | null;
  requestPermission: () => Promise<void>;
  setAttention: (enabled: boolean) => void;
  setRoomMessage: (enabled: boolean) => void;
}

const STORAGE_KEY = "gyredeck.notifications";

const readSettings = (): INotificationSettings => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return { attention: true, roomMessage: true };
    const parsed = JSON.parse(stored) as Partial<INotificationSettings>;
    return {
      attention: parsed.attention !== false,
      roomMessage: parsed.roomMessage !== false,
    };
  } catch {
    return { attention: true, roomMessage: true };
  }
};

const writeSettings = (settings: INotificationSettings) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The running app still owns the state; losing the preference is not worth an error.
  }
};

/** One line, no newlines, short enough for a banner to show whole. */
const trim = (text: string | null | undefined, limit = 140): string => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/**
 * Turn events into macOS notifications, for the moments a person is not looking.
 *
 * Decided here rather than in Rust because this is where the event stream already
 * arrives: closing the window hides it instead of destroying it, so the webview keeps
 * running and keeps its subscription. Reading the stream a second time on the native
 * side would be the same rule implemented twice, which is how two other paths in this
 * codebase drifted apart in a single day.
 *
 * Nothing is posted while the window is on screen. A banner for something already
 * visible is the kind of notification people turn off, and turning it off costs the
 * ones that mattered too.
 */
export const useNotifications = ({
  lastLiveEvent,
  canUseNativeControls,
}: {
  lastLiveEvent: GyredeckEvent | null;
  canUseNativeControls: boolean;
}): INotificationsState => {
  const [settings, setSettings] = useState<INotificationSettings>(readSettings);
  const [permission, setPermission] = useState<NotificationPermission>("notDetermined");
  const [error, setError] = useState<string | null>(null);
  // Read inside the effect without making it a dependency: re-running on every toggle
  // would replay the event that happens to be current and post it twice.
  const settingsRef = useRef(settings);
  const deliveredRef = useRef<string | null>(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!canUseNativeControls) return;
    let cancelled = false;
    void (async () => {
      try {
        const state = await invoke<NotificationPermission>("notification_permission_state");
        if (!cancelled) setPermission(state);
      } catch {
        if (!cancelled) setPermission("unsupported");
      }
    })();
    return () => { cancelled = true; };
  }, [canUseNativeControls]);

  const requestPermission = useCallback(async () => {
    setError(null);
    try {
      setPermission(await invoke<NotificationPermission>("request_notification_permission"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!canUseNativeControls || !lastLiveEvent) return;
    // The same event object can arrive again as other state settles; an id is the only
    // thing that says "already dealt with", and posting twice is the visible failure.
    if (deliveredRef.current === lastLiveEvent.id) return;

    const current = settingsRef.current;
    const conversationId = lastLiveEvent.conversationId ?? "";
    let plan: { identifier: string; title: string; body: string } | null = null;

    if (lastLiveEvent.type === "attention_requested" && current.attention) {
      const data = lastLiveEvent.data;
      plan = {
        // One slot per session and per reason: a session that asks twice replaces its
        // own banner rather than stacking, and its answer is still the newest question.
        identifier: `gyredeck.attention.${conversationId}`,
        title: data.kind === "approval" ? "An agent needs approval" : "An agent has a question",
        body: trim(data.message) || trim(data.toolName) || "Open Gyredeck to answer.",
      };
    } else if (lastLiveEvent.type === "room_message" && current.roomMessage) {
      const data = lastLiveEvent.data;
      plan = {
        identifier: `gyredeck.room.${conversationId}`,
        title: `${data.fromLabel} in ${data.room}`,
        body: trim(data.preview) || "Open Gyredeck to read it.",
      };
    }
    if (!plan) return;

    deliveredRef.current = lastLiveEvent.id;
    void (async () => {
      try {
        // Asked at the moment of posting rather than tracked: focus changes without
        // telling this hook, and a stale answer here is a banner over the window the
        // person is already reading.
        if (await getCurrentWindow().isVisible()) return;
      } catch {
        // Unable to tell — err towards notifying. A missed notification is the failure
        // nobody can see; a redundant one is merely annoying.
      }
      try {
        await invoke("deliver_notification", plan);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [canUseNativeControls, lastLiveEvent]);

  const update = useCallback((patch: Partial<INotificationSettings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      writeSettings(next);
      return next;
    });
  }, []);

  return {
    ...settings,
    permission,
    error,
    requestPermission,
    setAttention: (enabled: boolean) => update({ attention: enabled }),
    setRoomMessage: (enabled: boolean) => update({ roomMessage: enabled }),
  };
};
