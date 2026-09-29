import { useEffect, useRef, useState } from "react";

/**
 * Give this session a name of your own.
 *
 * Without one a session is named after the folder it is working in, which moves under the
 * person reading it — drive an agent into a subdirectory and the row they were watching is
 * called something else. It is also the only way to tell apart several sessions of an agent
 * that has not identified itself, since those are all called the same thing.
 *
 * Empty clears it and the derived name comes back, so there is nothing to undo and no
 * separate way out.
 *
 * Length is not capped here. The bridge caps by character so an emoji is not cut in half;
 * `maxLength` counts UTF-16 units, so the field would have stopped accepting input at a
 * different point than the one the name is actually held to.
 */
export const SessionNameField = ({
  conversationId,
  name,
  fallback,
  onRename,
}: {
  conversationId: string;
  /** The name this session has been given, or empty if it is going by the derived one. */
  name: string;
  /** What it is called when it has no name of its own — shown as the placeholder. */
  fallback: string;
  onRename: (conversationId: string, name: string) => Promise<string | null>;
}) => {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  // Which session this draft belongs to. Selecting another session while one is half
  // typed must not carry the half-typed name across to it.
  const editing = useRef(conversationId);
  // Escape blurs the field, and blur is what saves. Without this the save that follows
  // would carry the very draft Escape was pressed to abandon — `setDraft` has not been
  // applied by the time `onBlur` runs.
  const abandoned = useRef(false);

  useEffect(() => {
    if (editing.current !== conversationId) {
      editing.current = conversationId;
      setDraft(name);
      setError(null);
      return;
    }
    setDraft(name);
  }, [conversationId, name]);

  const commit = async () => {
    if (abandoned.current) {
      abandoned.current = false;
      setDraft(name);
      return;
    }
    if (draft.trim() === name.trim()) return;
    // Which session this commit is for. The call is awaited, and the person can select
    // another session while it is in flight — applying the answer then would drop one
    // session's name into another's field, and its error under another's row.
    const target = conversationId;
    try {
      // What comes back is what was kept, which is not always what was typed: it is
      // trimmed, flattened and capped. Showing the typed version would leave the field
      // disagreeing with every other place the name appears.
      const kept = await onRename(target, draft);
      if (editing.current !== target) return;
      setDraft(kept ?? "");
      setError(null);
    } catch (failure) {
      if (editing.current !== target) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <div className="session-name-field">
      <input
        className="session-name-input"
        type="text"
        value={draft}
        placeholder={fallback}
        aria-label="Name for this session"
        spellCheck={false}
        data-tauri-drag-region="false"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          // Escape puts back what it was, which is the only way to abandon a half-typed
          // name without saving it on the way out.
          if (event.key === "Escape") { abandoned.current = true; event.currentTarget.blur(); }
        }}
      />
      {error ? <div className="session-name-error" role="status">{error}</div> : null}
    </div>
  );
};
