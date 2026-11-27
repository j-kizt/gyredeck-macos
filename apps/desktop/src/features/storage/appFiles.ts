import { invoke } from "@tauri-apps/api/core";

/**
 * The caches the app rewrites often, kept in files in the desktop app (#300), as the session
 * registry is (#280): WebKit never checkpointed the localStorage WAL while the app ran, so
 * every rewrite grew it until a restart.
 *
 * Read once before the first render, then served from memory, so callers stay synchronous.
 * Saves are spaced (one per name every two seconds at most), skipped when nothing changed,
 * and sent at once when the page is left. A browser build keeps using localStorage.
 *
 * One rule decides every path: the file is replaced only by a value made from what it holds
 * (#300 audit, two rounds). So, per name, this run:
 * - `file`: the file was read. If there was none, the old localStorage copy is moved in and
 *   removed only after the file holds it. If there was one, it wins, and a localStorage copy
 *   beside it (a crash between save and removal, or an older version of the app) is removed.
 * - `memory`: the file could not be read or the app did not answer. Nothing is saved anywhere
 *   this run: a value built without the file's content must never replace it, in the file or
 *   in a localStorage copy a later run would take in. This run's changes end with it.
 */
export const APP_FILES = {
  "room-inbox": "gyredeck.room-inbox",
  "github-status-cache": "gyredeck.github.status-cache",
  "usage-snapshots": "gyredeck.usage-snapshots.v1",
} as const;

export type AppFileName = keyof typeof APP_FILES;
type Place = "file" | "memory";
type Loaded = { state: "absent" } | { state: "ok"; text: string } | { state: "unreadable"; reason: string };

const SAVE_SPACING_MS = 2_000;
const LOAD_TIMEOUT_MS = 3_000;
const NAMES = Object.keys(APP_FILES) as AppFileName[];

const place = new Map<AppFileName, Place>();
const held = new Map<AppFileName, string | null>();
/** The last value sent to the file, or read from it: what the file holds once saves settle. */
const sent = new Map<AppFileName, string | null>();
const timers = new Map<AppFileName, ReturnType<typeof setTimeout>>();
const saving = new Map<AppFileName, Promise<unknown>>();

/** A browser build, which has no app to ask, keeps localStorage. */
const inBrowser = () => typeof window.__TAURI_INTERNALS__ === "undefined";

const legacyRead = (name: AppFileName) => {
  try {
    return window.localStorage.getItem(APP_FILES[name]);
  } catch {
    return null;
  }
};

const legacyDrop = (name: AppFileName) => {
  try {
    window.localStorage.removeItem(APP_FILES[name]);
  } catch {
    // The file is what is read from now on.
  }
};

const sendSave = (name: AppFileName) => {
  timers.delete(name);
  const text = held.get(name) ?? null;
  // Compared with what was last sent, not last confirmed: a change back to the file's value
  // while another save is in flight must still be sent after it (#300 audit).
  if (place.get(name) !== "file" || text === null || text === sent.get(name)) return;
  sent.set(name, text);
  // One name's saves go one after another, so the last made is the last kept.
  const done = (saving.get(name) ?? Promise.resolve())
    .then(() => invoke("app_file_save", { name, text }))
    .then(() => legacyDrop(name))
    .catch(() => {
      // Still owed: what the file holds is unknown now, so the next try sends whatever is held.
      sent.delete(name);
      if (!timers.has(name)) timers.set(name, setTimeout(() => sendSave(name), SAVE_SPACING_MS));
    });
  saving.set(name, done);
};

const isLoaded = (value: unknown): value is Loaded => {
  const state = (value as { state?: unknown } | null)?.state;
  if (state === "ok") return typeof (value as { text?: unknown }).text === "string";
  return state === "absent" || state === "unreadable";
};

const loadOne = async (name: AppFileName): Promise<void> => {
  let loaded: unknown;
  try {
    loaded = await Promise.race([
      invoke<unknown>("app_file_load", { name }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer")), LOAD_TIMEOUT_MS)),
    ]);
  } catch {
    loaded = null;
  }
  if (!isLoaded(loaded) || loaded.state === "unreadable") {
    place.set(name, "memory");
    held.set(name, legacyRead(name));
    return;
  }
  place.set(name, "file");
  if (loaded.state === "ok") {
    sent.set(name, loaded.text);
    held.set(name, loaded.text);
    legacyDrop(name);
    return;
  }
  sent.set(name, null);
  held.set(name, legacyRead(name));
  sendSave(name);
};

let loading: Promise<void> | null = null;

/** Read every file once; the app renders after this settles. Never rejects. */
export const loadAppFiles = (): Promise<void> => {
  if (inBrowser()) return Promise.resolve();
  loading ??= Promise.all(NAMES.map((name) => loadOne(name).catch(() => void place.set(name, "memory")))).then(() => {
    window.addEventListener("pagehide", flushAppFiles);
  });
  return loading;
};

/** Send every pending save now. */
export const flushAppFiles = () => {
  for (const [name, timer] of timers) {
    clearTimeout(timer);
    sendSave(name);
  }
};

export const readAppFile = (name: AppFileName): string | null =>
  inBrowser() ? legacyRead(name) : held.get(name) ?? null;

export const writeAppFile = (name: AppFileName, text: string): void => {
  if (inBrowser()) {
    try {
      window.localStorage.setItem(APP_FILES[name], text);
    } catch {
      // The running app still holds the state.
    }
    return;
  }
  held.set(name, text);
  if (place.get(name) === "file" && !timers.has(name)) timers.set(name, setTimeout(() => sendSave(name), SAVE_SPACING_MS));
};
