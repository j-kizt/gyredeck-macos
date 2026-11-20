import { invoke } from "@tauri-apps/api/core";
import { Check, Gauge, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

/** `heavy_patterns`: the commands observed out of the box, and the person's own (#245). */
export interface IHeavyPatterns {
  defaults: string[];
  custom: string[];
}

export interface IUseHeavyPatterns {
  patterns: IHeavyPatterns | null;
  error: string | null;
  busy: boolean;
  save: (custom: string[]) => Promise<boolean>;
  clearError: () => void;
}

const useHeavyPatterns = (canUseNativeControls: boolean): IUseHeavyPatterns => {
  const [patterns, setPatterns] = useState<IHeavyPatterns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canUseNativeControls) return;
    invoke<IHeavyPatterns>("heavy_patterns").then(setPatterns, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [canUseNativeControls]);

  const save = useCallback(async (custom: string[]) => {
    setBusy(true);
    try {
      setPatterns(await invoke<IHeavyPatterns>("set_heavy_patterns", { patterns: custom }));
      setError(null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { patterns, error, busy, save, clearError };
};

// The editor's two buttons, as the approved frames draw them (owner, 2026-11-20): one place to
// change their words or icons, so the row and its test cannot disagree about them.
const OPEN_EDITOR = { icon: Plus, label: "Add", ariaLabel: "Add a heavy command" } as const;
const SAVE_PATTERN = { icon: Check, label: "Save" } as const;

/**
 * The commands observed outside the helper (#245): the defaults, and the person's own to add and
 * remove. Changed only behind its button, the way Bridge port is (#376): until it is pressed
 * nothing in the row can be changed, so the person's own patterns stay listed but their Remove
 * buttons show only while the editor is open.
 */
const HeavyPatternsRow = ({ canUseNativeControls, children }: { canUseNativeControls: boolean; children?: ReactNode }) => {
  const heavy = useHeavyPatterns(canUseNativeControls);
  const [field, setField] = useState("");
  const [editing, setEditing] = useState(false);
  const custom = heavy.patterns?.custom ?? [];
  // Opening starts clean: an earlier refusal or half-typed pattern is not this attempt's.
  const toggleEditor = () => {
    setField("");
    heavy.clearError();
    setEditing((open) => !open);
  };
  const add = async () => {
    const pattern = field.trim();
    if (!pattern) return;
    if (await heavy.save([...custom, pattern])) {
      setField("");
      setEditing(false);
    }
  };
  const OpenIcon = OPEN_EDITOR.icon;
  const SaveIcon = SAVE_PATTERN.icon;
  return (
    <div className="setup-row setup-row-stack" data-heavy-patterns="">
      <div className="setup-row-main">
        <span className="status-slot"><Gauge className="setup-icon" size={14} strokeWidth={2.3} /></span>
        <span className="setup-copy">
          <span className="setup-title">Heavy commands</span>
          <span className="setup-detail">{heavy.error ?? (heavy.patterns ? heavy.patterns.defaults.join(" · ") : "Checking…")}</span>
        </span>
        {canUseNativeControls ? (
          <button className="pill-btn" type="button" onClick={toggleEditor} disabled={!heavy.patterns} data-tauri-drag-region="false" aria-expanded={editing} aria-label={OPEN_EDITOR.ariaLabel}>
            <OpenIcon size={12} strokeWidth={2.3} />{OPEN_EDITOR.label}
          </button>
        ) : null}
      </div>
      {children}
      {custom.map((pattern) => (
        <span className="setup-row-actions full" key={pattern}>
          <span className="setup-detail" data-heavy-pattern={pattern}>{pattern}</span>
          {editing ? (
            <button className="pill-btn danger" type="button" disabled={heavy.busy} onClick={() => void heavy.save(custom.filter((other) => other !== pattern))} data-tauri-drag-region="false" aria-label={`Remove ${pattern}`}>
              <Trash2 size={12} strokeWidth={2.3} />Remove
            </button>
          ) : null}
        </span>
      ))}
      {editing ? (
        <span className="setup-row-actions full">
          <input className="setup-input" type="text" value={field} placeholder="make check" onChange={(event) => setField(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void add(); }} disabled={heavy.busy} data-tauri-drag-region="false" aria-label="Heavy command pattern" autoFocus />
          <button className="pill-btn accent" type="button" onClick={() => void add()} disabled={heavy.busy || field.trim() === ""} data-tauri-drag-region="false">
            <SaveIcon size={12} strokeWidth={2.3} />{SAVE_PATTERN.label}
          </button>
        </span>
      ) : null}
    </div>
  );
};

export default HeavyPatternsRow;
