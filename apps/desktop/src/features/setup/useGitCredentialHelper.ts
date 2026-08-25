import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

interface ICredentialHelperStatus {
  installed: boolean;
  path: string;
}

export interface IUseGitCredentialHelper {
  installed: boolean | null;
  path: string | null;
  busy: boolean;
  error: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
}

export const useGitCredentialHelper = (canUseNativeControls: boolean): IUseGitCredentialHelper => {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((status: ICredentialHelperStatus) => {
    setInstalled(status.installed);
    setPath(status.path || null);
  }, []);

  useEffect(() => {
    if (!canUseNativeControls) return;
    void invoke<ICredentialHelperStatus>("github_credential_helper_status")
      .then(apply)
      .catch(() => setInstalled(false));
  }, [canUseNativeControls, apply]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      apply(await invoke<ICredentialHelperStatus>(enabled ? "github_credential_helper_enable" : "github_credential_helper_disable"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [apply]);

  return { installed, path, busy, error, setEnabled };
};
