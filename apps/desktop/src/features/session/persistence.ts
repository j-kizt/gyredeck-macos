import { invoke } from "@tauri-apps/api/core";
import {
  DELETED_SESSIONS_STORAGE_KEY,
  DISMISSED_SESSIONS_STORAGE_KEY,
  SESSION_EVENTS_STORAGE_KEY,
} from "./constants";
import { isSessionEventRegistry, normalizeSessionEventRegistry } from "./eventRegistry";
import type {
  DeletedSessionRegistry,
  DismissedSessionRegistry,
  SessionEventRegistry,
} from "./types";

import { pruneSessionEventRegistry } from "./retention";

export {
  MAX_STORED_CONVERSATIONS,
  pruneSessionEventRegistry,
  pruneTombstones,
  SESSION_PRUNE_INTERVAL_MS,
  SESSION_RETENTION_MS,
} from "./retention";

const readLegacySessionEventRegistry = (): SessionEventRegistry => {
  try {
    const raw = window.localStorage.getItem(SESSION_EVENTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isSessionEventRegistry(parsed) ? normalizeSessionEventRegistry(parsed) : {};
  } catch {
    return {};
  }
};

const dropLegacySessionEventRegistry = () => {
  try {
    window.localStorage.removeItem(SESSION_EVENTS_STORAGE_KEY);
  } catch {
    // Nothing more to do: the file is what is read from now on.
  }
};

type LoadedSessionRegistry =
  | { state: "absent" }
  | { state: "ok"; revision: number; registry: unknown }
  | { state: "corrupt"; kept: string }
  | { state: "unreadable"; reason: string };

// The desktop app keeps the registry in a file (#280): localStorage was rewritten whole on
// almost every event and WebKit never checkpointed its WAL. A browser build keeps it in
// localStorage as before. In the desktop app, until the file has been read nothing is saved
// anywhere — not localStorage, whose copy a later run would lose to the file, and not the
// file, which a save before the read would replace with only what arrived since.
let registryStore: "local" | "file" | "unread" = "local";
let registrySaves: Promise<unknown> = Promise.resolve();

// One window's saves go one after another, so they reach the store in the order they were
// made; the store numbers them under its own lock.
const saveToFile = (registry: SessionEventRegistry) => {
  const saved = registrySaves.then(() => invoke<number>("session_registry_save", { registry }));
  registrySaves = saved.catch(() => undefined);
  return saved;
};

/**
 * Read the registry once, at start. From a file in the desktop app; the old localStorage
 * copy is moved into the file and removed only after the file is durably written, so a
 * crash at any step leaves one readable copy. A file that cannot be read was moved aside
 * by the app and is never treated as an empty registry over the old copy.
 */
export type LoadedRegistry =
  | { ready: true; registry: SessionEventRegistry; stored: boolean }
  | { ready: false; problem: string };

export const loadSessionEventRegistry = async (now = new Date()): Promise<LoadedRegistry> => {
  const inMemory = (registry: SessionEventRegistry, stored: boolean): LoadedRegistry => ({ ready: true, registry, stored });
  if (typeof window.__TAURI_INTERNALS__ === "undefined") {
    return inMemory(pruneSessionEventRegistry(readLegacySessionEventRegistry(), now), true);
  }
  registryStore = "unread";
  let loaded: LoadedSessionRegistry;
  try {
    loaded = await invoke<LoadedSessionRegistry>("session_registry_load");
  } catch (error) {
    return { ready: false, problem: String(error) };
  }
  if (loaded.state === "unreadable") return { ready: false, problem: loaded.reason };
  if (loaded.state === "ok") {
    // The store checks the same shape; an answer this side cannot accept is never replaced
    // by the old copy — it is treated as unreadable, and nothing is saved (#280 audit).
    if (!isSessionEventRegistry(loaded.registry)) {
      return { ready: false, problem: "the stored session history is not in a shape this version reads" };
    }
    registryStore = "file";
    dropLegacySessionEventRegistry();
    const registry = normalizeSessionEventRegistry(loaded.registry);
    const pruned = pruneSessionEventRegistry(registry, now);
    return inMemory(pruned, pruned === registry);
  }
  registryStore = "file";
  const legacy = pruneSessionEventRegistry(readLegacySessionEventRegistry(), now);
  if (Object.keys(legacy).length === 0) return inMemory(legacy, true);
  // `stored: false` keeps it owed: the presence hook saves it again until a save lands.
  return inMemory(legacy, await writeSessionEventRegistry(legacy));
};

/** Save the registry where it was loaded from; resolves false when the save failed. */
export const writeSessionEventRegistry = async (registry: SessionEventRegistry): Promise<boolean> => {
  if (registryStore === "unread") return false;
  if (registryStore === "file") {
    try {
      await saveToFile(registry);
      dropLegacySessionEventRegistry();
      return true;
    } catch {
      return false;
    }
  }
  try {
    window.localStorage.setItem(SESSION_EVENTS_STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // The in-memory registry remains available when persistence is unavailable.
  }
  return true;
};

const readTimestampRegistry = (
  key: string,
  allowLegacyArray: boolean,
): Record<string, number> => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (allowLegacyArray && Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed
          .filter((item): item is string => typeof item === "string")
          .map((id) => [id, 0]),
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    return {};
  }
};

const writeTimestampRegistry = (key: string, registry: Record<string, number>) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(registry));
  } catch {
    // The current runtime still owns the in-memory tombstones.
  }
};

export const readDismissedSessionIds = (): DismissedSessionRegistry =>
  readTimestampRegistry(DISMISSED_SESSIONS_STORAGE_KEY, true);

export const writeDismissedSessionIds = (registry: DismissedSessionRegistry) =>
  writeTimestampRegistry(DISMISSED_SESSIONS_STORAGE_KEY, registry);

export const readDeletedSessionIds = (): DeletedSessionRegistry =>
  readTimestampRegistry(DELETED_SESSIONS_STORAGE_KEY, false);

export const writeDeletedSessionIds = (registry: DeletedSessionRegistry) =>
  writeTimestampRegistry(DELETED_SESSIONS_STORAGE_KEY, registry);

const isRegistryEntryAfter = (
  registry: Record<string, number>,
  conversationId: string | null | undefined,
  latestEventAt: string | null | undefined,
) => {
  if (!conversationId || !latestEventAt || typeof registry[conversationId] !== "number") {
    return false;
  }
  const latestEventMs = Date.parse(latestEventAt);
  return Number.isFinite(latestEventMs) && registry[conversationId] >= latestEventMs;
};

export const isDismissedAfter = isRegistryEntryAfter;
export const isDeletedAfter = isRegistryEntryAfter;
