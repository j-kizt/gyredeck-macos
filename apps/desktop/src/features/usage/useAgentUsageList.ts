import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import {
  createCachedAgentUsageState,
  createAgentUsageState,
  createDemoAgentUsage,
  parseAgentUsageSnapshot,
  readCachedUsageSnapshots,
  retainLastGoodUsage,
  writeCachedUsageSnapshot,
} from "./adapters";
import { USAGE_PROVIDERS } from "./providers";
import type {
  IAgentUsageSnapshot,
  IAgentUsageState,
  IUsageProviderConfig,
  IUsageSettings,
  UsageProviderId,
} from "./types";

export interface IAgentUsageListResult {
  refresh: () => void;
  /** True while a refresh is in flight, so the control can say so. */
  refreshing: boolean;
  usages: Record<UsageProviderId, IAgentUsageState>;
}

const createInitialUsageStates = (settings: IUsageSettings): Record<
  UsageProviderId,
  IAgentUsageState
> => {
  const cached = readCachedUsageSnapshots();

  return Object.fromEntries(
    USAGE_PROVIDERS.map((provider) => {
      const snapshot = cached[provider.id];

      return [
        provider.id,
        snapshot
          ? createCachedAgentUsageState(provider.id, snapshot, settings)
          : createAgentUsageState(provider.id),
      ];
    }),
  ) as Record<UsageProviderId, IAgentUsageState>;
};

export const useAgentUsageList = (
  settings: IUsageSettings,
  demoMode: boolean,
): IAgentUsageListResult => {
  const settingsRef = useRef(settings);
  const [usages, setUsages] = useState(() => createInitialUsageStates(settings));
  const [snapshots, setSnapshots] = useState<
    Partial<Record<UsageProviderId, IAgentUsageSnapshot>>
  >({});
  const [tick, setTick] = useState(0);
  // Tracked separately from each provider's status: putting them into "loading" would
  // blank the numbers they are already showing, and a cached reading staying visible
  // through a refresh is the whole point of keeping it.
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const fetchProvider = async (
    provider: IUsageProviderConfig,
  ): Promise<void> => {
    if (demoMode) {
      setUsages((current) => ({
        ...current,
        [provider.id]: createDemoAgentUsage(provider),
      }));
      return;
    }

    if (typeof window.__TAURI_INTERNALS__ === "undefined") {
      setSnapshots((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
      setUsages((current) => ({
        ...current,
        [provider.id]: createAgentUsageState(provider.id, {
          status: "offline",
          message: "Gyredeck desktop runtime needed",
        }),
      }));
      return;
    }

    try {
      const snapshot = await invoke<IAgentUsageSnapshot>(provider.command);
      const next = parseAgentUsageSnapshot(
        provider.id,
        snapshot,
        settingsRef.current,
      );
      if (next.status === "online") {
        writeCachedUsageSnapshot(provider.id, snapshot);
        setSnapshots((current) => ({
          ...current,
          [provider.id]: snapshot,
        }));
      }
      setUsages((current) => ({
        ...current,
        [provider.id]: next.status === "error" && next.message
          ? retainLastGoodUsage(current[provider.id], provider.id, next.message, next)
          : next,
      }));
    } catch (error) {
      setUsages((current) => ({
        ...current,
        [provider.id]: retainLastGoodUsage(
          current[provider.id],
          provider.id,
          error instanceof Error
            ? error.message
            : String(error || `${provider.label} usage unavailable`),
        ),
      }));
    }
  };

  const refresh = (): void => {
    setRefreshing(true);
    void Promise.all(USAGE_PROVIDERS.map((provider) => fetchProvider(provider))).finally(() => {
      setRefreshing(false);
    });
  };

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, settings.refreshMs);
    return () => window.clearInterval(timer);
  }, [settings.refreshMs]);

  useEffect(() => {
    if (settings.resetMode !== "relative") {
      return;
    }

    const timer = window.setInterval(
      () => setTick((value) => value + 1),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, [settings.resetMode]);

  useEffect(() => {
    if (!Object.keys(snapshots).length) {
      return;
    }

    setUsages((current) => {
      const next = { ...current };

      for (const provider of USAGE_PROVIDERS) {
        const snapshot = snapshots[provider.id];
        if (snapshot && current[provider.id].status !== "error") {
          next[provider.id] = parseAgentUsageSnapshot(
            provider.id,
            snapshot,
            settings,
          );
        }
      }

      return next;
    });
  }, [
    tick,
    settings.resetMode,
    settings.timeFormat,
    settings.usageMode,
    snapshots,
  ]);

  return { refresh, refreshing, usages };
};
