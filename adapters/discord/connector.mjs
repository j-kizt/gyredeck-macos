import { readState, saveState } from "./state.mjs";

export const PROTOCOL = 1;
export const MESSAGE_LIMIT = 2000;
export const DELAYED_MS = 60_000;
export const RETENTION_MS = 30 * 24 * 60 * 60_000;
export const SWEEP_MS = 24 * 60 * 60_000;
export const PAIR_MS = 10 * 60_000;
export const BACKOFF_MAX_MS = 60_000;
/** What the app grants a child between its stdin's end and a kill. */
export const CLOSE_GRACE_MS = 1_800;
/** Tries before content Discord refuses is replaced by a line saying so. */
export const REJECT_TRIES = 3;
export const PAIR_MAX_MISSES = 5;
/** Pages of 100 read back after the last message known to be ours before a post is said to be unknowable. */
export const READBACK_PAGES = 5;
const TAGS = ["open", "closed"];
const CLOSE_TEXT = { closed: "Room closed", ended: "Room ended — Gyredeck stopped", disconnected: "Disconnected" };

export const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

export function splitContent(text, limit = MESSAGE_LIMIT) {
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    const last = rest.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    const head = rest.slice(0, cut);
    const space = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
    if (space > 0 && space >= cut - 500) cut = space + 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

// Discord refuses a webhook username that contains "discord" or "clyde", and caps it at 80.
export function webhookName(name) {
  const clean = String(name ?? "")
    .replace(/discord/gi, (w) => `${w.slice(0, 4)}​${w.slice(4)}`)
    .replace(/clyde/gi, (w) => `${w.slice(0, 2)}​${w.slice(2)}`)
    .slice(0, 80)
    .trim();
  return clean || "Room";
}

export function formatMessage(m, delayed) {
  if (m.kind === "notice") {
    return { username: "Room", content: delayed ? `(delayed)\n${m.text}` : m.text };
  }
  return {
    username: webhookName(m.sender),
    content: `→ ${m.to} · ${m.kind}${delayed ? " (delayed)" : ""}\n${m.text}`,
  };
}

export function postName(code) {
  return `Room ${code}`.slice(0, 100);
}

export function postMarker(code, createdAt) {
  return `gyredeck-room: ${code} · ${createdAt ?? "-"}`;
}

export function awayText(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `${h} h`;
  return `${Math.round(ms / 86_400_000)} d`;
}

const ERROR_CODES = new Set([
  "bad_token", "missing_intent", "missing_permission", "no_forum",
  "rate_limited", "discord_down", "room_unknown", "pairing_locked", "reconcile_incomplete", "storage_blocked", "readback_unavailable", "internal",
]);

/** "#41–#43, #47 from Codex, Gyre Assistant" — the same shape as `not_relayed` in discord.rs. */
export function notRelayed(messages) {
  const seqs = [...new Set(messages.map((m) => m.seq))].sort((a, b) => a - b);
  const ranges = [];
  for (let i = 0; i < seqs.length; i++) {
    const start = seqs[i];
    while (i + 1 < seqs.length && seqs[i + 1] === seqs[i] + 1) i++;
    ranges.push(start === seqs[i] ? `#${start}` : `#${start}–#${seqs[i]}`);
  }
  return `${ranges.join(", ")} from ${[...new Set(messages.map((m) => m.sender))].join(", ")}`;
}

export function createConnector({ discord, out, clock = realClock }) {
  let token = null;
  let statePath = null;
  let state = { v: 1, rooms: {} };
  let forumId = null;
  let ownerId = null;
  let identity = null;
  let pairing = null;
  let awaitingOwner = null;
  let online = false;
  let stopped = false;
  let closing = false;
  let started = false;
  let sweepTimer = null;
  let releaseReady;
  const readyGate = new Promise((resolve) => (releaseReady = resolve));
  const workers = new Map();
  const tagCache = new Map();
  const waiters = new Set();
  const reported = new Set();

  function redact(text) {
    const s = String(text);
    return token ? s.split(token).join("[redacted]") : s;
  }

  function send(obj) {
    if (stopped) return;
    out(redact(JSON.stringify(obj)));
  }

  function fail(code, message, room) {
    const c = ERROR_CODES.has(code) ? code : "internal";
    send({ t: "error", code: c, message: redact(message ?? c), ...(room ? { room } : {}) });
  }

  function failOnce(key, code, message, room) {
    if (reported.has(key)) return;
    reported.add(key);
    fail(code, message, room);
  }

  // Whether a change to the state has not reached the disk yet. Nothing goes on to Discord
  // past a change that is not durable (`settle`), so a failing disk holds the queue rather
  // than widening what a restart would send again.
  let dirty = false;
  // Why state cannot be stored, when it cannot: nothing is connected or posted meanwhile.
  let storageBlocked = null;
  function save() {
    dirty = true;
    if (storageBlocked) throw new Error(storageBlocked);
    if (statePath) saveState(statePath, state);
    dirty = false;
  }
  function settle() {
    if (dirty) save();
  }
  // `msgId` is the app's read-back anchor should this state be lost: the message that carried
  // the seq's last part, or for a seq posted by an earlier run the last message known to be
  // ours, which comes after every line up to `lastSeq` and before any line not yet taken.
  function acked(w, seq, inst, msgId = null) {
    // The room instance travels with the ACK, so a late one for a code's earlier room can
    // never be taken for its new room's seq (#199 r4).
    send({ t: "posted", room: w.code, seq, createdAt: inst ?? null, msgId });
  }

  function wait(ms, { untilOnline = false, untilForum = false } = {}) {
    return new Promise((resolve) => {
      const w = {
        untilOnline,
        untilForum,
        done() {
          if (w.handle !== undefined) clock.clearTimeout(w.handle);
          waiters.delete(w);
          resolve();
        },
      };
      waiters.add(w);
      if (Number.isFinite(ms)) w.handle = clock.setTimeout(w.done, ms);
    });
  }

  function wake(onlyOnline) {
    for (const w of [...waiters]) if (!onlyOnline || w.untilOnline) w.done();
  }

  function wakeForum() {
    for (const w of [...waiters]) if (w.untilForum) w.done();
  }

  discord.on("online", () => {
    online = true;
    reported.delete("down");
    wake(true);
  });
  discord.on("offline", () => {
    online = false;
  });
  discord.on("forums", () => {
    if (identity && !stopped) send(readyMessage());
  });
  discord.on("dm", (dm) => {
    if (!pairing || stopped) return;
    if (clock.now() > pairing.expiresAt) {
      pairing = null;
      return;
    }
    if (dm.text !== pairing.code) {
      pairing.misses += 1;
      if (pairing.misses >= PAIR_MAX_MISSES) {
        pairing = null;
        fail("pairing_locked", "Too many wrong pairing codes; start pairing again.");
      }
      return;
    }
    // The round of the pair line that opened this window, so the app can tell a code it has
    // since replaced from the one it holds. The owner is the app's to accept: it says so
    // with an `owner` line, and only then is it the owner here.
    const { round } = pairing;
    pairing = null;
    send({ t: "paired", ownerId: dm.userId, username: dm.username, round });
    // Not "paired" yet: the app may refuse this round or fail to save it. The success line
    // waits for the app's `owner` line for this round.
    dm.reply?.("Code received — check Gyredeck.")?.catch?.(() => {});
    awaitingOwner = { round, userId: dm.userId, reply: dm.reply };
  });

  function readyMessage() {
    return { t: "ready", v: PROTOCOL, ...identity, forums: discord.listForums() };
  }

  async function start() {
    let backoff = 1000;
    while (!stopped) {
      try {
        identity = await discord.login(token);
        break;
      } catch (e) {
        if (stopped) return;
        if (e?.kind === "bad_token") return fail("bad_token", "Discord refused the bot token.");
        if (e?.kind === "missing_intent") {
          return fail("missing_intent", "Turn on Message Content Intent for the bot in the Discord Developer Portal.");
        }
        if (e?.kind !== "network") return fail("internal", e?.message);
        failOnce("down", "discord_down", "Cannot reach Discord; retrying.");
        await wait(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
    if (stopped) return;
    online = true;
    reported.delete("down");
    send(readyMessage());
    releaseReady();
    scheduleSweep();
    await sweep();
  }

  function scheduleSweep() {
    sweepTimer = clock.setTimeout(async () => {
      sweepTimer = null;
      if (stopped) return;
      await sweep();
      if (!stopped) scheduleSweep();
    }, SWEEP_MS);
  }

  async function sweep() {
    for (const [code, rs] of Object.entries(state.rooms)) {
      if (stopped) return;
      if (!rs.closedAt || clock.now() - rs.closedAt < RETENTION_MS) continue;
      const w = workers.get(code);
      if (w && (w.accepting || w.queue.length)) continue;
      try {
        await discord.deleteThread(rs.threadId);
      } catch (e) {
        if (e?.kind !== "missing") {
          fail(e?.kind === "permission" ? "missing_permission" : "internal", `Could not delete the closed post for ${code}.`, code);
          continue;
        }
      }
      delete state.rooms[code];
      save();
    }
  }

  async function tagsFor(forum) {
    if (!tagCache.has(forum)) tagCache.set(forum, await discord.ensureTags(forum, TAGS));
    return tagCache.get(forum);
  }

  function worker(code) {
    let w = workers.get(code);
    if (!w) {
      w = { code, queue: [], running: false, accepting: false, open: false, highSeq: state.rooms[code]?.lastSeq ?? 0 };
      workers.set(code, w);
    }
    return w;
  }

  function enqueue(w, item) {
    w.queue.push(item);
    drain(w);
  }

  async function drain(w) {
    if (w.running) return;
    w.running = true;
    let idle;
    w.idle = new Promise((resolve) => (idle = resolve));
    try {
      await readyGate;
      // The head leaves the queue only once `attempt` has dealt with it; a failure keeps
      // it at the head and nothing behind it overtakes.
      let backoff = 1000;
      while (w.queue.length && !stopped) {
        try {
          await attempt(w, w.queue[0]);
        } catch (e) {
          failOnce(`stuck:${w.code}`, "internal", e?.message, w.code);
          await wait(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          continue;
        }
        backoff = 1000;
        reported.delete(`stuck:${w.code}`);
        w.queue.shift();
      }
    } finally {
      w.running = false;
      idle();
    }
  }

  async function attempt(w, item) {
    let backoff = 1000;
    while (!stopped) {
      if (!online) await wait(Infinity, { untilOnline: true });
      if (stopped) return;
      try {
        await perform(w, item);
        reported.delete(`rate:${w.code}`);
        reported.delete(`perm:${w.code}`);
        reported.delete(`other:${w.code}`);
        if (item.op === "open") reported.delete(`forum:${w.code}`);
        return;
      } catch (e) {
        if (stopped) return;
        const kind = e?.kind;
        if (kind === "rate") {
          failOnce(`rate:${w.code}`, "rate_limited", "Discord asked us to slow down.", w.code);
          await wait(Math.max(0, Number(e.retryAfter) || 0));
          continue;
        }
        if (kind === "network") {
          failOnce("down", "discord_down", "Cannot reach Discord; messages are queued.");
          await wait(backoff, { untilOnline: true });
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          continue;
        }
        if (kind === "permission") {
          failOnce(`perm:${w.code}`, "missing_permission", "The bot lacks a permission it needs on the forum.", w.code);
          await wait(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          continue;
        }
        if (kind === "missing" && item.op === "send") {
          item.needsPost = true;
          continue;
        }
        if (kind === "missing" && item.op === "open") {
          // Parked, not emptied: the room keeps accepting and its queue waits behind the
          // open until a forum is there — said by a `forum` line, or found on a retry (#199 I19).
          failOnce(`forum:${w.code}`, "no_forum", "The chosen forum channel no longer exists.", w.code);
          if (forumId) tagCache.delete(forumId);
          await wait(backoff, { untilForum: true });
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          continue;
        }
        // Discord refused this content itself (a 4xx such as 50035 or 40005): after three
        // tries a short line takes its place, so the owner sees the hole and order holds.
        if (kind === "rejected" && item.op === "send") {
          item.rejected = (item.rejected ?? 0) + 1;
          if (item.rejected >= REJECT_TRIES) {
            await postInstead(w, item, e?.message);
            return;
          }
          continue;
        }
        // Anything else may pass — a 5xx, a save that failed — so it is tried again, never
        // dropped, and the room says it is held up.
        failOnce(`other:${w.code}`, "internal", e?.message, w.code);
        await wait(backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  async function perform(w, item) {
    if (item.op === "open") return openPost(w, item);
    if (item.op === "send") {
      if (item.needsPost) {
        await openPost(w, { members: w.members }, { fresh: true });
        item.needsPost = false;
      }
      return relay(w, item);
    }
    if (item.op === "close") return closePost(w, item);
    if (item.op === "lost") return sayLost(w, item);
  }

  // Whether Discord already holds this post, looked for after the last message known to be
  // ours: its id, false when it is not there, null when that cannot be told.
  async function readBack(rs, username, content) {
    let after = rs.lastMsgId ?? rs.threadId;
    for (let page = 0; page < READBACK_PAGES; page++) {
      let list;
      try {
        list = await discord.fetchMessages(rs.threadId, { after, limit: 100 });
      } catch (e) {
        if (e?.kind === "permission") return null;
        throw e;
      }
      const hit = list.find((m) => m.webhookId && m.username === username && m.content.trim() === content.trim());
      if (hit) return hit.id;
      if (list.length < 100) return false;
      after = list.at(-1).id;
    }
    return null;
  }

  // Every post into a room's thread goes through here (#199 I8, I9). The intent is durable
  // before the post. An intent found on the way in means a run may have been cut off after
  // Discord took it, so the thread is read back and a post already there is taken, not made
  // again: webhook execute has no idempotency key. An intent for another post (a line cut
  // off, then a divider first after the restart) is settled before it is replaced: when
  // Discord holds it, that is kept in `taken` for its own site. `apply` records the post's
  // effect in the same save that clears the intent. A read-back error is retried, never
  // posted past. One refused for permission posts and says so: with state intact that
  // repeats at most the one post whose intent was pending; with state lost (replay) every
  // owed line Discord took but the app had not seen ACKed is posted again, once each.
  async function postOnce(w, rs, { key, username, content, ...extra }, apply = () => {}) {
    const finish = (id, keep, anchor = true) => {
      if (id && anchor) rs.lastMsgId = id;
      if (!keep) delete rs.pending;
      apply(rs, id ?? null);
      save();
      return id ?? null;
    };
    if (rs.taken?.key === key) {
      const { id } = rs.taken;
      delete rs.taken;
      return finish(id, rs.pending?.key === "replay", false);
    }
    let intent = rs.pending;
    if (intent && intent.key !== key && intent.key !== "replay") {
      const found = await readBack(rs, intent.username, intent.content);
      if (found) {
        rs.lastMsgId = found;
        rs.taken = { key: intent.key, id: found };
      } else if (found === null) unreadable(w);
      delete rs.pending;
      save();
      intent = null;
    }
    if (intent?.key === key) ({ username, content } = intent);
    if (intent) {
      const found = await readBack(rs, username, content);
      // A child that lost its state reads back every line it is handed until one is missing.
      if (found) return finish(found, intent.key === "replay");
      if (found === null) unreadable(w);
    }
    rs.pending = { key, username, content, ...extra };
    save();
    const sent = await discord.sendWebhook({
      forumId: rs.forumId,
      threadId: rs.threadId,
      username,
      content,
      allowedMentions: { parse: [] },
    });
    return finish(sent?.id, false);
  }

  function unreadable(w) {
    failOnce(`readback:${w.code}`, "readback_unavailable", "Discord would not let the bot read the post back; a line cut off mid-post may appear twice.", w.code);
  }

  async function openPost(w, item, { fresh = false } = {}) {
    const forum = forumId;
    if (!forum) throw Object.assign(new Error("no forum"), { kind: "missing" });
    // An open that already did its Discord work and only failed to save is not done twice:
    // a retry saves, and posts no second post or divider (#199 r6).
    if (item.opened) {
      settle();
      w.open = true;
      send({ t: "connected", room: w.code, threadId: state.rooms[w.code]?.threadId, reopened: item.opened === "reopened" });
      return;
    }
    let rs = state.rooms[w.code];
    if (item.createdAt != null && (rs || state.rooms[`${w.code}@${item.createdAt}`]) && rs?.createdAt !== item.createdAt) {
      // The record under the bare code is another instance's. It is set aside under its own
      // instance, and this one's own record, if set aside earlier, comes back — so a restarted
      // child handed a reused code's earlier, draining instance before its live one loses
      // neither's progress (#199 r6). Only a NEWER instance ends the one it displaces (kept to
      // its 30-day delete); an older one coming back for its last lines leaves the live one
      // open. A stored post with no instance is never taken for a named one.
      const back = state.rooms[`${w.code}@${item.createdAt}`];
      if (rs) {
        const newer = rs.createdAt == null || item.createdAt > rs.createdAt;
        state.rooms[`${w.code}@${rs.createdAt}`] = { ...rs, closedAt: newer ? (rs.closedAt ?? clock.now()) : rs.closedAt };
        delete state.rooms[w.code];
      }
      if (back) {
        state.rooms[w.code] = back;
        delete state.rooms[`${w.code}@${item.createdAt}`];
      }
      save();
      rs = state.rooms[w.code];
      w.open = false;
    }
    if (w.open && !fresh && rs) {
      send({ t: "connected", room: w.code, threadId: state.rooms[w.code].threadId, reopened: false });
      return;
    }
    // Handed a closed post's instance with nothing to say but its close — a replay after a
    // child died between closing it and saying `closed` — it is left closed, not reopened
    // to be closed twice (#199 I12).
    const next = w.queue[w.queue.indexOf(item) + 1];
    if (rs?.threadId && (rs.closedAt || rs.closing) && !fresh && item.createdAt != null && rs.createdAt === item.createdAt && next?.op === "close" && next.inst === item.createdAt) {
      send({ t: "connected", room: w.code, threadId: rs.threadId, reopened: false });
      return;
    }
    const tags = await tagsFor(forum);
    if (rs?.threadId && !fresh && (rs.forumId ?? forum) === forum) {
      const thread = await discord.fetchThread(rs.threadId);
      if (thread) {
        await discord.editThread(rs.threadId, { archived: false, appliedTags: [tags.open] });
        const divider = rs.closedAt ? `— Reconnected (away ${awayText(clock.now() - rs.closedAt)}) —` : "— Reconnected —";
        rs.forumId = forum;
        await postOnce(w, rs, { key: "divider", username: "Room", content: divider }, (r) => {
          r.closedAt = null;
          delete r.closing;
          item.opened = "reopened";
        });
        w.open = true;
        send({ t: "connected", room: w.code, threadId: rs.threadId, reopened: true });
        return;
      }
    }
    const members = (item.members ?? []).join(", ") || "—";
    const instance = item.createdAt ?? rs?.createdAt ?? w.createdAt ?? null;
    // Every post says which room instance it is, on its last line, so a post created by a
    // run that died before saving it is found again rather than made twice.
    const marker = postMarker(w.code, instance);
    let threadId = await adoptPost(forum, w.code, marker, tags);
    const adopted = Boolean(threadId);
    // A batch recovered from an earlier launch with no post known or found and nothing to say
    // but its close makes no post just to close it (#199 I10).
    if (!threadId && item.resume && !rs?.threadId && next?.op === "close" && next.inst === item.createdAt) return;
    if (!threadId) {
      const head = `Room ${w.code}\nMembers: ${members}`.slice(0, MESSAGE_LIMIT - marker.length - 1);
      threadId = await discord.createPost(forum, {
        name: postName(w.code),
        content: `${head}\n${marker}`,
        appliedTags: [tags.open],
      });
    }
    // The read-back anchor. A post adopted with no record of this instance may already hold
    // lines the app still owes (state lost): every line handed over is read back from the
    // app's anchor until one is missing (#199 I9c).
    const same = rs?.threadId === threadId;
    state.rooms[w.code] = {
      threadId,
      forumId: forum,
      lastSeq: rs?.lastSeq ?? item.resume?.lastAcked ?? 0,
      lastMsgId: same ? (rs.lastMsgId ?? threadId) : !rs && adopted ? (item.resume?.lastMsgId ?? threadId) : threadId,
      ...(same && rs.pending ? { pending: rs.pending } : !rs && adopted ? { pending: { key: "replay" } } : {}),
      openedAt: clock.now(),
      closedAt: null,
      createdAt: item.createdAt ?? rs?.createdAt ?? null,
    };
    item.opened = "created";
    save();
    w.open = true;
    send({ t: "connected", room: w.code, threadId, reopened: false });
  }

  /** This instance's post if Discord already has it: the oldest kept, any later one closed. */
  async function adoptPost(forum, code, marker, tags) {
    const { found: posts, complete } = await discord.findPosts(forum, { name: postName(code), marker });
    // Said, not hidden: the room still connects, and may get a second post.
    if (!complete) fail("reconcile_incomplete", "Not every older post could be checked for this room; it may get a second post.", code);
    const found = posts.sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
    if (!found.length) return null;
    const [kept, ...extra] = found;
    for (const dup of extra) {
      await discord.editThread(dup.id, { archived: true, appliedTags: [tags.closed] });
      state.rooms[`dup@${dup.id}`] = { threadId: dup.id, forumId: forum, lastSeq: 0, openedAt: dup.createdAt, closedAt: clock.now(), createdAt: null };
      save();
    }
    if (kept.archived) await discord.editThread(kept.id, { archived: false, appliedTags: [tags.open] });
    return kept.id;
  }

  async function postInstead(w, item, reason) {
    const rs = state.rooms[w.code];
    const why = String(reason ?? "refused").replace(/\s+/g, " ").slice(0, 200);
    const content = `(message #${item.m.seq} from ${item.m.sender} could not be posted: ${why})`;
    const msgId = await postOnce(w, rs, { key: `instead:${item.m.seq}`, username: "Room", content }, (r) => {
      r.lastSeq = item.m.seq;
      dropParts(r);
    });
    acked(w, item.m.seq, item.inst, msgId);
  }

  function dropParts(r) {
    delete r.partSeq;
    delete r.lastPart;
    delete r.partDelayed;
  }

  async function relay(w, item) {
    const rs = state.rooms[w.code];
    if (!rs?.threadId) throw Object.assign(new Error("no post"), { kind: "missing" });
    const seq = item.m.seq;
    if (rs.lastSeq >= seq) {
      settle();
      acked(w, seq, item.inst, rs.lastMsgId ?? rs.threadId);
      return;
    }
    if (item.sent === 0) {
      // A seq a previous run had started: its parts are cut the same way again (the same
      // "(delayed)" choice, saved with its first intent), and the ones Discord already
      // accepted are not sent again.
      const intent = rs.pending?.key?.startsWith("line:") && rs.pending.seq === seq ? rs.pending : null;
      const resumed = rs.partSeq === seq && Number.isInteger(rs.lastPart) && rs.lastPart > 0;
      let delayed = intent ? intent.delayed === true : resumed ? rs.partDelayed === true : clock.now() - item.at > DELAYED_MS;
      // A child that lost its state cannot know whether an earlier run marked this line
      // "(delayed)": the copy Discord holds is looked for under the other mark too, and when
      // found that is the text the line keeps (#199 I9c).
      if (!intent && !resumed && rs.pending?.key === "replay") {
        const other = formatMessage(item.m, !delayed);
        if (await readBack(rs, other.username, splitContent(other.content)[0])) delayed = !delayed;
      }
      const { username, content } = formatMessage(item.m, delayed);
      item.username = username;
      item.parts = splitContent(content);
      item.delayed = delayed;
      if (intent) item.sent = Math.min(intent.part, item.parts.length);
      else if (resumed) item.sent = Math.min(rs.lastPart, item.parts.length);
    }
    // Part k+1 is not sent until part k's acceptance and its message id are durable, so a
    // restart resends at most the one part whose intent was saved — and the read-back in
    // `postOnce` takes even that one when Discord already holds it.
    let msgId = null;
    const finished = (r) => {
      r.lastSeq = seq;
      dropParts(r);
    };
    for (let i = item.sent; i < item.parts.length; i++) {
      settle();
      const last = i + 1 === item.parts.length;
      const after = (r) => {
        item.sent = i + 1;
        if (last) finished(r);
        else Object.assign(r, { partSeq: seq, lastPart: i + 1, partDelayed: item.delayed });
      };
      if (item.parts[i]) {
        msgId = await postOnce(w, rs, { key: `line:${seq}:${i}`, seq, part: i, delayed: item.delayed, username: item.username, content: item.parts[i] }, after);
      } else after(rs);
    }
    if (rs.lastSeq < seq) {
      finished(rs);
      save();
    }
    settle();
    acked(w, seq, item.inst, msgId ?? rs.lastMsgId ?? null);
  }

  // The app is ending the relay (Remove) and these lines will not be delivered: the post
  // says which, once, before its close, and they count as taken (#199 I21).
  async function sayLost(w, item) {
    const rs = state.rooms[w.code];
    if (!rs?.threadId) return;
    settle();
    const owed = item.items.filter((it) => it.m.seq > (rs.lastSeq ?? 0));
    const last = Math.max(...item.items.map((it) => it.m.seq));
    const taken = (r) => {
      r.lastSeq = Math.max(r.lastSeq ?? 0, last);
      dropParts(r);
    };
    let msgId = null;
    if (owed.length) {
      const n = owed.length;
      const content = `${n} message${n === 1 ? "" : "s"} not relayed: ${notRelayed(owed.map((it) => it.m))}`;
      msgId = await postOnce(w, rs, { key: `lost:${last}`, username: "Room", content }, taken);
    } else {
      taken(rs);
      save();
    }
    acked(w, last, item.inst, msgId);
  }

  function endRelay() {
    for (const w of workers.values()) {
      const at = w.queue.findIndex((item) => item.op === "close");
      if (at < 0) continue;
      const from = w.running ? 1 : 0;
      const inst = w.queue[at].inst;
      const items = w.queue.slice(from, at).filter((item) => item.op === "send" && item.inst === inst);
      if (!items.length) continue;
      const rest = w.queue.slice(from, at).filter((item) => !items.includes(item));
      w.queue.splice(from, at - from, ...rest, { op: "lost", items, inst });
    }
  }

  async function closePost(w, item) {
    const rs = state.rooms[w.code];
    // Said back once the close is durable — or when there is no post to close, or this
    // instance's post was already closed by an earlier run — so the app keeps the close
    // until then and hands it to the next child otherwise (#199 I12).
    const done = () => {
      w.open = false;
      send({ t: "closed", room: w.code, createdAt: item.inst ?? null, id: item.id });
    };
    if (!rs?.threadId) return done();
    if (rs.closedAt && !rs.closing && item.inst != null && rs.createdAt === item.inst && !w.open) {
      settle();
      return done();
    }
    // The intent first: a closing line Discord took before an archive or a save failed is
    // found again by its intent, here or after a restart, and not posted twice (#199 I12).
    if (rs.closing?.id !== item.id) {
      rs.closing = { id: item.id, reason: item.reason };
      save();
    }
    try {
      if (!rs.closing.said) {
        await postOnce(w, rs, { key: `close:${item.id}`, username: "Room", content: CLOSE_TEXT[item.reason] }, (r) => {
          r.closing.said = true;
        });
      }
      const tags = await tagsFor(rs.forumId ?? forumId);
      await discord.editThread(rs.threadId, { archived: true, appliedTags: [tags.closed] });
    } catch (e) {
      // A post someone deleted is closed already; waiting on it would hold the room's
      // queue on every launch (#199 C9).
      if (e?.kind !== "missing") throw e;
      delete rs.pending;
    }
    rs.closedAt = clock.now();
    delete rs.closing;
    save();
    done();
  }

  function handle(msg) {
    if (stopped || !msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      if (started) return;
      if (msg.v !== PROTOCOL || typeof msg.token !== "string" || typeof msg.statePath !== "string") {
        return fail("internal", "Bad hello line.");
      }
      started = true;
      token = msg.token;
      statePath = msg.statePath;
      forumId = msg.forumId ?? null;
      ownerId = msg.ownerId ?? null;
      const loaded = readState(statePath);
      state = loaded.state;
      if (loaded.blocked) {
        // Not read, so not replaced — and with nowhere to record progress nothing is posted
        // either, or a restart could repeat any number of parts (#199 r5). Fails closed until
        // the file is fixed and the connector starts again.
        storageBlocked = `The Discord state file could not be read (${loaded.blocked}); nothing is posted until it is fixed.`;
        fail("storage_blocked", storageBlocked);
        statePath = null;
      }
      if (loaded.aside) {
        fail("internal", `The Discord state file could not be read and was kept aside as ${loaded.aside}; posts will be found again by their marker.`);
      }
      start().catch((e) => fail("internal", e?.message));
      return;
    }
    if (!started) return fail("internal", "Expected hello first.");
    switch (msg.t) {
      case "forum":
        forumId = msg.forumId ?? null;
        wakeForum();
        return;
      case "owner":
        ownerId = msg.ownerId ?? null;
        if (awaitingOwner && msg.round === awaitingOwner.round && msg.ownerId === awaitingOwner.userId) {
          awaitingOwner.reply?.("Paired with Gyredeck.")?.catch?.(() => {});
          awaitingOwner = null;
        }
        return;
      case "pair":
        if (!/^\d{6}$/.test(String(msg.code))) return fail("internal", "Pairing code must be 6 digits.");
        if (!/^[0-9a-f]{16,64}$/.test(String(msg.round))) return fail("internal", "Pairing needs its round.");
        pairing = { code: String(msg.code), round: String(msg.round), expiresAt: clock.now() + PAIR_MS, misses: 0 };
        return;
      case "connect": {
        if (typeof msg.room !== "string" || !msg.room) return fail("room_unknown", "connect needs a room.");
        if (!forumId) return fail("no_forum", "Pick a forum channel first.", msg.room);
        // Which room this is, not only its code: without it a reused code could be put in the
        // earlier room's post, so a connect that does not say is refused (#199 r4).
        if (!Number.isFinite(msg.createdAt)) return fail("room_unknown", "connect needs the room's createdAt.", msg.room);
        if (storageBlocked) return fail("storage_blocked", storageBlocked, msg.room);
        const w = worker(msg.room);
        const createdAt = msg.createdAt;
        const known = w.createdAt ?? state.rooms[msg.room]?.createdAt ?? null;
        if (createdAt != null && known != null && createdAt !== known) w.highSeq = 0;
        if (createdAt != null) w.createdAt = createdAt;
        w.accepting = true;
        w.members = Array.isArray(msg.members) ? msg.members.map(String) : [];
        const r = msg.resume;
        const resume = r && typeof r === "object" && Number.isFinite(r.lastAcked)
          ? { lastAcked: r.lastAcked, lastMsgId: typeof r.lastMsgId === "string" && r.lastMsgId ? r.lastMsgId : null }
          : null;
        return enqueue(w, { op: "open", members: w.members, createdAt, resume });
      }
      case "message": {
        // Refused at connect for storage, and said then: no `room_unknown` per message on top,
        // which would bury the reason (#199 r6).
        if (storageBlocked) return;
        const w = workers.get(msg.room);
        if (!w?.accepting) return fail("room_unknown", "That room is not connected.", msg.room);
        const seq = Number(msg.seq);
        if (!Number.isFinite(seq)) return;
        if (seq <= w.highSeq) {
          // Already on Discord: said again, because the app keeps every line until it is
          // acknowledged and hands them all to a restarted child (#199). A seq still queued
          // here is acknowledged when it posts.
          const rs = state.rooms[msg.room];
          if (seq <= (rs?.lastSeq ?? 0)) acked(w, seq, w.createdAt, rs.lastMsgId ?? rs.threadId ?? null);
          return;
        }
        w.highSeq = seq;
        const m = { seq, sender: String(msg.sender ?? ""), to: String(msg.to ?? "everyone"), kind: String(msg.kind ?? "tell"), text: String(msg.text ?? "") };
        // Held since the room said it, not since this child was handed it: a line kept over a
        // quit reaches Discord at the next launch marked "(delayed)" (#199 I3).
        const said = typeof msg.ts === "string" ? Date.parse(msg.ts) : NaN;
        const at = Number.isFinite(said) ? Math.min(said, clock.now()) : clock.now();
        return enqueue(w, { op: "send", m, at, sent: 0, inst: w.createdAt });
      }
      case "end":
        return endRelay();
      case "disconnect": {
        const w = workers.get(msg.room);
        if (!w?.accepting) return fail("room_unknown", "That room is not connected.", msg.room);
        w.accepting = false;
        const reason = msg.reason === "closed" || msg.reason === "ended" ? msg.reason : "disconnected";
        return enqueue(w, { op: "close", reason, id: typeof msg.id === "string" && msg.id ? msg.id : null, inst: w.createdAt });
      }
      default:
        return fail("internal", `Unknown message type ${String(msg.t).slice(0, 40)}.`);
    }
  }

  // A close already handed over is finished before stopping, within what the app grants a
  // child at its stdin's end: else every quit leaves each followed post open (#199 I12).
  async function close() {
    if (stopped || closing) return;
    closing = true;
    const pending = [...workers.values()].filter((w) => w.running && w.queue.some((item) => item.op === "close"));
    if (pending.length) {
      const finished = Promise.all(pending.map((w) => w.idle));
      await Promise.race([finished, wait(CLOSE_GRACE_MS)]);
    }
    stopped = true;
    pairing = null;
    if (sweepTimer) clock.clearTimeout(sweepTimer);
    sweepTimer = null;
    releaseReady();
    wake(false);
    await discord.destroy();
  }

  return {
    handle,
    close,
    redact,
    get ownerId() {
      return ownerId;
    },
  };
}
