// A Discord that lives in memory: the connector's interface, no network, no real token.
import { EventEmitter } from "node:events";

export const FORUM = { id: "F1", name: "rooms", guildId: "G1", guildName: "Home" };

export function kindError(kind, extra = {}) {
  return Object.assign(new Error(kind), { kind, ...extra });
}

export function flush(times = 20) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

export function fakeClock(start = Date.UTC(2026, 9, 27, 9, 0, 0)) {
  let now = start;
  let id = 0;
  const timers = new Set();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const h = { at: now + ms, fn, id: ++id };
      timers.add(h);
      return h;
    },
    clearTimeout(h) {
      timers.delete(h);
    },
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const next = [...timers].filter((h) => h.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.fn();
      }
      now = end;
      await flush();
    },
  };
}

// Ids share one counter, so a later message always has a larger number; an id the fake did
// not mint ("TA") reads as the start of the thread.
function idNumber(id) {
  const k = Number(String(id ?? "").slice(1));
  return Number.isFinite(k) ? k : -Infinity;
}

export function createFakeDiscord({ forums = [FORUM], identity } = {}) {
  const events = new EventEmitter();
  let n = 100;
  const fake = {
    log: [],
    sent: [],
    threads: new Map(),
    tags: { open: "tag-open", closed: "tag-closed" },
    loginError: null,
    gate: null,
    destroyed: false,
    identity: identity ?? { bot: { id: "B1", username: "gyre-bot" }, applicationId: "A1" },
    on: (name, fn) => events.on(name, fn),
    emit: (name, ...args) => events.emit(name, ...args),
    async login(token) {
      fake.log.push({ op: "login" });
      await fake.gate?.("login", { token });
      if (fake.loginError) throw fake.loginError;
      return fake.identity;
    },
    listForums: () => forums,
    async ensureTags(forumId, names) {
      fake.log.push({ op: "ensureTags", forumId, names });
      await fake.gate?.("ensureTags", { forumId });
      return fake.tags;
    },
    async createPost(forumId, post) {
      await fake.gate?.("createPost", { forumId, ...post });
      const id = `T${++n}`;
      fake.threads.set(id, { forumId, archived: false, ...post });
      fake.log.push({ op: "createPost", id, forumId, ...post });
      return id;
    },
    findIncomplete: false,
    async findPosts(forumId, { name, marker }) {
      fake.log.push({ op: "findPosts", forumId, name, marker });
      await fake.gate?.("findPosts", { forumId, name, marker });
      const found = [...fake.threads.entries()]
        .filter(([, t]) => t.forumId === forumId && (t.name === undefined || t.name === name) && typeof t.content === "string" && t.content.split("\n").at(-1) === marker)
        .map(([id, t]) => ({ id, createdAt: t.createdAt ?? Number(id.slice(1)), archived: t.archived }));
      return { found, complete: !fake.findIncomplete };
    },
    async fetchThread(id) {
      await fake.gate?.("fetchThread", { id });
      const t = fake.threads.get(id);
      return t ? { id, archived: t.archived } : null;
    },
    async editThread(id, patch) {
      await fake.gate?.("editThread", { id, ...patch });
      const t = fake.threads.get(id);
      if (!t) throw kindError("missing");
      Object.assign(t, patch);
      fake.log.push({ op: "editThread", id, ...patch });
    },
    async deleteThread(id) {
      await fake.gate?.("deleteThread", { id });
      if (!fake.threads.has(id)) throw kindError("missing");
      fake.threads.delete(id);
      fake.log.push({ op: "deleteThread", id });
    },
    // `after` runs once Discord has taken the message: a throw there is a reply lost on the way back.
    async sendWebhook(args) {
      fake.log.push({ op: "attempt", content: args.content });
      await fake.gate?.("send", args);
      const t = fake.threads.get(args.threadId);
      if (!t) throw kindError("missing");
      const id = `M${++n}`;
      (t.messages ??= []).push({ id, webhookId: "W1", username: args.username, content: args.content });
      fake.sent.push(args);
      fake.log.push({ op: "send", threadId: args.threadId, content: args.content, id });
      await fake.after?.("send", { ...args, id });
      return { id };
    },
    async fetchMessages(threadId, { after, limit = 100 }) {
      fake.log.push({ op: "fetchMessages", threadId, after });
      await fake.gate?.("fetchMessages", { threadId, after });
      const t = fake.threads.get(threadId);
      if (!t) throw kindError("missing");
      const from = idNumber(after);
      return (t.messages ?? []).filter((m) => idNumber(m.id) > from).slice(0, limit).map((m) => ({ ...m }));
    },
    async destroy() {
      fake.destroyed = true;
    },
  };
  return fake;
}
