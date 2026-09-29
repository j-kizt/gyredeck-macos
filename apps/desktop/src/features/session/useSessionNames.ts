import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The names the person has typed for particular sessions.
 *
 * A session is otherwise named after the folder it is working in, and that moves: drive a
 * session into a subdirectory and the row you were watching is suddenly called something
 * else. A typed name is the one that holds still, and it is the only way to tell apart
 * several sessions of an agent the bridge has not been able to identify — they are all
 * "Agent" until something says otherwise.
 *
 * Fetched once. Names change when this window changes them and at no other time, so
 * polling would be a request every few seconds to learn nothing; the map is kept in step
 * locally as the person edits.
 */
export const useSessionNames = (canUseNativeControls: boolean) => {
  const [names, setNames] = useState<Record<string, string>>({});
  // How many names this window has set. The first read is a snapshot of a moment that may
  // already be past by the time it arrives: rename something while it is in flight and
  // the snapshot would land on top and put the old name back.
  const written = useRef(0);

  useEffect(() => {
    if (!canUseNativeControls) return;
    let cancelled = false;
    const before = written.current;
    invoke<Record<string, string>>("session_names")
      .then((value) => {
        if (cancelled || written.current !== before) return;
        setNames(value ?? {});
      })
      // A name nobody could read is a name nobody sees, and the session keeps the one it
      // was already going by. Nothing here is worth an error in front of the person.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [canUseNativeControls]);

  /**
   * Give one session a name, or take its name back with an empty string.
   *
   * Applied from what the bridge kept rather than from what was typed — it trims, flattens
   * and caps — so the field cannot show a name the session does not actually have.
   */
  const rename = useCallback(async (conversationId: string, name: string) => {
    const kept = await invoke<string | null>("set_session_name", { conversationId, name });
    written.current += 1;
    setNames((current) => {
      const next = { ...current };
      if (kept) next[conversationId] = kept;
      else delete next[conversationId];
      return next;
    });
    return kept ?? null;
  }, []);

  return { names, rename };
};
