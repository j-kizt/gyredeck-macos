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
/** How long a ✅ on a disconnect or quiet prompt still counts (#205). */
export const PROMPT_MS = 10 * 60_000;
/** At most this many /disconnect prompts are kept armed; quiet ones are one per room. */
const PROMPTS_MAX = 20;
const SETTLE_MIN_MS = 5_000;
const SETTLE_MAX_MS = 60_000;
/** The bridge's MAIL_MAX_TEXT: a longer say is refused here, never cut. */
export const SAY_MAX_TEXT = 4_096;
/** Relayed messages remembered per room, so a Reply or a reaction can name what it answers. */
export const RELAYED_MAX = 500;
const SPOKEN_MAX = 500;
export const EDIT_NOTE = "Edits are not sent to the room; send a new message.";
export const OWNER_VOICE = "gyredeck-owner-discord";
export const YES = "✅";
export const NO = "❌";
export const SENT = "📨";
const NEEDS_YOU = "needs you";
const TAGS = ["open", "closed", NEEDS_YOU];
export const COMMANDS = [
  {
    name: "disconnect",
    description: "Stop following this room in Discord (the room stays open)",
  },
];
const AUX = /^(is|are|am|was|were|do|does|did|can|could|will|would|shall|should|may|might|must|have|has|had|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|couldn't|won't|wouldn't|shouldn't|haven't|hasn't|hadn't|ok|okay)\b/i;

// A yes/no question: the text ends with "?", and its last sentence opens with an auxiliary
// verb (is/can/should/…, or "ok"/"okay") and offers no " or " choice. "Should I merge?" is
// one; "Which file?" and "Should I merge A or B?" are not.
export function isYesNo(text) {
  const t = String(text ?? "").trim();
  if (!t.endsWith("?")) return false;
  const last = t.slice(0, -1).split(/[.!?\n]/).at(-1).trim().replace(/^[^\p{L}]+/u, "");
  return AUX.test(last) && !/\bor\b/i.test(last);
}

// "@Name: text" or "Name: text" at the very start addresses Name; anything else is for
// everyone. The colon is what ends the name: without it "@Gyre Assistant please reply" could
// mean a member called Gyre Assistant or one called Gyre, and a guess sends it to the wrong
// one (#205 audit; the owner chose "a colon, always"). With no colon it goes to everyone.
export function parseAddress(text) {
  const named = /^@?([^\s:@<][^:\n]{0,63}):\s+([\s\S]*)$/.exec(text);
  if (named) return { to: named[1].trim(), text: named[2].trim() };
  return null;
}
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

export function formatMessage(m, delayed, mention = null) {
  if (m.kind === "notice") {
    return { username: "Room", content: delayed ? `(delayed)\n${m.text}` : m.text };
  }
  return {
    username: webhookName(m.sender),
    content: `${mention ? `<@${mention}> ` : ""}→ ${m.to} · ${m.kind}${delayed ? " (delayed)" : ""}\n${m.text}`,
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
  let promptSeq = 0;
  let gatewayEpoch = 0;
  // Owner messages sent to the room, by Discord id → whether the "edits" note was posted.
  const spoken = new Map();
  // Rooms whose saved says this child has sent again since it started.
  const resaid = new Set();

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
    // A new session: nothing read before it stands for it (#205 audit, seq 136).
    gatewayEpoch++;
    read.clear();
    reported.delete("down");
    wake(true);
    // Reactions given while the gateway was down never arrive as events: read them (#205 r7).
    if (identity && !stopped) settleAll();
  });
  discord.on("offline", () => {
    online = false;
    gatewayEpoch++;
    read.clear();
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

  // ── the owner speaking (#205) ──

  discord.on("post", (p) => {
    if (stopped || !ownerId || p.authorId !== ownerId) return;
    const code = roomOfThread(p.channelId);
    if (!code) return;
    if (!workers.get(code)?.accepting) return botReply(p.channelId, p.messageId, "Not sent: this room is no longer connected to Discord.");
    const rs = state.rooms[code];
    const body = String(p.text ?? "").trim();
    const relayed = p.replyToId ? (rs.relayed ?? []).find((r) => r.id === p.replyToId) : null;
    // A Reply to something not in the map (too old, or not a room line) is never sent to
    // everyone instead: who it answers cannot be told (#205 audit).
    if (p.replyToId && !relayed) {
      return botReply(p.channelId, p.messageId, "Not sent: I cannot tell which room message this replies to (it may be too old). Send it again without Reply, or start it with Name: and the text.");
    }
    let say;
    if (relayed) say = { kind: "ask", to: relayed.senderId || relayed.sender, replyToSeq: relayed.seq, text: body };
    else {
      const addressed = parseAddress(body);
      say = addressed ? { kind: "ask", ...addressed } : { kind: "tell", to: "everyone", text: body };
    }
    if (!say.text) return botReply(p.channelId, p.messageId, "Not sent: there is no text to send.");
    if (say.text.length > SAY_MAX_TEXT) {
      return botReply(p.channelId, p.messageId, `Not sent: a room message is at most ${SAY_MAX_TEXT} characters and this one is ${say.text.length}. Split it.`);
    }
    sayToRoom(code, p.channelId, p.messageId, say);
  });
  discord.on("edit", (e) => {
    if (stopped || !ownerId || e.authorId !== ownerId || !roomOfThread(e.channelId)) return;
    if (spoken.get(e.messageId) !== false) return;
    spoken.set(e.messageId, true);
    botReply(e.channelId, e.messageId, EDIT_NOTE);
  });
  discord.on("reaction", (r) => onReaction(r));
  function onReaction(r, searched = false) {
    if (stopped || !ownerId || r.userId !== ownerId) return;
    const prompt = prompts()[r.messageId];
    // A prompt Discord may hold that no search has found yet: look again now, when it is needed,
    // so one failed search never leaves a prompt on show that cannot be answered (#205 r4).
    // The ✅ itself is looked at again once the search is done, whichever search armed it.
    if (!prompt && !searched && r.emoji === YES && Object.keys(posting()).length) {
      settleAll().then(() => onReaction(r, true));
      return;
    }
    if (prompt) {
      if (r.emoji !== YES || prompt.used || prompt.askedOf !== ownerId || clock.now() > prompt.expiresAt) return;
      const w = workers.get(prompt.room);
      if (prompt.all || !(w?.accepting && w.createdAt === prompt.inst)) return;
      // Used up on disk before it is acted on: a restart never requests it a second time. A
      // quiet one is kept, used, so its spell is not asked about again.
      if (prompt.quiet) prompts()[r.messageId] = { ...prompt, used: true };
      else delete prompts()[r.messageId];
      try {
        save();
      } catch (e) {
        prompts()[r.messageId] = prompt;
        return fail("storage_blocked", e?.message);
      }
      const from = { ownerId: r.userId, ...(prompt.threadId ? { threadId: prompt.threadId } : {}) };
      return send({ t: "disconnect_request", room: prompt.room, createdAt: prompt.inst, ...(prompt.quiet ? { quiet: true } : {}), ...from });
    }
    // Any emoji but these two does nothing (#205).
    if (r.emoji !== YES && r.emoji !== NO) return;
    const code = roomOfThread(r.channelId);
    if (!code || !workers.get(code)?.accepting) return;
    const relayed = (state.rooms[code].relayed ?? []).find((m) => m.id === r.messageId);
    if (!relayed) return;
    const to = relayed.senderId || relayed.sender;
    if (relayed.kind === "tell" && r.emoji === YES) {
      return sayToRoom(code, r.channelId, r.messageId, { kind: "reaction", to, replyToSeq: relayed.seq, text: "acknowledged" });
    }
    if (relayed.kind !== "ask") return;
    if (!relayed.yn) return botReply(r.channelId, r.messageId, "This question needs a typed reply");
    sayToRoom(code, r.channelId, r.messageId, { kind: "tell", to, replyToSeq: relayed.seq, text: r.emoji === YES ? "yes" : "no" });
  }
  discord.on("command", (c) => {
    if (stopped || c.name !== "disconnect") return;
    command(c).catch((e) => fail("internal", e?.message));
  });

  async function command(c) {
    const refuse = (content) => c.reply({ content, ephemeral: true });
    if (!ownerId || c.userId !== ownerId) return refuse("Only the paired owner can disconnect rooms.");
    // A post acts on its own room only: every room at once is the app's Settings button (owner,
    // 2026-11-02). An `all` option left over from an older registration is ignored.
    const code = roomOfThread(c.channelId);
    if (!code || !workers.get(code)?.accepting) return refuse("Run /disconnect inside a connected room's post.");
    const content = `Disconnect ${code}? If no other room is connected the Mac may sleep, and you cannot reconnect until you are back at it.`;
    const target = { room: code, inst: workers.get(code).createdAt, threadId: c.channelId };
    const full = `${content}\nReact ${YES} within 10 minutes to confirm.`;
    // Unsettled intents are bounded too: a new prompt waits rather than one on show going quiet.
    if (Object.keys(posting()).filter((k) => k.startsWith("cmd:")).length >= PROMPTS_MAX) {
      return refuse("Earlier /disconnect prompts are still being checked with Discord. Try again in a minute.");
    }
    const msg = await postPrompt(`cmd:${++promptSeq}@${clock.now()}`, c.channelId, full, target, () => c.reply({ content: full, ephemeral: false }));
    if (msg?.id) await discord.react({ threadId: c.channelId, messageId: msg.id, emoji: YES }).catch(() => {});
  }

  // Armed ✅ prompts (/disconnect, gone quiet), by the prompt's Discord id, kept in the state
  // file: a prompt the owner can see still works after a restart (#205 r3). A quiet one stays
  // until its spell ends, so a restart in the same spell posts no second one.
  function prompts() {
    return (state.prompts ??= {});
  }
  function posting() {
    return (state.promptPosting ??= {});
  }
  function arm(id, prompt) {
    const now = clock.now();
    const all = prompts();
    for (const [key, p] of Object.entries(all)) if (!p.quiet && now > p.expiresAt) delete all[key];
    all[id] = prompt;
    const asked = Object.entries(all).filter(([, p]) => !p.quiet).sort(([, a], [, b]) => a.expiresAt - b.expiresAt);
    for (const [key] of asked.slice(0, Math.max(0, asked.length - PROMPTS_MAX))) delete all[key];
  }
  // The intent is durable before the post, so a post Discord took but this child never heard
  // back from is found again by `settlePosting` and armed, not left on show unanswerable.
  async function postPrompt(key, channelId, content, meta, post) {
    const intent = { channelId, content, sinceMs: clock.now(), meta: { ...meta, channelId, askedOf: ownerId, expiresAt: clock.now() + PROMPT_MS } };
    posting()[key] = intent;
    save();
    const msg = await post();
    // Cancelled while it was being posted (a re-pair): it is on show, so say it does not work.
    if (posting()[key] !== intent) {
      if (msg?.id) voided(channelId, msg.id);
      return null;
    }
    delete posting()[key];
    if (msg?.id) {
      arm(msg.id, intent.meta);
      read.add(msg.id);
    }
    save();
    return msg;
  }
  async function settlePosting(key) {
    const intent = posting()[key];
    if (!intent) return;
    if (clock.now() > intent.meta.expiresAt) {
      delete posting()[key];
      return save();
    }
    const id = await discord.findOwn(intent.channelId, { content: intent.content, sinceMs: intent.sinceMs });
    if (posting()[key] !== intent) {
      if (id && intent.meta.askedOf !== ownerId) voided(intent.channelId, id);
      return;
    }
    delete posting()[key];
    if (id) arm(id, intent.meta);
    save();
  }
  // Every intent not yet settled. One that cannot be searched now is tried again in the
  // background, backing off, until it is armed, found absent, or past its prompt's life (#205 r4).
  let settleTimer = null;
  let settleBackoff = SETTLE_MIN_MS;
  // A ✅ is a state Discord keeps, not an event this child must have heard: each armed prompt
  // this child has not seen posted is read once its room is followed again, and a ✅ already on
  // it counts then (#205 r6). Event and read both end in `onReaction`, which uses a prompt once.
  const read = new Set();
  async function readPrompt(id) {
    const p = prompts()[id];
    if (!p || p.used || read.has(id) || !p.channelId || clock.now() > p.expiresAt) return;
    const w = workers.get(p.room);
    if (p.all || !(w?.accepting && w.createdAt === p.inst)) return;
    // An answer is only good for the gateway session it was asked under: one that comes back
    // after a drop is dropped, and the read after the drop asks again (#205 r7). Whose ✅ it was
    // is `onReaction`'s to check, the one door every ✅ goes through.
    const asked = { owner: ownerId, epoch: gatewayEpoch };
    const given = await discord.reactedBy({ channelId: p.channelId, messageId: id, emoji: YES, userId: asked.owner });
    if (gatewayEpoch !== asked.epoch) return;
    read.add(id);
    if (given) onReaction({ messageId: id, channelId: p.channelId, userId: asked.owner, emoji: YES }, true);
  }

  // A prompt is asked of the owner paired when it was posted. A re-pair cancels every other
  // owner's prompt and intent, in memory first so a save that fails cannot bring one back here,
  // and says so on the prompts still on show (#205 r7).
  function cancelOthers() {
    for (const [id, p] of Object.entries(prompts())) {
      if (p.askedOf === ownerId) continue;
      delete prompts()[id];
      if (p.channelId) voided(p.channelId, id);
    }
    for (const [key, i] of Object.entries(posting())) if (i.meta.askedOf !== ownerId) delete posting()[key];
    read.clear();
    try {
      save();
    } catch (e) {
      fail("storage_blocked", e?.message);
    }
  }
  function voided(channelId, messageId) {
    discord.botEdit({ channelId, messageId, content: "This prompt no longer works: the paired owner changed." }).catch(() => {});
  }

  // One search at a time: two never race over the same intent (#205 r5).
  let settling = Promise.resolve();
  function settleAll() {
    settling = settling.then(settleOnce, settleOnce);
    return settling;
  }
  async function settleOnce() {
    let failed = false;
    for (const key of Object.keys(posting())) {
      await settlePosting(key).catch((e) => {
        failed = true;
        fail("internal", `Could not look for an earlier prompt: ${e?.message}`);
      });
    }
    for (const id of Object.keys(prompts())) {
      await readPrompt(id).catch((e) => {
        failed = true;
        fail("internal", `Could not read the reactions on a prompt: ${e?.message}`);
      });
    }
    if (!failed) settleBackoff = SETTLE_MIN_MS;
    if (!failed || stopped || settleTimer) return;
    settleTimer = clock.setTimeout(() => {
      settleTimer = null;
      if (!stopped) settleAll();
    }, settleBackoff);
    settleBackoff = Math.min(settleBackoff * 2, SETTLE_MAX_MS);
  }

  // Work resuming disarms the room's quiet prompt; the next spell asks again.
  function dropQuietPrompts(code) {
    for (const [id, p] of Object.entries(prompts())) if (p.quiet && p.room === code) delete prompts()[id];
    delete posting()[`quiet:${code}`];
    save();
  }

  // The room whose current post this is: never a set-aside instance (`code@createdAt`).
  function roomOfThread(threadId) {
    if (!threadId) return null;
    for (const [code, rs] of Object.entries(state.rooms)) if (rs.threadId === threadId && !code.includes("@")) return code;
    return null;
  }

  // Saved before it is sent, and kept until its receipt is in the post: a child that dies in
  // between sends it again with the same Discord id, which the bridge answers with the seq
  // it already has (#205 r1).
  function sayToRoom(code, threadId, discordMessageId, say) {
    const rs = state.rooms[code];
    const { kind, to, text, replyToSeq } = say;
    // The owner who typed it is kept with it: a retry after the owner changed carries the old
    // id, which the app's Keychain check refuses (#205 audit).
    const line = { room: code, threadId, discordMessageId, ownerId, kind, to, text, ...(replyToSeq != null ? { replyToSeq } : {}) };
    (rs.saying ??= []).push(line);
    try {
      save();
    } catch (e) {
      rs.saying.pop();
      return botReply(threadId, discordMessageId, `Not sent: Gyredeck could not save it first (${e?.message}).`);
    }
    spoken.delete(discordMessageId);
    spoken.set(discordMessageId, false);
    while (spoken.size > SPOKEN_MAX) spoken.delete(spoken.keys().next().value);
    send({ t: "say", ...line });
  }

  function botReply(threadId, replyTo, content) {
    discord
      .botSend({ threadId, content, replyTo, allowedMentions: { parse: [], repliedUser: false } })
      .catch((e) => fail(e?.kind === "permission" ? "missing_permission" : "internal", `Could not reply in Discord: ${e?.message}`));
  }

  // What became of a say: in the room's queue, behind what it is already posting, so a
  // Discord that is down holds the receipt instead of losing it.
  function said(msg) {
    const id = String(msg.discordMessageId ?? "");
    const code = Object.keys(state.rooms).find((c) => !c.includes("@") && (state.rooms[c].saying ?? []).some((l) => l.discordMessageId === id));
    if (!code) return;
    enqueue(worker(code), { op: "receipt", id, ok: msg.ok === true && Number.isInteger(msg.seq), error: msg.error, names: msg.names });
  }

  async function receipt(w, item) {
    const rs = state.rooms[w.code];
    const at = (rs?.saying ?? []).findIndex((l) => l.discordMessageId === item.id);
    if (at < 0) return;
    const line = rs.saying[at];
    try {
      if (item.ok) {
        await discord.react({ threadId: line.threadId, messageId: item.id, emoji: SENT });
        if (rs.needsYou && rs.threadId === line.threadId) {
          const tags = await tagsFor(rs.forumId ?? forumId);
          await discord.editThread(rs.threadId, { appliedTags: [tags.open] });
          rs.needsYou = false;
        }
      } else {
        const names = Array.isArray(item.names) && item.names.length ? `\nNames that work: ${item.names.map(String).join(", ")}` : "";
        // The app's error is already a sentence written for the post.
        await discord.botSend({
          threadId: line.threadId,
          content: `${String(item.error ?? "Not sent: the room refused it.")}${names}`,
          replyTo: item.id,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }
    } catch (e) {
      // Down or slowed: tried again by the queue. A post or message that is gone, or a
      // refusal, will not change: the receipt is given up rather than holding the room.
      if (e?.kind === "network" || e?.kind === "rate") throw e;
      fail(e?.kind === "permission" ? "missing_permission" : "internal", `Could not answer in Discord: ${e?.message}`, w.code);
    }
    rs.saying.splice(at, 1);
    save();
  }

  // The room's post is open: said to the app first, so a say from it is taken, then the says
  // an earlier child saved and never saw a receipt for are sent again, once per child, for
  // the instance followed now only (#205 r1).
  function opened(w, item, line) {
    send(line);
    if (w.accepting && item.createdAt != null && item.createdAt === w.createdAt) {
      resay(w);
      // A ✅ given while this room was not followed is read from Discord now (#205 r6).
      settleAll();
    }
  }

  function resay(w) {
    if (resaid.has(w.code)) return;
    resaid.add(w.code);
    // A line saved before owners were kept with it names nobody, and is refused, never sent
    // as whoever is paired now.
    for (const line of state.rooms[w.code]?.saying ?? []) send({ t: "say", ...line, ownerId: line.ownerId ?? "", retry: true });
  }

  async function quietPrompt(w) {
    const rs = state.rooms[w.code];
    if (!rs?.threadId || !w.accepting) return;
    const key = `quiet:${w.code}`;
    // A search that fails now is retried in the background; meanwhile none is posted twice.
    await settleAll();
    if (posting()[key] || Object.values(prompts()).some((p) => p.quiet && p.room === w.code)) return;
    const content = `This room has gone quiet. Disconnect? React ${YES} within 10 minutes to disconnect now.`;
    const msg = await postPrompt(key, rs.threadId, content, { room: w.code, inst: w.createdAt, threadId: rs.threadId, quiet: true }, () =>
      discord.botSend({ threadId: rs.threadId, content, allowedMentions: { parse: [] } }),
    );
    if (!msg?.id) return;
    await discord.react({ threadId: rs.threadId, messageId: msg.id, emoji: YES }).catch(() => {});
  }

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
    discord.registerCommands(COMMANDS).catch((e) =>
      fail(e?.kind === "permission" ? "missing_permission" : "internal", `Could not register /disconnect: ${e?.message}`),
    );
    // A prompt Discord may have taken before a restart is found and armed again.
    await settleAll();
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
    if (item.op === "quiet") return quietPrompt(w);
    if (item.op === "receipt") return receipt(w, item);
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
  async function postOnce(w, rs, { key, username, content, ...extra }, apply = () => {}, allowedMentions = { parse: [] }) {
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
      allowedMentions,
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
      opened(w, item, { t: "connected", room: w.code, threadId: state.rooms[w.code]?.threadId, createdAt: item.createdAt ?? null, reopened: item.opened === "reopened" });
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
      opened(w, item, { t: "connected", room: w.code, threadId: state.rooms[w.code].threadId, createdAt: item.createdAt ?? null, reopened: false });
      return;
    }
    // Handed a closed post's instance with nothing to say but its close — a replay after a
    // child died between closing it and saying `closed` — it is left closed, not reopened
    // to be closed twice (#199 I12).
    const next = w.queue[w.queue.indexOf(item) + 1];
    if (rs?.threadId && (rs.closedAt || rs.closing) && !fresh && item.createdAt != null && rs.createdAt === item.createdAt && next?.op === "close" && next.inst === item.createdAt) {
      opened(w, item, { t: "connected", room: w.code, threadId: rs.threadId, createdAt: item.createdAt ?? null, reopened: false });
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
          r.needsYou = false;
          delete r.closing;
          item.opened = "reopened";
        });
        w.open = true;
        opened(w, item, { t: "connected", room: w.code, threadId: rs.threadId, createdAt: item.createdAt ?? null, reopened: true });
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
    opened(w, item, { t: "connected", room: w.code, threadId, createdAt: item.createdAt ?? null, reopened: false });
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
    // The owner's own words are already in the post, as the message they typed (#205).
    if (item.m.senderId === OWNER_VOICE) {
      rs.lastSeq = seq;
      dropParts(rs);
      save();
      acked(w, seq, item.inst, rs.lastMsgId ?? rs.threadId);
      return;
    }
    // An ask to the person pings the paired owner, once, on its first part, and marks the
    // post as waiting on them until their next say lands (#205).
    const mention = item.m.kind === "ask" && item.m.toOwner && ownerId ? ownerId : null;
    if (mention && !rs.needsYou) {
      const tags = await tagsFor(rs.forumId ?? forumId);
      await discord.editThread(rs.threadId, { appliedTags: [tags.open, tags[NEEDS_YOU]] });
      rs.needsYou = true;
      save();
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
        const other = formatMessage(item.m, !delayed, mention);
        if (await readBack(rs, other.username, splitContent(other.content)[0])) delayed = !delayed;
      }
      const { username, content } = formatMessage(item.m, delayed, mention);
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
      const after = (r, id) => {
        item.sent = i + 1;
        // Each part's Discord id, in the same save as its acceptance, so a Reply or a
        // reaction to any part names this seq and its sender (#205).
        if (id && item.m.kind !== "notice") {
          (r.relayed ??= []).push({ id, seq, senderId: item.m.senderId ?? null, sender: item.m.sender, kind: item.m.kind, yn: isYesNo(item.m.text) });
          if (r.relayed.length > RELAYED_MAX) r.relayed.splice(0, r.relayed.length - RELAYED_MAX);
        }
        if (last) finished(r);
        else Object.assign(r, { partSeq: seq, lastPart: i + 1, partDelayed: item.delayed });
      };
      if (item.parts[i]) {
        const allowed = mention && i === 0 ? { parse: [], users: [mention] } : { parse: [] };
        msgId = await postOnce(w, rs, { key: `line:${seq}:${i}`, seq, part: i, delayed: item.delayed, username: item.username, content: item.parts[i] }, after, allowed);
      } else after(rs, null);
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
    rs.needsYou = false;
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
      // Prompts asked of an owner paired before this start are no one's to answer now.
      if (!loaded.blocked) cancelOthers();
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
        cancelOthers();
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
        const m = {
          seq,
          sender: String(msg.sender ?? ""),
          // Who said it, as the room knows them, so a Reply can address them (#205).
          senderId: typeof msg.senderId === "string" && msg.senderId ? msg.senderId : null,
          to: String(msg.to ?? "everyone"),
          toOwner: msg.toOwner === true,
          kind: String(msg.kind ?? "tell"),
          text: String(msg.text ?? ""),
        };
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
        for (const [id, p] of Object.entries(prompts())) if (p.room === msg.room) delete prompts()[id];
        for (const [key, i] of Object.entries(posting())) if (i.meta.room === msg.room) delete posting()[key];
        try {
          save();
        } catch {}
        const reason = msg.reason === "closed" || msg.reason === "ended" ? msg.reason : "disconnected";
        return enqueue(w, { op: "close", reason, id: typeof msg.id === "string" && msg.id ? msg.id : null, inst: w.createdAt });
      }
      case "said":
        return said(msg);
      case "quiet": {
        const w = workers.get(msg.room);
        if (!w?.accepting) return fail("room_unknown", "That room is not connected.", msg.room);
        return enqueue(w, { op: "quiet" });
      }
      case "quiet_over":
        try {
          dropQuietPrompts(String(msg.room ?? ""));
        } catch (e) {
          fail("storage_blocked", e?.message, msg.room);
        }
        return;
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
    spoken.clear();
    if (sweepTimer) clock.clearTimeout(sweepTimer);
    if (settleTimer) clock.clearTimeout(settleTimer);
    settleTimer = null;
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
