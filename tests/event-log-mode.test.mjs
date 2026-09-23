import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openEventLog,
  readRecentEvents,
  rotateEventLog,
  rotatedLogPath,
} from "../adapters/bridge/gyredeck-bridge.mjs";

/**
 * The event log is a record of what every agent on this machine was doing and where —
 * a `conversationId`, `cwd`, `model` and `permissionMode` on every line. It was created by
 * whatever appended to it first, under the umask, and arrived at `0644` while the ingest
 * token beside it was `0600`.
 *
 * These ask about files on disk rather than about a copy of the rule.
 */
const modeOf = (path) => statSync(path).mode & 0o777;

const withTempDir = (run) => {
  const dir = mkdtempSync(join(tmpdir(), "gyredeck-log-mode-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a log that did not exist is created private to this user", () => {
  withTempDir((dir) => {
    const logFile = join(dir, "nested", "gyredeck.events.ndjson");
    const log = openEventLog(logFile);
    try {
      assert.equal(log.enabled, true, log.why ?? "");
      assert.equal(modeOf(logFile), 0o600);
    } finally {
      log.close();
    }
  });
});

test("a log left world-readable by an older bridge is narrowed, and keeps what it holds", () => {
  // The case every existing machine is in: the file is already there at 0644, and nothing
  // else would ever narrow it.
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    const existing = '{"type":"turn_start","conversationId":"abc"}\n';
    writeFileSync(logFile, existing);
    chmodSync(logFile, 0o644);
    assert.equal(modeOf(logFile), 0o644, "the fixture has to start wide or it proves nothing");

    const log = openEventLog(logFile);
    try {
      assert.equal(log.enabled, true, log.why ?? "");
      assert.equal(modeOf(logFile), 0o600);
      assert.equal(readFileSync(logFile, "utf8"), existing);
    } finally {
      log.close();
    }
  });
});

test("what the bridge appends lands in the log", () => {
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    const log = openEventLog(logFile);
    try {
      log.append('{"type":"turn_start"}\n');
      log.append('{"type":"turn_complete"}\n');
    } finally {
      log.close();
    }
    assert.equal(readFileSync(logFile, "utf8"), '{"type":"turn_start"}\n{"type":"turn_complete"}\n');
  });
});

test("a log path that is a symlink is refused, and nothing is written through it", () => {
  // `O_NOFOLLOW` is what stops the log being pointed at another file that would then
  // inherit 0600 and every event the bridge writes.
  withTempDir((dir) => {
    const target = join(dir, "somewhere-else");
    writeFileSync(target, "");
    const logFile = join(dir, "gyredeck.events.ndjson");
    symlinkSync(target, logFile);

    const log = openEventLog(logFile);
    try {
      assert.equal(log.enabled, false);
      assert.match(log.why, /gyredeck\.events\.ndjson/);
      log.append('{"type":"turn_start"}\n');
    } finally {
      log.close();
    }

    assert.equal(readFileSync(target, "utf8"), "", "the symlink's target must be untouched");
  });
});

test("a log path that is not a regular file is refused rather than written to", () => {
  // Presence is not worth a leak: the earlier version of this swallowed a failed chmod and
  // appended anyway, leaving the file as wide as it had been. A directory standing where
  // the log should be is the reachable version of "cannot be confirmed as a private
  // regular file" — no root needed to arrange it.
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    mkdirSync(logFile);

    const log = openEventLog(logFile);
    try {
      assert.equal(log.enabled, false);
      assert.match(log.why, /gyredeck\.events\.ndjson/);
      log.append('{"type":"turn_start"}\n');
    } finally {
      log.close();
    }

    assert.equal(statSync(logFile).isDirectory(), true, "and it is left as it was found");
  });
});

test("a log path that opens but is not a regular file is refused before a line is written", () => {
  // The case the `fstat` check exists for, and the one the directory test above cannot
  // reach: `/dev/null` opens without complaint, reports mode 0666, and is a character
  // device. Swallowing this — as the first version of the fix did — would leave the bridge
  // appending to something it had failed to make private.
  const log = openEventLog("/dev/null");
  try {
    assert.equal(log.enabled, false, "a character device is not a log");
    assert.match(log.why, /dev\/null/);
  } finally {
    log.close();
  }
});

test("a line far larger than a write buffer lands whole", () => {
  // Not a proof against a partial write — a regular file on this filesystem will not give
  // one on demand, and nothing portable forces it. It pins the contract instead: what goes
  // in comes out complete, so an `append` that started reporting bytes rather than writing
  // them all would have to keep this passing.
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    const line = `${JSON.stringify({ type: "turn_start", text: "x".repeat(2_000_000) })}\n`;
    const log = openEventLog(logFile);
    try {
      log.append(line);
    } finally {
      log.close();
    }
    const written = readFileSync(logFile, "utf8");
    assert.equal(written, line);
    assert.equal(JSON.parse(written).type, "turn_start", "and it still parses as one JSON object");
  });
});

test("a closed log takes nothing more, and does not complain about it", () => {
  // The file contents alone do not pin this: appending to a closed descriptor throws
  // `EBADF`, which `append` catches, so nothing lands either way. What separates a log that
  // knows it is closed from one that finds out the hard way is the line of stderr — every
  // event after shutdown would print one.
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    const complaints = [];
    const wasError = console.error;
    console.error = (...args) => complaints.push(args.join(" "));
    try {
      const log = openEventLog(logFile);
      log.append('{"type":"turn_start"}\n');
      log.close();
      log.append('{"type":"turn_complete"}\n');
      log.close();
    } finally {
      console.error = wasError;
    }
    assert.equal(readFileSync(logFile, "utf8"), '{"type":"turn_start"}\n');
    assert.deepEqual(complaints, [], "a closed log is not an error to write to, it is a no-op");
  });
});

/**
 * The log had no bound at all. On the machine this was written for it had reached 21 MB and
 * 42,000 lines, and the only thing that had ever shortened it was somebody deleting it.
 */
const event = (id) => `${JSON.stringify({ version: 2, id, type: "turn_start", data: {} })}\n`;

test("a log past its cap is moved aside, and the next open starts an empty one", () => {
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    // Over the real cap, and world-readable the way a log written before v1.16.2 is.
    writeFileSync(logFile, `${"x".repeat(8 * 1024 * 1024)}\n`);
    chmodSync(logFile, 0o644);

    const log = openEventLog(logFile);
    try {
      assert.equal(log.enabled, true, log.why ?? "");
      assert.equal(statSync(logFile).size, 0, "the live log starts empty");
      assert.equal(modeOf(logFile), 0o600);
      // It was narrowed on the descriptor *before* being renamed, so the generation moved
      // aside is private without anything having reached for it by name afterwards.
      assert.equal(modeOf(rotatedLogPath(logFile)), 0o600);
      assert.equal(statSync(rotatedLogPath(logFile)).size, 8 * 1024 * 1024 + 1, "kept, not truncated");
    } finally {
      log.close();
    }
  });
});

test("a log under its cap is left exactly where it is", () => {
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    writeFileSync(logFile, "x".repeat(100));
    const log = openEventLog(logFile);
    try {
      assert.equal(existsSync(rotatedLogPath(logFile)), false);
      assert.equal(statSync(logFile).size, 100);
    } finally {
      log.close();
    }
  });
});

test("a symlink is refused even when what it points at is past the cap", () => {
  // The first version rotated before opening, so `statSync` followed the link, `renameSync`
  // moved the link, and `chmodSync` reached through it to change the target's mode — the
  // exact thing `O_NOFOLLOW` exists to refuse, undone by the housekeeping in front of it.
  // Codex reproduced it; the symlink test that existed used a small file and never reached
  // rotation at all.
  withTempDir((dir) => {
    const target = join(dir, "somebody-elses-file");
    writeFileSync(target, `${"x".repeat(8 * 1024 * 1024)}\n`);
    chmodSync(target, 0o644);
    const logFile = join(dir, "gyredeck.events.ndjson");
    symlinkSync(target, logFile);

    const log = openEventLog(logFile);
    try {
      assert.equal(log.enabled, false, "a symlinked log is refused whatever its size");
      log.append(`${JSON.stringify({ version: 2, id: "x", type: "turn_start" })}\n`);
    } finally {
      log.close();
    }

    assert.equal(modeOf(target), 0o644, "and nothing reached through it to change the target");
    assert.equal(existsSync(rotatedLogPath(logFile)), false, "nor moved it aside");
    assert.equal(statSync(target).size, 8 * 1024 * 1024 + 1, "nor wrote to it");
  });
});

test("the event that crossed the cap is still there to hydrate from", () => {
  // It is appended to the file that is then moved aside, so the live log can be empty while
  // the newest events sit in the rotated generation. Reading only the live log meant a
  // bridge restarting at that moment came up having forgotten what it was just told.
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    const crossing = `${JSON.stringify({ version: 2, id: "crossing-newest", type: "turn_complete" })}\n`;
    // Sized to land the log ten bytes *under* the cap, so it is the crossing event that
    // carries it over — which is what puts that event in the file about to be moved aside.
    // A filler already past the cap rotates before the crossing event is written and proves
    // nothing, which is what the first version of this fixture did.
    const envelope = `${JSON.stringify({ version: 2, id: "filler", type: "turn_start", pad: "" })}\n`.length;
    const filler = `${JSON.stringify({
      version: 2,
      id: "filler",
      type: "turn_start",
      pad: "x".repeat(8 * 1024 * 1024 - envelope - 10),
    })}\n`;

    const log = openEventLog(logFile);
    try {
      log.append(filler);
      log.append(crossing);
    } finally {
      log.close();
    }

    assert.ok(filler.length < 8 * 1024 * 1024, "the filler alone must not reach the cap");
    assert.ok(existsSync(rotatedLogPath(logFile)), "the fixture has to have rotated");
    const read = readRecentEvents(logFile, 10);
    assert.ok(
      read.some((entry) => entry.id === "crossing-newest"),
      `the crossing event must survive the rotation, got ${JSON.stringify(read.map((e) => e.id))}`,
    );
  });
});

test("an event larger than the tail window is still the one you get back", () => {
  // `/ingest` puts no ceiling on how long an event may be, so the newest line can be longer
  // than the window. Dropping it as a partial line would answer "nothing" to a question
  // about the newest thing that happened.
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    const small = `${JSON.stringify({ version: 2, id: "older", type: "turn_start" })}\n`;
    const huge = `${JSON.stringify({ version: 2, id: "enormous", type: "turn_complete", pad: "y".repeat(200_000) })}\n`;
    writeFileSync(logFile, small + huge);

    const read = readRecentEvents(logFile, 10, 1_024);
    assert.deepEqual(read.map((entry) => entry.id), ["older", "enormous"]);
  });
});

test("only the tail of a long log is read back, and never a half line", () => {
  // The read starts in the middle of whatever line it lands in. That line is dropped on
  // purpose: repairing it would mean reading further back, and it is older than what was
  // asked for anyway.
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    const lines = Array.from({ length: 500 }, (_, i) => event(`event-${i}`));
    writeFileSync(logFile, lines.join(""));

    // A tail far smaller than the file, and not aligned to any line boundary.
    const read = readRecentEvents(logFile, 10, 777);
    assert.equal(read.length, 10);
    assert.equal(read.at(-1).id, "event-499", "the newest event is the last one");
    assert.ok(read.every((entry) => typeof entry.id === "string"), "and nothing half-parsed got through");

    // And bounded by the tail rather than by the file: asked for more events than the tail
    // can hold, it still only returns what was in the tail. Reading the whole file would
    // hand back all five hundred, which is the cost this exists to stop.
    const asked = readRecentEvents(logFile, 500, 777);
    assert.ok(asked.length < 20, `the read must be bounded by the tail, got ${asked.length} of 500`);
    assert.equal(asked.at(-1).id, "event-499");
  });
});

test("a log smaller than the tail is read whole", () => {
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    writeFileSync(logFile, [event("first"), event("second")].join(""));
    const read = readRecentEvents(logFile, 500, 1_048_576);
    assert.deepEqual(read.map((entry) => entry.id), ["first", "second"], "including its very first line");
  });
});

test("an empty log, and one that is not there, read as nothing", () => {
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    assert.deepEqual(readRecentEvents(logFile, 10), []);
    writeFileSync(logFile, "");
    assert.deepEqual(readRecentEvents(logFile, 10), []);
  });
});

test("a log that cannot be rotated stops being written to, rather than growing forever", () => {
  // The rename is what bounds the file, so a directory that allows writing but not renaming
  // has no bound at all — the bridge would close its descriptor, fail to rotate, reopen the
  // same oversized file and append to it once per event, forever. Codex reproduced that:
  // `enabled=true, before=8388608, after=8388610`.
  withTempDir((dir) => {
    const logFile = join(dir, "gyredeck.events.ndjson");
    const filler = `${"x".repeat(8 * 1024 * 1024)}\n`;
    writeFileSync(logFile, filler);
    chmodSync(logFile, 0o600);
    // Readable and traversable, but nothing may be created or renamed in it.
    chmodSync(dir, 0o500);

    try {
      const log = openEventLog(logFile);
      const before = statSync(logFile).size;
      try {
        assert.equal(log.enabled, false, "a log that cannot be rotated is not written to");
        assert.match(log.why, /gyredeck\.events\.ndjson/);
        log.append('{"type":"turn_start"}\n');
      } finally {
        log.close();
      }
      assert.equal(statSync(logFile).size, before, "and not one byte was added to it");
    } finally {
      // Or the directory cannot be cleaned up.
      chmodSync(dir, 0o700);
    }
  });
});
