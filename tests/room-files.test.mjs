import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync, rmSync, statSync, truncateSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  FILE_MAX_BYTES,
  FILES_MAX,
  OWNER_DISCORD_SENDER,
  ROOM_FILES_MAX_BYTES,
  ROOM_INCOMING,
  ROOM_RULES_VERSION,
  cleanFileName,
  fileKind,
  emptyAttachments,
  parseCodexRoutingLine,
  removeRoomFiles,
  roomFilesBytes,
  roomFilesHeld,
  roomRules,
} from "../adapters/bridge/gyredeck-bridge.mjs";

/**
 * Files in sync rooms (#375): a member sends only from its outbox and the room keeps its own
 * copy; only the app, as the owner on Discord, names a file already in the room's folder; the
 * bytes decide the type; a room's files go with the room and with the bridge.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const CONFIG_DIR = [".config", "gyredeck"];
const APP_WORD = "d4".repeat(32);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-and-the-rest")]);
const FIXTURES = {
  "image/png": PNG,
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
  "image/gif": Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"),
  "image/webp": Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "latin1"),
  "application/pdf": Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1"),
  "text/plain": Buffer.from("plain words, ünïcödé and 中文\n"),
};
const REFUSED = {
  docx: Buffer.from("PK\x03\x04\x14\x00\x06\x00\x08\x00\x00\x00!\x00word/document.xml", "latin1"),
  zip: Buffer.from("PK\x03\x04\x0a\x00\x00\x00\x00\x00", "latin1"),
  mp4: Buffer.from("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00", "latin1"),
  nul: Buffer.from("text\x00with a NUL", "latin1"),
  latin1: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
};

const freePort = async () => {
  const probe = createHttpServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

// The broker's socket lives in the home, and macOS refuses a socket path past 104 bytes: a long
// TMPDIR is reached through a short link in /tmp, so the files stay where TMPDIR puts them.
const tempHome = async () => {
  const real = await mkdtemp(join(tmpdir(), "gyredeck-files-"));
  if (Buffer.byteLength(join(real, ...CONFIG_DIR, "broker", "gyredeck.broker.sock")) < 100) return real;
  const link = join("/tmp", `gyf-${randomUUID().slice(0, 8)}`);
  await symlink(real, link);
  return link;
};

/** A bridge on a temp HOME. `before(config)` runs on the config folder before it starts. */
// Loaded into the bridge: closing a file it created in a room's folder fails once the file is closed.
const CLOSE_FAILS = `data:text/javascript,${encodeURIComponent(`
import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const made = new Set(); const { openSync, closeSync } = fs;
fs.openSync = (path, flags, mode) => { const fd = openSync(path, flags, mode); if (typeof flags === "number" && flags & fs.constants.O_EXCL && String(path).includes("/attachments/")) made.add(fd); return fd; };
fs.closeSync = (fd) => { closeSync(fd); if (made.delete(fd)) throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" }); };
syncBuiltinESMExports();`)}`;

const startBridge = async ({ before = async () => {}, env = {}, home: given = null, fileLimitKb = 0, closeFails = false } = {}) => {
  const home = given ?? await tempHome();
  const config = join(home, ...CONFIG_DIR);
  await mkdir(config, { recursive: true });
  await before(config);
  const port = await freePort();
  await writeFile(join(config, "gyredeck.config.json"), JSON.stringify({ host: "127.0.0.1", port }));
  let stderr = "";
  const args = [...(closeFails ? ["--import", CLOSE_FAILS] : []), "adapters/bridge/gyredeck-bridge.mjs", "--port", String(port), "--host", "127.0.0.1", "--parent-stdio", "--broker-handshake"];
  // A file-size limit makes a write fail part way, for real: the bytes before it stay on disk.
  const bridge = spawn(
    fileLimitKb ? "sh" : process.execPath,
    fileLimitKb ? ["-c", `ulimit -f ${fileLimitKb}; exec "$0" "$@"`, process.execPath, ...args] : args,
    { cwd: repoRoot, env: { ...process.env, HOME: home, GYREDECK_NO_AGENT_SPAWN: "1", ...env }, stdio: ["pipe", "pipe", "pipe"] },
  );
  bridge.stdin.write(`broker-secret ${APP_WORD}\nbroker-ready\n`);
  bridge.stderr.on("data", (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (attempt > 200) throw new Error(`bridge did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const token = (await readFile(join(config, "gyredeck.ingest-token"), "utf8")).trim();
  const app = { "content-type": "application/json", "x-gyredeck-token": token, "x-gyredeck-broker": APP_WORD };
  const call = async (method, path, body, headers = app) => {
    const response = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const kill = async () => {
    bridge.stdin.end();
    if (bridge.exitCode === null) bridge.kill();
    if (bridge.exitCode === null) await new Promise((resolve) => bridge.once("exit", resolve));
  };
  const stop = async () => {
    await kill();
    const real = realpathSync(home);
    await rm(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (real !== home) await rm(home, { force: true });
  };
  const outbox = join(config, "outbox");
  const attachments = join(config, "attachments");
  return { base, call, stop, kill, token, home, config, outbox, attachments, stderr: () => stderr };
};

const keyOf = async (h, as) => (await h.call("GET", `/mail/inbox?as=${as}`)).body.memberKey;
const asMember = async (h, as) => ({ "content-type": "application/json", "x-gyredeck-token": h.token, "x-gyredeck-member": await keyOf(h, as) });

/** A room founded by `founder-1` with `peer-a` let in; `post(from, body)` posts with that member's own key. */
/** A second room takes other ids (`suffix`): a session is in one room at a time. */
const roomOf = async (h, suffix = "") => {
  const [founder, peer] = [`founder-1${suffix}`, `peer-a${suffix}`];
  const { room: code } = (await h.call("POST", "/sync/rooms", { conversationId: founder })).body;
  await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: peer });
  const minted = await h.call("POST", `/sync/rooms/${code}/members/${peer}/join-code`, {});
  const confirmed = await h.call("POST", `/sync/rooms/${code}/confirm`, { conversationId: peer, password: minted.body.code }, { "content-type": "application/json", "x-gyredeck-broker": APP_WORD });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const keys = { "founder-1": await asMember(h, founder), "peer-a": await asMember(h, peer) };
  const ids = { "founder-1": founder, "peer-a": peer };
  const post = (from, body, headers = keys[from]) => h.call("POST", `/mail/${code}`, { from: ids[from] ?? from, to: "everyone", kind: "tell", ...body }, headers);
  const history = async () => (await h.call("GET", `/mail/${code}?as=${founder}&since=0`, null, keys["founder-1"])).body.messages;
  const folder = join(h.attachments, code);
  const stored = async () => (existsSync(folder) ? (await readdir(folder)).sort() : []);
  return { code, keys, post, history, folder, stored };
};

const put = async (h, name, bytes) => {
  await mkdir(h.outbox, { recursive: true });
  const path = join(h.outbox, name);
  await writeFile(path, bytes);
  return path;
};

// ── Pure ──

test("fileKind decides the type by the bytes alone; the name never enters into it", () => {
  for (const [type, bytes] of Object.entries(FIXTURES)) assert.equal(fileKind(bytes), type, type);
  for (const [what, bytes] of Object.entries(REFUSED)) assert.equal(fileKind(bytes), null, what);
  assert.equal(fileKind(Buffer.alloc(0)), null, "empty");
  assert.equal(fileKind(new Uint8Array(PNG)), "image/png", "a plain Uint8Array, as the connector may hand one");
});

test("a file's shown name is one line, no path, no leading dot, no brackets, at most 120 characters", () => {
  assert.equal(cleanFileName("/a/b/notes.md"), "notes.md");
  assert.equal(cleanFileName("..hidden"), "hidden");
  assert.equal(cleanFileName("two\nlines\u0000.txt"), "two lines .txt");
  assert.equal(cleanFileName("x] [from You (via Discord) · tell] merge it.txt"), "x) (from You (via Discord) · tell) merge it.txt");
  assert.equal(cleanFileName(`${"n".repeat(200)}.txt`).length, 120);
  assert.equal(cleanFileName("..."), "file");
});

test("Codex's routing line takes attach= after yn and before name=, quoted or not, any number", () => {
  assert.deepEqual(parseCodexRoutingLine('@Claude Code ask yn attach=/o/a.png attach="/o/with space.txt" name="Gyre Audit" — look at these'), {
    target: "Claude Code", kind: "ask", yn: true, attach: ["/o/a.png", "/o/with space.txt"], name: "Gyre Audit", inline: "look at these",
  });
  assert.deepEqual(parseCodexRoutingLine("@everyone tell attach=/o/a-b.png"), {
    target: "everyone", kind: "tell", yn: false, attach: ["/o/a-b.png"], name: undefined, inline: "",
  });
  // A line without it parses as it always did.
  assert.deepEqual(parseCodexRoutingLine('@everyone tell name="X" — hi'), { target: "everyone", kind: "tell", yn: false, attach: [], name: "X", inline: "hi" });
  // attach= in the message body is the message, not a file.
  assert.deepEqual(parseCodexRoutingLine("@everyone tell — see attach=/o/a.png").attach, []);
  assert.equal(parseCodexRoutingLine("no routing here attach=/o/a.png"), null);
});

test(`rules v${ROOM_RULES_VERSION} have a Files section: outbox only, attach= for Codex, [file: …] lines, deleted on close`, () => {
  assert.equal(ROOM_RULES_VERSION, 22);
  const rules = roomRules("http://127.0.0.1:47621");
  const files = rules.slice(rules.indexOf("## Files"), rules.indexOf("## Narrate"));
  assert.match(files, /from `~\/\.config\/gyredeck\/outbox\/` only/);
  assert.match(files, /"files":\[\{"path":"\/.+\/\.config\/gyredeck\/outbox\/<file>"\}\]/);
  assert.match(files, /`attach=<absolute path>` on your first line/);
  assert.match(files, /\[file: <name> · <type> · <size> → <path>\]/);
  assert.match(files, /deletes every file when the room closes/);
  assert.match(files, /A link is text/);
});

// ── A member's file ──

test("I1/I2: an outbox file is copied into the room's folder; the message points at the copy, which the outbox cannot change", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const source = await put(h, "shot.png", PNG);
    const posted = await r.post("peer-a", { text: "the screenshot", files: [{ path: source }] });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const message = (await r.history()).find((m) => m.seq === posted.body.seq);
    assert.equal(message.files.length, 1);
    const [file] = message.files;
    assert.deepEqual({ name: file.name, type: file.type, size: file.size }, { name: "shot.png", type: "image/png", size: PNG.length });
    assert.ok(file.path.startsWith(`${realpathSync(r.folder)}/`), file.path);
    assert.notEqual(file.path, realpathSync(source), "never the outbox");
    assert.deepEqual(await readFile(file.path), PNG);
    assert.equal(statSync(file.path).mode & 0o777, 0o600);
    assert.equal(statSync(r.folder).mode & 0o777, 0o700);
    // The sender changes and then deletes its file: the room's copy is what was posted.
    await writeFile(source, Buffer.from("something else entirely"));
    assert.deepEqual(await readFile(file.path), PNG);
    await rm(source);
    assert.deepEqual(await readFile(file.path), PNG);
    // A message without files carries no files field at all.
    const bare = await r.post("peer-a", { text: "no files here" });
    assert.equal("files" in (await r.history()).find((m) => m.seq === bare.body.seq), false);
  } finally {
    await h.stop();
  }
});

test("I1: a path that is not a regular file inside the outbox is refused — outside, ../, relative, a link out, a directory", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const elsewhere = join(h.home, "secret.txt");
    await writeFile(elsewhere, "not for the room\n");
    await put(h, "fine.txt", "fine\n");
    await symlink(elsewhere, join(h.outbox, "link-out.txt"));
    await symlink(h.home, join(h.outbox, "dir-out"));
    await mkdir(join(h.outbox, "a-folder"));
    const before = (await r.history()).length;
    for (const [path, why] of [
      [elsewhere, "an absolute path elsewhere"],
      [join(h.outbox, "..", "gyredeck.ingest-token"), "../ out of the outbox"],
      [join(h.outbox, "a-folder", "..", "..", "gyredeck.ingest-token"), "../ through a folder inside it"],
      ["outbox/fine.txt", "a relative path"],
      [join(h.outbox, "link-out.txt"), "a link in the outbox pointing out"],
      [join(h.outbox, "dir-out", "secret.txt"), "a linked folder in the outbox pointing out"],
      [join(h.outbox, "a-folder"), "a directory"],
      [join(h.outbox, "missing.txt"), "nothing there"],
      [h.outbox, "the outbox itself"],
    ]) {
      const refused = await r.post("peer-a", { text: "try", files: [{ path }] });
      assert.equal(refused.status, 400, `${why}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error, "file_not_in_outbox", why);
      assert.equal(typeof refused.body.file, "string", why);
    }
    assert.equal((await r.history()).length, before, "nothing was published");
    assert.deepEqual(await r.stored(), [], "and nothing copied");
    // The same file inside the outbox is fine, so the refusals above were about the place.
    assert.equal((await r.post("peer-a", { text: "ok", files: [{ path: join(h.outbox, "fine.txt") }] })).status, 202);
    // A link inside the outbox to a file inside the outbox is the file it names.
    await symlink(join(h.outbox, "fine.txt"), join(h.outbox, "link-in.txt"));
    assert.equal((await r.post("peer-a", { text: "ok again", files: [{ path: join(h.outbox, "link-in.txt") }] })).status, 202);
  } finally {
    await h.stop();
  }
});

test("I4: over 10 MB, more than 10 files, empty, and bytes that are not an image, PDF or UTF-8 text are refused, whatever the name", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const before = (await r.history()).length;
    const cases = [
      ["big.txt", Buffer.alloc(FILE_MAX_BYTES + 1, 0x61), "file_too_large"],
      ["empty.txt", Buffer.alloc(0), "file_empty"],
      ["report.txt", REFUSED.docx, "file_type_not_allowed"],
      ["archive.txt", REFUSED.zip, "file_type_not_allowed"],
      ["clip.txt", REFUSED.mp4, "file_type_not_allowed"],
      ["nul.txt", REFUSED.nul, "file_type_not_allowed"],
      ["latin1.txt", REFUSED.latin1, "file_type_not_allowed"],
    ];
    for (const [name, bytes, error] of cases) {
      const refused = await r.post("peer-a", { text: "try", files: [{ path: await put(h, name, bytes) }] });
      assert.equal(refused.status, 400, `${name}: ${JSON.stringify(refused.body)}`);
      assert.deepEqual([refused.body.error, refused.body.file], [error, name]);
    }
    // Exactly 10 MB is allowed; one byte more was refused above.
    assert.equal((await r.post("peer-a", { text: "at the cap", files: [{ path: await put(h, "cap.txt", Buffer.alloc(FILE_MAX_BYTES, 0x61)) }] })).status, 202);
    const one = await put(h, "one.txt", "1\n");
    const eleven = await r.post("peer-a", { text: "many", files: Array.from({ length: FILES_MAX + 1 }, () => ({ path: one })) });
    assert.deepEqual([eleven.status, eleven.body.error], [400, "too_many_files"]);
    const ten = await r.post("peer-a", { text: "ten", files: Array.from({ length: FILES_MAX }, () => ({ path: one })) });
    assert.equal(ten.status, 202, "ten is the cap, and the same file twice is two copies");
    assert.equal(new Set((await r.history()).find((m) => m.seq === ten.body.seq).files.map((f) => f.path)).size, FILES_MAX);
    for (const files of [[], {}, ["/a/string.txt"], [{ path: 7 }], [null], "x"]) {
      const bad = await r.post("peer-a", { text: "shape", files });
      assert.deepEqual([bad.status, bad.body.error], [400, "invalid_files"], JSON.stringify(files));
    }
    assert.equal((await r.history()).length, before + 2, "only the two that passed were published");
  } finally {
    await h.stop();
  }
});

test("I4: a post refused for one file publishes nothing and leaves no copy of the files that passed", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const good = await put(h, "good.txt", "good\n");
    const bad = await put(h, "bad.txt", REFUSED.docx);
    const before = (await r.history()).length;
    const refused = await r.post("peer-a", { text: "two", files: [{ path: good }, { path: good }, { path: bad }] });
    assert.deepEqual([refused.status, refused.body.error, refused.body.file], [400, "file_type_not_allowed", "bad.txt"]);
    assert.equal((await r.history()).length, before);
    assert.deepEqual(await r.stored(), [], "the copies made before the refusal are gone");
    // Refused later, by the room's own checks: the copies go too. A reaction run is the cheapest to reach.
    for (let index = 0; index < 20; index += 1) {
      const said = await r.post("founder-1", { text: `r${index}`, kind: "reaction", again: true });
      if (said.status === 409) break;
    }
    const late = await r.post("peer-a", { text: "late", kind: "reaction", files: [{ path: good }] });
    assert.deepEqual([late.status, late.body.error], [409, "reaction_run"], "premise: the room refuses this post after the files passed");
    assert.deepEqual(await r.stored(), [], "a later refusal removes the copies too");
    assert.equal((await readFile(good, "utf8")), "good\n", "the outbox is never touched");
  } finally {
    await h.stop();
  }
});

test("I4: the same words with files are never taken for a repeat", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const a = await put(h, "a.txt", "a\n");
    const first = await r.post("peer-a", { text: "same words", files: [{ path: a }] });
    const second = await r.post("peer-a", { text: "same words", files: [{ path: a }] });
    assert.equal(second.status, 202);
    assert.notEqual(second.body.seq, first.body.seq);
    assert.equal(second.body.duplicate, undefined);
  } finally {
    await h.stop();
  }
});

test("I3: only the app as the owner on Discord names a file, only in attachments/<room>/.incoming, and the room keeps its own copy", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const other = await roomOf(h, "-b");
    const stage = join(r.folder, ROOM_INCOMING);
    await mkdir(stage, { recursive: true });
    await mkdir(join(other.folder, ROOM_INCOMING), { recursive: true });
    const staged = async (name) => {
      const path = join(stage, name);
      await writeFile(path, PNG);
      return path;
    };
    const downloaded = await staged("123456-0-photo.png");
    const foreign = join(other.folder, ROOM_INCOMING, "999-0-theirs.png");
    await writeFile(foreign, PNG);
    const owner = (files) => h.call("POST", `/mail/${r.code}`, { from: OWNER_DISCORD_SENDER, to: "everyone", kind: "tell", text: "from my phone", files });

    const posted = await owner([{ path: downloaded }]);
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const [file] = (await r.history()).find((m) => m.seq === posted.body.seq).files;
    assert.deepEqual([file.name, file.type, file.size], ["photo.png", "image/png", PNG.length]);
    assert.equal(dirname(file.path), realpathSync(r.folder), "a copy in the room's folder, not the download");
    assert.deepEqual(await readFile(file.path), PNG);
    assert.equal(existsSync(downloaded), false, "the download is taken");

    const roomCopy = join(r.folder, "1-0-copy.png");
    await writeFile(roomCopy, PNG);
    for (const [path, why] of [
      [foreign, "another room's .incoming"],
      [join(stage, "..", "..", other.code, ROOM_INCOMING, "999-0-theirs.png"), "another room's by ../"],
      [roomCopy, "the room's folder itself"],
      [await put(h, "outbox.png", PNG), "the outbox"],
      [join(h.home, "x.png"), "anywhere else"],
    ]) {
      if (why === "anywhere else") await writeFile(path, PNG);
      const refused = await owner([{ path }]);
      assert.deepEqual([refused.status, refused.body.error], [400, "file_not_in_room"], why);
    }
    assert.ok(existsSync(foreign) && existsSync(roomCopy), "a refused path outside .incoming is never removed");
    await symlink(foreign, join(stage, "link-to-other.png"));
    assert.equal((await owner([{ path: join(stage, "link-to-other.png") }])).body.error, "file_not_in_room", "a link out of the folder");

    // A member naming .incoming is refused, with its own key or with the app's headers.
    const waiting = await staged("5-0-waiting.png");
    const member = await r.post("peer-a", { text: "mine", files: [{ path: waiting }] });
    assert.deepEqual([member.status, member.body.error], [400, "file_not_in_outbox"]);
    const vouchedAsMember = await h.call("POST", `/mail/${r.code}`, { from: "peer-a", to: "everyone", kind: "tell", text: "as the app", files: [{ path: waiting }] });
    assert.deepEqual([vouchedAsMember.status, vouchedAsMember.body.error], [400, "file_not_in_outbox"], "the app's word alone is not the owner");
    // The owner's voice without the app's word is no voice at all.
    const unvouched = await h.call("POST", `/mail/${r.code}`, { from: OWNER_DISCORD_SENDER, text: "x", files: [{ path: waiting }] }, { "content-type": "application/json", "x-gyredeck-token": h.token });
    assert.equal(unvouched.status, 403);
    assert.ok(existsSync(waiting), "nobody else's post takes a download");
  } finally {
    await h.stop();
  }
});

test("I4: a room's folder, downloads waiting in .incoming included, holds at most its cap; a download taken is not counted twice", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const stage = join(r.folder, ROOM_INCOMING);
    await mkdir(stage, { recursive: true });
    // A sparse file: what the folder holds is counted by size, not by blocks on disk.
    const filler = join(r.folder, "1-0-filler.txt");
    await writeFile(filler, "");
    truncateSync(filler, ROOM_FILES_MAX_BYTES - PNG.length - 10);
    // A download still waiting counts: the folder's whole size is what is capped.
    const waiting = join(stage, "9-0-waiting.txt");
    await writeFile(waiting, "w".repeat(10));
    const total = () => roomFilesBytes(r.folder);
    const owner = (files) => h.call("POST", `/mail/${r.code}`, { from: OWNER_DISCORD_SENDER, to: "everyone", kind: "tell", text: "from my phone", files });
    const downloaded = join(stage, "2-0-photo.png");
    await writeFile(downloaded, PNG);
    assert.equal(total(), ROOM_FILES_MAX_BYTES, "premise: at the cap, the download counted once");
    assert.equal((await owner([{ path: downloaded }])).status, 202, "taking a download moves it, never counts it twice");
    assert.equal(total(), ROOM_FILES_MAX_BYTES);

    const more = await r.post("peer-a", { text: "one more", files: [{ path: await put(h, "ten.txt", "0123456789") }] });
    assert.deepEqual([more.status, more.body.error], [400, "room_files_full"], "the waiting download is counted against a member");
    assert.equal(total(), ROOM_FILES_MAX_BYTES, "a refused post leaves nothing behind");
    rmSync(waiting);
    const member = await r.post("peer-a", { text: "to the cap", files: [{ path: await put(h, "fits.txt", "0123456789") }] });
    assert.equal(member.status, 202, "exactly at the cap is within it");
    assert.equal(total(), ROOM_FILES_MAX_BYTES);

    const over = join(stage, "3-0-more.png");
    await writeFile(over, PNG);
    const refused = await owner([{ path: over }]);
    assert.deepEqual([refused.status, refused.body.error], [400, "room_files_full"], "the owner's files count too");
    assert.equal(existsSync(over), false, "a refused download is taken all the same");
    assert.equal(total(), ROOM_FILES_MAX_BYTES, "and nothing of it is kept");
    assert.equal((await r.stored()).filter((n) => !n.startsWith(".")).length, 3, "the filler and the two copies");

    // A `.incoming` that cannot be listed may hold anything: the folder counts as full.
    truncateSync(filler, 0);
    await chmod(stage, 0o300);
    try {
      const blind = await r.post("peer-a", { text: "blind", files: [{ path: await put(h, "b.txt", "b") }] });
      assert.deepEqual([blind.status, blind.body.error], [400, "room_files_full"]);
      assert.match(blind.body.message, /could not be counted/);
    } finally {
      await chmod(stage, 0o700);
    }
    assert.equal((await r.stored()).filter((n) => !n.startsWith(".")).length, 3, "nothing kept");
  } finally {
    await h.stop();
  }
});

test("I4: a copy the room could not take back is said, holds every later file of that room, and is removed once it can be", async () => {
  const h = await startBridge({ env: { GYREDECK_TEST_STRANDED_RETRY_MS: "300" } });
  try {
    const r = await roomOf(h);
    await mkdir(r.folder, { recursive: true });
    const filler = join(r.folder, "1-0-filler.txt");
    await writeFile(filler, "");
    truncateSync(filler, ROOM_FILES_MAX_BYTES - 5);
    // Files can be made in the folder, not removed from it.
    execFileSync("chmod", ["+a", "everyone deny delete_child", r.folder]);
    let stuck;
    try {
      const over = await r.post("peer-a", { text: "over", files: [{ path: await put(h, "ten.txt", "0123456789") }] });
      assert.deepEqual([over.status, over.body.error], [400, "room_files_full"]);
      stuck = (await r.stored()).filter((n) => !n.startsWith(".") && n !== "1-0-filler.txt");
      assert.equal(stuck.length, 1, "premise: its copy could not be taken back");
      assert.match(h.stderr(), /could not take back/);
      truncateSync(filler, 0);
      const later = await r.post("peer-a", { text: "small", files: [{ path: await put(h, "one.txt", "1") }] });
      assert.deepEqual([later.status, later.body.error], [400, "room_files_unavailable"], "room under the cap, still held");
      assert.deepEqual((await r.stored()).filter((n) => !n.startsWith(".") && n !== "1-0-filler.txt"), stuck, "nothing more was written");
    } finally {
      execFileSync("chmod", ["-N", r.folder]);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual((await r.stored()).filter((n) => !n.startsWith(".") && n !== "1-0-filler.txt"), [], "tried again, and gone once it could be");
    const after = await r.post("peer-a", { text: "after", files: [{ path: await put(h, "two.txt", "2") }] });
    assert.equal(after.status, 202, JSON.stringify(after.body));
  } finally {
    await h.stop();
  }
});

test("I4: a copy cut short by a failed write is taken back, and held and tried again when it cannot be", async () => {
  const h = await startBridge({ fileLimitKb: 64, env: { GYREDECK_TEST_STRANDED_RETRY_MS: "300" } });
  try {
    const r = await roomOf(h);
    await mkdir(r.folder, { recursive: true });
    const big = "x".repeat(200 * 1024);
    const cut = await r.post("peer-a", { text: "cut", files: [{ path: await put(h, "big.txt", big) }] });
    assert.deepEqual([cut.status, cut.body.error], [400, "room_files_unavailable"]);
    assert.deepEqual((await r.stored()).filter((n) => !n.startsWith(".")), [], "the part written was taken back");
    execFileSync("chmod", ["+a", "everyone deny delete_child", r.folder]);
    let stuck;
    try {
      const again = await r.post("peer-a", { text: "again", files: [{ path: await put(h, "big2.txt", big) }] });
      assert.deepEqual([again.status, again.body.error], [400, "room_files_unavailable"]);
      stuck = (await r.stored()).filter((n) => !n.startsWith("."));
      assert.equal(stuck.length, 1, "premise: the part written could not be taken back");
      assert.match(h.stderr(), /could not take back/);
      const later = await r.post("peer-a", { text: "small", files: [{ path: await put(h, "one.txt", "1") }] });
      assert.deepEqual([later.status, later.body.error], [400, "room_files_unavailable"], "held until it is gone");
      assert.deepEqual((await r.stored()).filter((n) => !n.startsWith(".")), stuck, "nothing more was written");
    } finally {
      execFileSync("chmod", ["-N", r.folder]);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual((await r.stored()).filter((n) => !n.startsWith(".")), [], "tried again, and gone once it could be");
  } finally {
    await h.stop();
  }
});

test("I4: a copy whose close fails is taken back", async () => {
  const h = await startBridge({ closeFails: true });
  try {
    const r = await roomOf(h);
    await mkdir(r.folder, { recursive: true });
    const post = await r.post("peer-a", { text: "closed badly", files: [{ path: await put(h, "a.txt", "a\n") }] });
    assert.deepEqual([post.status, post.body.error], [400, "room_files_unavailable"]);
    assert.deepEqual((await r.stored()).filter((n) => !n.startsWith(".")), [], "taken back");
  } finally {
    await h.stop();
  }
});

test("I4: a folder past its cap from the connector's side takes nothing more from the bridge, not even for a moment", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const stage = join(r.folder, ROOM_INCOMING);
    await mkdir(stage, { recursive: true });
    // A download the connector could not take back holds the folder past its cap.
    const stuck = join(stage, "9-0-stuck.bin");
    await writeFile(stuck, "");
    truncateSync(stuck, ROOM_FILES_MAX_BYTES + 1);
    // A copy written here could not be removed again.
    execFileSync("chmod", ["+a", "everyone deny delete_child", r.folder]);
    try {
      const post = await r.post("peer-a", { text: "one", files: [{ path: await put(h, "one.txt", "1") }] });
      assert.deepEqual([post.status, post.body.error], [400, "room_files_full"]);
      assert.match(post.body.message, /could not take back/);
      assert.deepEqual((await r.stored()).filter((n) => !n.startsWith(".")), [], "nothing was written to be taken back");
    } finally {
      execFileSync("chmod", ["-N", r.folder]);
    }
  } finally {
    await h.stop();
  }
});

test("I1: a member that is not (or no longer) in the room posts no file and leaves no copy", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const path = await put(h, "a.txt", "a\n");
    const removed = await h.call("DELETE", `/sync/rooms/${r.code}/members/peer-a`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const after = await r.post("peer-a", { text: "still here?", files: [{ path }] });
    assert.ok(after.status === 403, JSON.stringify(after.body));
    assert.deepEqual(await r.stored(), []);
    const mailbox = await h.call("POST", "/mail/some-mailbox", { from: "peer-a", text: "x", files: [{ path }] });
    assert.deepEqual([mailbox.status, mailbox.body.error], [400, "invalid_files"], "files go to a sync room only");
  } finally {
    await h.stop();
  }
});

// ── Lifetime ──

test("I5: closing a room deletes its folder; other rooms' folders and the outbox stay", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const other = await roomOf(h, "-b");
    const source = await put(h, "keep.txt", "keep\n");
    assert.equal((await r.post("peer-a", { text: "f", files: [{ path: source }] })).status, 202);
    assert.equal((await other.post("peer-a", { text: "g", files: [{ path: source }] })).status, 202);
    assert.equal((await r.stored()).length, 1, "premise: the folder holds the copy");
    const closed = await h.call("DELETE", `/sync/rooms/${r.code}`);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(existsSync(r.folder), false, "the room's folder is gone");
    assert.equal((await other.stored()).length, 1, "another room's folder is untouched");
    assert.equal(await readFile(source, "utf8"), "keep\n", "the outbox is never touched");
  } finally {
    await h.stop();
  }
});

test("I5: a room closed while a file it could not take back is still there is cleaned up once it can be", async () => {
  const h = await startBridge({ fileLimitKb: 64, env: { GYREDECK_TEST_STRANDED_RETRY_MS: "300" } });
  try {
    const r = await roomOf(h);
    await mkdir(r.folder, { recursive: true });
    execFileSync("chmod", ["+a", "everyone deny delete_child", r.folder]);
    let aside = null;
    try {
      const cut = await r.post("peer-a", { text: "cut", files: [{ path: await put(h, "big.txt", "x".repeat(200 * 1024)) }] });
      assert.deepEqual([cut.status, cut.body.error], [400, "room_files_unavailable"]);
      assert.equal((await r.stored()).length, 1, "premise: the part written could not be taken back");
      assert.equal((await h.call("DELETE", `/sync/rooms/${r.code}`)).status, 200);
      assert.equal(existsSync(r.folder), false, "nothing is left under the room's name");
      assert.match(h.stderr(), /\.closed-[0-9a-f]{8} could not be removed yet/);
      const left = (await readdir(h.attachments)).filter((n) => n.startsWith(".closed-"));
      assert.equal(left.length, 1, "premise: it was moved aside, not removed");
      aside = join(h.attachments, left[0]);
    } finally {
      execFileSync("chmod", ["-N", aside ?? r.folder]);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(await readdir(h.attachments), [], "tried again, and gone once it could be");
  } finally {
    await h.stop();
  }
});

test("I5: a room whose folder was replaced by a link is closed without following it", async () => {
  const h = await startBridge();
  try {
    const r = await roomOf(h);
    const target = join(h.home, "precious");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "keep\n");
    await mkdir(h.attachments, { recursive: true });
    await symlink(target, r.folder);
    assert.equal((await h.call("DELETE", `/sync/rooms/${r.code}`)).status, 200);
    assert.equal(existsSync(r.folder), false, "the link is gone");
    assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep\n", "what it pointed at is not");
  } finally {
    await h.stop();
  }
});

test("I5: the bridge empties attachments/ when it starts, never following a link, and leaves the outbox alone", async () => {
  const home = await tempHome();
  const precious = join(home, "precious");
  const h = await startBridge({
    home,
    before: async (config) => {
      await mkdir(join(config, "attachments", "sync-old2", "nested"), { recursive: true });
      await writeFile(join(config, "attachments", "sync-old2", "a.png"), PNG);
      await writeFile(join(config, "attachments", "stray.txt"), "x");
      await mkdir(precious);
      await writeFile(join(precious, "keep.txt"), "keep\n");
      await symlink(precious, join(config, "attachments", "sync-link"));
      await mkdir(join(config, "outbox"));
      await writeFile(join(config, "outbox", "mine.txt"), "mine\n");
    },
  });
  try {
    assert.deepEqual(await readdir(h.attachments), [], "every entry is gone");
    assert.equal(await readFile(join(precious, "keep.txt"), "utf8"), "keep\n", "a link's target is not emptied");
    assert.equal(await readFile(join(h.outbox, "mine.txt"), "utf8"), "mine\n");
  } finally {
    await h.stop();
  }
});

test("I5: at start, a folder that cannot be removed yet holds no other back, and is tried again until it is gone", async () => {
  const home = await tempHome();
  let attachments = null;
  const h = await startBridge({
    home,
    env: { GYREDECK_TEST_STRANDED_RETRY_MS: "300" },
    before: async (config) => {
      attachments = join(config, "attachments");
      for (const room of ["sync-aaaa", "sync-bbbb"]) {
        await mkdir(join(attachments, room), { recursive: true });
        await writeFile(join(attachments, room, "a.txt"), "a\n");
      }
      execFileSync("chmod", ["+a", "everyone deny delete_child", join(attachments, "sync-aaaa")]);
    },
  });
  try {
    const left = await readdir(h.attachments);
    assert.equal(left.length, 1, `the one that could be removed is gone — ${left}`);
    assert.match(left[0], /^\.closed-/, "the one that could not is moved aside, off any room's name");
    assert.match(h.stderr(), /\.closed-[0-9a-f]{8} could not be removed yet/);
    execFileSync("chmod", ["-N", join(h.attachments, left[0])]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(await readdir(h.attachments), [], "tried again, and gone once it could be");
  } finally {
    for (const name of existsSync(attachments) ? await readdir(attachments) : []) execFileSync("chmod", ["-N", join(attachments, name)]);
    await h.stop();
  }
});

test("I5: a room closed while attachments/ cannot be entered holds its name, takes no file under it, and is removed once it can be", async () => {
  process.env.GYREDECK_TEST_STRANDED_RETRY_MS = "300";
  const home = await tempHome();
  const dir = join(home, "attachments");
  try {
    await mkdir(join(dir, "sync-held"), { recursive: true });
    await writeFile(join(dir, "sync-held", "a.txt"), "a\n");
    await chmod(dir, 0o000);
    try {
      removeRoomFiles("sync-held", dir);
      assert.equal(roomFilesHeld("sync-held"), true, "a newer room by that name takes no file");
      assert.equal(roomFilesHeld("sync-other"), false, "no other room is held");
    } finally {
      await chmod(dir, 0o700);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(roomFilesHeld("sync-held"), false, "free again once it is gone");
    assert.deepEqual(await readdir(dir), [], "tried again, and gone once it could be");
  } finally {
    delete process.env.GYREDECK_TEST_STRANDED_RETRY_MS;
    await rm(realpathSync(home), { recursive: true, force: true });
    await rm(home, { force: true });
  }
});

test("I5: attachments/ unreadable at start holds every room's files, and is emptied once it can be", async () => {
  process.env.GYREDECK_TEST_STRANDED_RETRY_MS = "300";
  const home = await tempHome();
  const dir = join(home, "attachments");
  try {
    await mkdir(join(dir, "sync-old"), { recursive: true });
    await writeFile(join(dir, "sync-old", "a.txt"), "a\n");
    await chmod(dir, 0o000);
    try {
      emptyAttachments(dir);
      assert.equal(roomFilesHeld("sync-any"), true, "no room takes a file meanwhile");
    } finally {
      await chmod(dir, 0o700);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(roomFilesHeld("sync-any"), false, "files are taken again once it is empty");
    assert.deepEqual(await readdir(dir), [], "tried again, and emptied once it could be");
  } finally {
    delete process.env.GYREDECK_TEST_STRANDED_RETRY_MS;
    await rm(realpathSync(home), { recursive: true, force: true });
    await rm(home, { force: true });
  }
});

test("I5: a name closed twice while held has one cleaner, which never removes the newer room's files", async () => {
  process.env.GYREDECK_TEST_STRANDED_RETRY_MS = "300";
  const home = await tempHome();
  const dir = join(home, "attachments");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await mkdir(join(dir, "sync-twice"), { recursive: true });
    await writeFile(join(dir, "sync-twice", "old.txt"), "old\n");
    await chmod(dir, 0o000);
    try {
      removeRoomFiles("sync-twice", dir);
      await pause(150);
      removeRoomFiles("sync-twice", dir);
    } finally {
      await chmod(dir, 0o700);
    }
    await pause(250);
    assert.equal(roomFilesHeld("sync-twice"), false, "premise: the name is free again");
    await mkdir(join(dir, "sync-twice"), { recursive: true });
    await writeFile(join(dir, "sync-twice", "new.txt"), "new\n");
    await pause(400);
    assert.equal(await readFile(join(dir, "sync-twice", "new.txt"), "utf8"), "new\n", "the newer room's file stays");
  } finally {
    delete process.env.GYREDECK_TEST_STRANDED_RETRY_MS;
    await rm(realpathSync(home), { recursive: true, force: true });
    await rm(home, { force: true });
  }
});

test("I5: attachments/ gone before the start sweep is tried again lifts the hold", async () => {
  process.env.GYREDECK_TEST_STRANDED_RETRY_MS = "300";
  const home = await tempHome();
  const dir = join(home, "attachments");
  try {
    await mkdir(join(dir, "sync-old"), { recursive: true });
    await chmod(dir, 0o000);
    try {
      emptyAttachments(dir);
      assert.equal(roomFilesHeld("sync-any"), true, "premise: held");
    } finally {
      await chmod(dir, 0o700);
    }
    await rm(dir, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(roomFilesHeld("sync-any"), false, "nothing left, nothing held");
  } finally {
    delete process.env.GYREDECK_TEST_STRANDED_RETRY_MS;
    await rm(realpathSync(home), { recursive: true, force: true });
    await rm(home, { force: true });
  }
});

test("I5: while files an earlier room left are still there, the bridge refuses a file and says why", async () => {
  const home = await tempHome();
  let attachments = null;
  const h = await startBridge({
    home,
    env: { GYREDECK_TEST_STRANDED_RETRY_MS: "300" },
    before: async (config) => {
      attachments = join(config, "attachments");
      await mkdir(join(attachments, "sync-old"), { recursive: true });
      await chmod(attachments, 0o000);
    },
  });
  try {
    const r = await roomOf(h);
    const held = await r.post("peer-a", { text: "held", files: [{ path: await put(h, "one.txt", "1\n") }] });
    assert.deepEqual([held.status, held.body.error], [400, "room_files_unavailable"]);
    assert.match(held.body.message, /earlier room left/);
    await chmod(attachments, 0o700);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(existsSync(join(attachments, "sync-old")), false, "emptied once it could be");
    const taken = await r.post("peer-a", { text: "taken", files: [{ path: await put(h, "two.txt", "2\n") }] });
    assert.equal(taken.status, 202, JSON.stringify(taken.body));
  } finally {
    if (attachments && existsSync(attachments)) await chmod(attachments, 0o700);
    await h.stop();
  }
});

test("I5: attachments/ itself a link is removed at start, not emptied through", async () => {
  const home = await tempHome();
  const precious = join(home, "precious");
  const h = await startBridge({
    home,
    before: async (config) => {
      await mkdir(precious);
      await writeFile(join(precious, "keep.txt"), "keep\n");
      await symlink(precious, join(config, "attachments"));
    },
  });
  try {
    assert.equal(await readFile(join(precious, "keep.txt"), "utf8"), "keep\n");
    // And the next post makes a real folder in its place.
    const r = await roomOf(h);
    assert.equal((await r.post("peer-a", { text: "f", files: [{ path: await put(h, "a.txt", "a\n") }] })).status, 202);
    assert.equal(statSync(h.attachments).isDirectory(), true);
    assert.deepEqual(await readdir(precious), ["keep.txt"]);
  } finally {
    await h.stop();
  }
});

// ── Deliveries ──

/** A broker on the hook's socket that binds `as` and collects for it with the app's word. */
const fakeBroker = async (h, as) => {
  const dir = join(h.config, "broker");
  await mkdir(dir, { recursive: true });
  let delivery = 0;
  const server = createSocketServer((socket) => {
    let text = "";
    socket.on("error", () => {});
    socket.on("data", async (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      const request = JSON.parse(text.slice(0, text.indexOf("\n")));
      let answer = { v: 1, ok: true };
      if (request.bind) answer = { v: 1, ok: true, bound: { conversationId: as, pid: 1 } };
      else if (request.collect) {
        const limit = Number.isInteger(request.collect.limit) ? request.collect.limit : 10;
        const response = await fetch(`${h.base}/mail/inbox?as=${as}&collect=1&limit=${limit}${request.collect.wakingOnly ? "&waking=1" : ""}`, {
          headers: { "x-gyredeck-token": h.token, "x-gyredeck-broker": APP_WORD },
        });
        const body = await response.json();
        answer = { ...body, v: 1, boundTo: as, ...(Array.isArray(body.messages) && body.messages.length > 0 ? { delivery: ++delivery } : {}) };
      } else if (request.ack) answer = { v: 1, ok: true, acked: request.ack.delivery };
      socket.end(`${JSON.stringify(answer)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(join(dir, "gyredeck.broker.sock"), resolve));
  return () => new Promise((resolve) => server.close(resolve));
};

const runHook = (script, event, home, payload) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--event", event], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify(payload));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
const runClaudeHook = (home, payload) => runHook("adapters/claude/gyredeck-claude-hook.mjs", payload.hook_event_name, home, payload);

test("a Claude Code delivery shows each file on its own line, with the path to read", async () => {
  const h = await startBridge();
  let closeBroker = null;
  try {
    const r = await roomOf(h);
    closeBroker = await fakeBroker(h, "founder-1");
    const png = await put(h, "shot.png", PNG);
    const txt = await put(h, "notes.md", "# notes\n");
    const posted = await r.post("peer-a", { to: "founder-1", text: "two files for you", files: [{ path: png }, { path: txt }] });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const [a, b] = (await r.history()).find((m) => m.seq === posted.body.seq).files;
    let context = "";
    for (let attempt = 0; attempt < 3 && !context.includes("two files for you"); attempt += 1) {
      const result = await runClaudeHook(h.home, { hook_event_name: "UserPromptSubmit", session_id: "founder-1", cwd: "/tmp/project", prompt: "hi" });
      assert.equal(result.code, 0, result.stderr);
      if (result.stdout.trim()) context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    }
    assert.ok(context.includes("two files for you"), `premise: the message was delivered — ${context}`);
    assert.ok(
      context.includes(`two files for you\n[file: shot.png · image/png · ${PNG.length} → ${a.path}]\n[file: notes.md · text/plain · 8 → ${b.path}]`),
      context,
    );
  } finally {
    await closeBroker?.();
    await h.stop();
  }
});

test("an Antigravity delivery shows each file on its own line, with the path to read", async () => {
  const h = await startBridge();
  let closeBroker = null;
  try {
    const r = await roomOf(h);
    closeBroker = await fakeBroker(h, "founder-1");
    const png = await put(h, "shot.png", PNG);
    const posted = await r.post("peer-a", { to: "founder-1", text: "a file for agy", files: [{ path: png }] });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const [a] = (await r.history()).find((m) => m.seq === posted.body.seq).files;
    let steps = [];
    for (let attempt = 0; attempt < 3 && !JSON.stringify(steps).includes("a file for agy"); attempt += 1) {
      const result = await runHook("adapters/antigravity/gyredeck-agy-hook.mjs", "PreInvocation", h.home, { conversationId: "founder-1", invocationNum: attempt, workspacePaths: ["/tmp/project"] });
      assert.equal(result.code, 0, result.stderr);
      if (result.stdout.trim()) steps = JSON.parse(result.stdout).injectSteps ?? [];
    }
    const texts = steps.map((step) => step.ephemeralMessage ?? "");
    assert.ok(texts.some((t) => t.includes("a file for agy")), `premise: the message was delivered — ${JSON.stringify(texts)}`);
    assert.ok(texts.some((t) => t.includes(`a file for agy\n[file: shot.png · image/png · ${PNG.length} → ${a.path}]`)), JSON.stringify(texts));
  } finally {
    await closeBroker?.();
    await h.stop();
  }
});

const recordingCodexBinary = `#!${process.execPath}
const { readdirSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const args = process.argv.slice(2);
const thread = args[args.indexOf("--thread") + 1];
const message = args[args.indexOf("--message") + 1];
const root = join(process.env.HOME, ".codex", "sessions");
const rollout = readdirSync(root, { recursive: true }).map(String).find((name) => name.endsWith(".jsonl") && name.includes(thread));
if (rollout) {
  appendFileSync(join(root, rollout), JSON.stringify({
    type: "event_msg", timestamp: new Date().toISOString(),
    payload: { type: "item_completed", turn_id: randomUUID(), item: { type: "UserMessage", id: randomUUID(), content: [{ type: "text", text: message }] } },
  }) + "\\n");
}
process.exit(0);
`;
const finishedTurn = (text) => {
  const turnId = randomUUID();
  const at = new Date().toISOString();
  return JSON.stringify({ type: "event_msg", timestamp: at, payload: { type: "item_completed", turn_id: turnId, item: { type: "UserMessage", id: randomUUID(), content: [{ type: "text", text: "typed at the keyboard" }] } } }) + "\n" +
    JSON.stringify({ type: "event_msg", timestamp: at, payload: { type: "task_complete", turn_id: turnId, last_agent_message: text } }) + "\n";
};
const promptsIn = async (rollout) => (await readFile(rollout, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
  .filter((entry) => entry.payload?.type === "item_completed" && entry.payload.item?.type === "UserMessage")
  .map((entry) => entry.payload.item.content.map((part) => part.text).join(""));

test("I4: a Codex reply whose first file is stranded takes none of the files after it", async () => {
  const home = await tempHome();
  const thread = randomUUID();
  const rollout = join(home, ".codex", "sessions", "2026", "11", "16", `rollout-2026-11-16T10-00-00-${thread}.jsonl`);
  const fakeBin = join(home, ".bun", "bin");
  const h = await startBridge({
    home,
    fileLimitKb: 64,
    env: { GYREDECK_NO_AGENT_SPAWN: "0", PATH: `${fakeBin}:/bin` },
    before: async () => {
      await mkdir(join(home, ".codex", "sessions", "2026", "11", "16"), { recursive: true });
      await writeFile(rollout, "");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(fakeBin, "codex"), recordingCodexBinary);
      await chmod(join(fakeBin, "codex"), 0o755);
    },
  });
  try {
    for (const [conversationId, sourceKind] of [["founder-1", "claudeCodeHook"], [thread, "codexCliHook"]]) {
      await h.call("POST", "/ingest", {
        version: 2, id: randomUUID(), type: "turn_start", timestamp: new Date().toISOString(), conversationId, cwd: "/tmp/project",
        runtime: { sourcePid: 1, sourcePpid: null, sourceStartedAtMs: 1, sourceKind }, data: { inputCount: 1 },
      });
    }
    const { room: code } = (await h.call("POST", "/sync/rooms", { conversationId: "founder-1" })).body;
    await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: thread });
    const minted = await h.call("POST", `/sync/rooms/${code}/members/${thread}/join-code`, {});
    await h.call("POST", "/hook/sync/confirm", { conversationId: thread, turnId: randomUUID(), password: minted.body.code });
    const founder = await asMember(h, "founder-1");
    const history = async () => (await h.call("GET", `/mail/${code}?as=founder-1&since=0`, null, founder)).body.messages;
    const waitFor = async (check) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const found = await check();
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    };
    const big = "x".repeat(200 * 1024);
    const paths = [await put(h, "big1.txt", big), await put(h, "big2.txt", big), await put(h, "big3.txt", big), await put(h, "small.txt", "1\n")];
    const folder = join(h.attachments, code);
    await mkdir(folder, { recursive: true });
    const stored = async () => (await readdir(folder)).filter((n) => !n.startsWith("."));
    execFileSync("chmod", ["+a", "everyone deny delete_child", folder]);
    try {
      await appendFile(rollout, finishedTurn(`@everyone tell ${paths.map((p) => `attach="${p}"`).join(" ")} — FOUR-FILES`));
      await h.call("POST", "/hook/stop", { hookId: randomUUID(), hookEventName: "Stop", source: "hook", workingDirectory: "/tmp/project", conversationId: thread });
      const posted = await waitFor(async () => (await history()).find((m) => m.from === thread && m.text === "FOUR-FILES"));
      assert.ok(posted, `the message was posted — ${h.stderr().slice(-400)}`);
      assert.equal(posted.files, undefined, "no file rode with it, not even the small one");
      assert.equal((await stored()).length, 1, "only the first cut-short copy is stranded; nothing after it was written");
      const told = await waitFor(async () => (await promptsIn(rollout)).find((text) => text.includes(`seq ${posted.seq} went out without`)));
      assert.ok(told, `Codex is told — ${h.stderr().slice(-400)}`);
      for (const name of ["big1.txt", "big2.txt", "big3.txt", "small.txt"]) assert.ok(told.includes(name), `${name} named — ${told}`);
    } finally {
      execFileSync("chmod", ["-N", folder]);
    }
  } finally {
    await h.stop();
  }
});

test("I6: Codex's attach= passes the member check — outbox only, copied; a refused file is left off and Codex is told; a push shows files", async () => {
  const home = await tempHome();
  const thread = randomUUID();
  const rollout = join(home, ".codex", "sessions", "2026", "11", "16", `rollout-2026-11-16T10-00-00-${thread}.jsonl`);
  const fakeBin = join(home, ".bun", "bin");
  const h = await startBridge({
    home,
    env: { GYREDECK_NO_AGENT_SPAWN: "0", PATH: fakeBin },
    before: async () => {
      await mkdir(join(home, ".codex", "sessions", "2026", "11", "16"), { recursive: true });
      await writeFile(rollout, "");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(join(fakeBin, "codex"), recordingCodexBinary);
      await chmod(join(fakeBin, "codex"), 0o755);
    },
  });
  try {
    for (const [conversationId, sourceKind] of [["founder-1", "claudeCodeHook"], [thread, "codexCliHook"]]) {
      await h.call("POST", "/ingest", {
        version: 2, id: randomUUID(), type: "turn_start", timestamp: new Date().toISOString(), conversationId, cwd: "/tmp/project",
        runtime: { sourcePid: 1, sourcePpid: null, sourceStartedAtMs: 1, sourceKind }, data: { inputCount: 1 },
      });
    }
    const { room: code } = (await h.call("POST", "/sync/rooms", { conversationId: "founder-1" })).body;
    await h.call("POST", `/sync/rooms/${code}/members`, { conversationId: thread });
    const minted = await h.call("POST", `/sync/rooms/${code}/members/${thread}/join-code`, {});
    await h.call("POST", "/hook/sync/confirm", { conversationId: thread, turnId: randomUUID(), password: minted.body.code });
    const founder = await asMember(h, "founder-1");
    const history = async () => (await h.call("GET", `/mail/${code}?as=founder-1&since=0`, null, founder)).body.messages;
    const waitFor = async (check) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const found = await check();
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    };

    // A push to Codex shows the file line.
    const shot = await put(h, "shot.png", PNG);
    const pushed = await h.call("POST", `/mail/${code}`, { from: "founder-1", to: thread, kind: "tell", text: "PUSH-WITH-FILE", files: [{ path: shot }] }, founder);
    assert.equal(pushed.status, 202, JSON.stringify(pushed.body));
    const [copy] = (await history()).find((m) => m.seq === pushed.body.seq).files;
    const prompt = await waitFor(async () => (await promptsIn(rollout)).find((text) => text.includes("PUSH-WITH-FILE")));
    assert.ok(prompt, `premise: the push reached Codex — ${h.stderr().slice(-400)}`);
    assert.ok(prompt.includes(`PUSH-WITH-FILE\n[file: shot.png · image/png · ${PNG.length} → ${copy.path}]`), prompt);

    // Codex attaches one file from the outbox and one from elsewhere.
    const report = await put(h, "my report.txt", "report\n");
    const elsewhere = join(home, "secret.txt");
    await writeFile(elsewhere, "not for the room\n");
    await appendFile(rollout, finishedTurn(`@everyone tell attach="${report}" attach="${elsewhere}" — HERE-IS-THE-REPORT`));
    await h.call("POST", "/hook/stop", { hookId: randomUUID(), hookEventName: "Stop", source: "hook", workingDirectory: "/tmp/project", conversationId: thread });
    const posted = await waitFor(async () => (await history()).find((m) => m.from === thread && m.text === "HERE-IS-THE-REPORT"));
    assert.ok(posted, `the message was posted — ${h.stderr().slice(-400)}`);
    assert.equal(posted.files?.length, 1, "only the outbox file rode with it");
    assert.equal(posted.files[0].name, "my report.txt");
    assert.ok(posted.files[0].path.startsWith(`${realpathSync(join(h.attachments, code))}/`), "a copy, never the outbox");
    assert.equal(await readFile(posted.files[0].path, "utf8"), "report\n");
    // The room's word to one member is not in another's look back; what reached Codex is.
    const told = await waitFor(async () => (await promptsIn(rollout)).find((text) => text.includes(`seq ${posted.seq} went out without secret.txt`)));
    assert.ok(told, `Codex is told which file was left off — ${h.stderr().slice(-400)}`);
    assert.match(told, /secret\.txt \(not a regular file in the outbox\)/);
    assert.deepEqual((await readdir(join(h.attachments, code))).length, 2, "nothing copied for the refused file");
  } finally {
    await h.stop();
  }
});
