import { invoke } from "@tauri-apps/api/core";
import { Check, Gauge, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

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

  return { patterns, error, busy, save };
};

/** The commands observed outside the helper (#245): the defaults, and the person's own to add and remove. */
const HeavyPatternsRow = ({ canUseNativeControls }: { canUseNativeControls: boolean }) => {
  const heavy = useHeavyPatterns(canUseNativeControls);
  const [field, setField] = useState("");
  const custom = heavy.patterns?.custom ?? [];
  const add = async () => {
    const pattern = field.trim();
    if (!pattern) return;
    if (await heavy.save([...custom, pattern])) setField("");
  };
  return (
    <div className="setup-row setup-row-stack" data-heavy-patterns="">
      <div className="setup-row-main">
        <span className="status-slot"><Gauge className="setup-icon" size={14} strokeWidth={2.3} /></span>
        <span className="setup-copy">
          <span className="setup-title">Heavy commands</span>
          <span className="setup-detail">{heavy.error ?? (heavy.patterns ? heavy.patterns.defaults.join(" · ") : "Checking…")}</span>
        </span>
      </div>
      {custom.map((pattern) => (
        <span className="setup-row-actions full" key={pattern}>
          <span className="setup-detail" data-heavy-pattern={pattern}>{pattern}</span>
          <button className="pill-btn" type="button" disabled={heavy.busy} onClick={() => void heavy.save(custom.filter((other) => other !== pattern))} data-tauri-drag-region="false" aria-label={`Remove ${pattern}`}>
            <Trash2 size={12} strokeWidth={2.3} />Remove
          </button>
        </span>
      ))}
      <span className="setup-row-actions full">
        <input className="setup-input" type="text" value={field} placeholder="make check" onChange={(event) => setField(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void add(); }} disabled={heavy.busy || !heavy.patterns} data-tauri-drag-region="false" aria-label="Heavy command pattern" />
        <button className="pill-btn accent" type="button" onClick={() => void add()} disabled={heavy.busy || !heavy.patterns || field.trim() === ""} data-tauri-drag-region="false">
          <Check size={12} strokeWidth={2.3} />Add
        </button>
      </span>
    </div>
  );
};

export default HeavyPatternsRow;
