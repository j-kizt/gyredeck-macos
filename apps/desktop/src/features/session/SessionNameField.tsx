import { Check, Pencil, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The session's name in the detail header, and the way to change it.
 *
 * In the header because that is where the name is read. It reads as a title carrying a
 * pencil, and only becomes a field when that is clicked — the first version of this put
 * an always-open text box in the body, above the sync controls, which is both a place
 * nobody looks for a name and a place something else was already doing a job.
 *
 * Without a name of its own a session is called after the folder it is working in, and
 * that moves: send an agent into a subdirectory and the title changes under the person
 * reading it. Clearing the field gives that name back, so there is nothing to undo.
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
  /** What it is called when it has no name of its own. */
  fallback: string;
  onRename: (conversationId: string, name: string) => Promise<string | null>;
}) => {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  // Which session is being edited. Selecting another one while a name is half typed must
  // not carry the half-typed name across to it.
  const subject = useRef(conversationId);
  // Escape closes the field, and closing is what saves. Without this the save behind it
  // would carry the very draft Escape was pressed to abandon.
  const abandoned = useRef(false);

  useEffect(() => {
    if (subject.current !== conversationId) {
      subject.current = conversationId;
      setEditing(false);
      setError(null);
    }
    setDraft(name);
  }, [conversationId, name]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = async () => {
    if (abandoned.current) { abandoned.current = false; setDraft(name); setEditing(false); return; }
    setEditing(false);
    if (draft.trim() === name.trim()) return;
    const target = conversationId;
    // Held until the answer comes back, and the title is not clickable meanwhile. Without
    // it the field could be reopened and retyped while the first save was still in
    // flight, and that save's answer — the kept name — would land on top of what was
    // being typed. The session guard below only catches a *different* session.
    setSaving(true);
    try {
      // What comes back is what was kept, which is not always what was typed: it is
      // trimmed, flattened and capped. Showing the typed version would leave the header
      // disagreeing with every other place the name appears.
      const kept = await onRename(target, draft);
      if (subject.current !== target) return;
      setDraft(kept ?? "");
      setError(null);
    } catch (failure) {
      if (subject.current !== target) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (subject.current === target) setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        className="header-title header-title-named"
        type="button"
        title={error ?? (saving ? "Saving…" : "Rename this session")}
        data-error={error ? "" : undefined}
        data-saving={saving ? "" : undefined}
        disabled={saving}
        data-tauri-drag-region="false"
        // Escape sets the abandoned flag and the blur it triggers clears it again.
        // Clearing it here too is the belt: a flag left standing from a previous edit
        // turns the next save into a cancel, silently.
        onClick={() => { abandoned.current = false; setError(null); setEditing(true); }}
      >
        <span className="header-title-text">{name || fallback}</span>
        {/* The name it would go by on its own, kept in view beside the one it was given —
            a session renamed "the audit one" is still the one working in a particular
            checkout, and that is the thing a person matches against a terminal window. */}
        {name ? <span className="header-title-derived">({fallback})</span> : null}
        <Pencil className="header-title-pencil" size={11} strokeWidth={2.3} />
      </button>
    );
  }

  return (
    <span className="header-title header-title-editing">
      <input
        ref={input}
        className="header-title-input"
        type="text"
        value={draft}
        placeholder={fallback}
        aria-label="Name for this session"
        spellCheck={false}
        autoFocus
        data-tauri-drag-region="false"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            // Kept here. Escape on this surface means "back to the session list", and
            // without this the field and the whole detail view went at once — abandoning
            // a half-typed name should leave the person where they were.
            event.stopPropagation();
            abandoned.current = true;
            event.currentTarget.blur();
          }
        }}
      />
      {/* Pressed rather than tabbed to, so the blur that saves has not fired yet — the
          mousedown default is prevented to keep the field focused until the click lands. */}
      <button
        className="header-title-action"
        type="button"
        title="Save"
        data-tauri-drag-region="false"
        onMouseDown={(event) => event.preventDefault()}
        onClick={commit}
      >
        <Check size={12} strokeWidth={2.6} />
      </button>
      <button
        className="header-title-action"
        type="button"
        title="Cancel"
        data-tauri-drag-region="false"
        onMouseDown={(event) => event.preventDefault()}
        // Does its own undoing, so it has no need of the flag — and setting one here left
        // it standing, because the prevented blur means `commit` never runs to clear it.
        onClick={() => { setDraft(name); setEditing(false); }}
      >
        <X size={12} strokeWidth={2.6} />
      </button>
    </span>
  );
};
