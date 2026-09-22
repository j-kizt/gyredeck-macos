import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openEventLog } from "../adapters/bridge/gyredeck-bridge.mjs";

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
