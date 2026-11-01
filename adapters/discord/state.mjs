import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

const { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync } = fs;

// The one reader and the one writer of the state file. Neither follows a link: a symlink
// planted at the state path or at a temp name would otherwise have its target read or
// overwritten with this user's rights (#199, the #230 class).

const empty = () => ({ v: 1, rooms: {} });

/**
 * The state, and what was done if the file could not be used. A file that is there but is
 * not a state file is never read as "no rooms" in silence: it is moved aside to
 * `<path>.bad-<ms>` and `aside` names it, so the caller can say so. Posts are found again
 * by their marker line.
 */
export function readState(path, { now = Date.now } = {}) {
  let fd = null;
  let text;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return { state: empty(), aside: null, blocked: "not a regular file" };
    text = readFileSync(fd, "utf8");
  } catch (error) {
    // Only an absent file is a fresh start. A link, or one that cannot be read, is `blocked`:
    // the caller must not save over what it could not read.
    if (error?.code === "ENOENT") return { state: empty(), aside: null, blocked: null };
    return { state: empty(), aside: null, blocked: error?.code === "ELOOP" ? "it is a link" : error?.code ?? "unreadable" };
  } finally {
    if (fd !== null) closeSync(fd);
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.v === 1 && parsed.rooms && typeof parsed.rooms === "object" && !Array.isArray(parsed.rooms)) {
      return { state: parsed, aside: null, blocked: null };
    }
  } catch {}
  const aside = `${path}.bad-${now()}`;
  try {
    renameSync(path, aside);
  } catch {
    return { state: empty(), aside: path, blocked: "it could not be moved aside" };
  }
  return { state: empty(), aside, blocked: null };
}

export function loadState(path) {
  return readState(path).state;
}

// Written whole to a fresh, unguessable sibling — created, never opened if it exists, never
// through a link, private from the first byte — every byte written, synced, then renamed
// over, so a crash or a full disk never leaves half a file that the next start would read as
// "no rooms". Renaming replaces a link at `path`, never its target.
export function saveState(path, state, { writeSync = fs.writeSync } = {}) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  let fd = null;
  let created = false;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    for (let at = 0; at < bytes.length; ) {
      const written = writeSync(fd, bytes, at, bytes.length - at);
      if (!(written > 0)) throw new Error("the state file could not be written in full");
      at += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    // Only a temp this call made is removed; anything else at that name is not ours.
    if (created) {
      try { unlinkSync(tmp); } catch {}
    }
    throw error;
  }
}
