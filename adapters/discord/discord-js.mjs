import { EventEmitter } from "node:events";
import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  HTTPError,
  MessageFlags,
  Partials,
  RateLimitError,
  Routes,
} from "discord.js";

const DISCORD_EPOCH = 1420070400000n;
const NETWORK = /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket|other side closed|aborted/i;

function kindError(kind, message, extra = {}) {
  return Object.assign(new Error(message), { kind, ...extra });
}

export function classify(e) {
  if (e?.kind) return e;
  if (e instanceof RateLimitError) return kindError("rate", "rate limited", { retryAfter: e.retryAfter });
  if (e instanceof DiscordAPIError) {
    if (e.status === 401) return kindError("bad_token", "unauthorized");
    if (e.status === 404 || e.code === 10003 || e.code === 10015) return kindError("missing", e.message);
    if (e.status === 403 || e.code === 50013 || e.code === 50001) return kindError("permission", e.message);
    if (e.status === 429) return kindError("rate", "rate limited", { retryAfter: 1000 });
    if (e.status >= 500) return kindError("network", e.message);
    // The request itself was refused (50035 invalid form body, 40005 too large, …): sending
    // the same content again will not change the answer.
    if (e.status >= 400 && e.status < 500) return kindError("rejected", e.message, { code: e.code });
    return kindError("other", e.message);
  }
  if (e instanceof HTTPError) return kindError("network", e.message);
  if (e?.code === "TokenInvalid") return kindError("bad_token", "invalid token");
  if (e?.code === "DisallowedIntents" || /disallowed intent/i.test(e?.message ?? "")) {
    return kindError("missing_intent", "disallowed intents");
  }
  if (e?.name === "AbortError" || NETWORK.test(`${e?.message ?? ""} ${e?.code ?? ""} ${e?.cause?.code ?? ""}`)) {
    return kindError("network", e?.message ?? "network");
  }
  return kindError("other", e?.message ?? String(e));
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    throw classify(e);
  }
}

/** Archived pages looked through for a room's post; posts go after 30 days, so this is far. */
export const FIND_PAGES_MAX = 50;

export function createDiscordJs({ makeClient = (options) => new Client(options) } = {}) {
  const events = new EventEmitter();
  const webhooks = new Map();
  let client = null;
  let commands = null;

  async function registerIn(guild) {
    if (commands) await guild.commands.set(commands);
  }

  async function textChannel(id) {
    const ch = await client.channels.fetch(id);
    if (!ch) throw kindError("missing", "channel gone");
    return ch;
  }

  async function forum(id) {
    const ch = await client.channels.fetch(id).catch((e) => {
      const k = classify(e);
      if (k.kind === "missing") return null;
      throw k;
    });
    if (!ch || ch.type !== ChannelType.GuildForum) throw kindError("missing", "not a forum channel");
    return ch;
  }

  async function webhook(forumId) {
    if (!webhooks.has(forumId)) {
      const ch = await forum(forumId);
      const hooks = await ch.fetchWebhooks();
      let hook = hooks.find((h) => h.owner?.id === client.user.id && h.token);
      if (!hook) hook = await ch.createWebhook({ name: "Gyredeck" });
      webhooks.set(forumId, hook);
    }
    return webhooks.get(forumId);
  }

  function forumsChanged(ch) {
    if (!ch || ch.type === undefined || ch.type === ChannelType.GuildForum) events.emit("forums");
  }

  return {
    on: (name, fn) => events.on(name, fn),

    login(token) {
      const c0 = makeClient({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.GuildMessageReactions,
          GatewayIntentBits.DirectMessageReactions,
        ],
        // Reactions on messages sent before this start arrive only as partials (#205).
        partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
        allowedMentions: { parse: [] },
        rest: { rejectOnRateLimit: () => true },
      });
      client = c0;
      client.on(Events.ShardReady, () => events.emit("online"));
      client.on(Events.ShardResume, () => events.emit("online"));
      client.on(Events.ShardReconnecting, () => events.emit("offline"));
      client.on(Events.ShardDisconnect, () => events.emit("offline"));
      client.on(Events.GuildCreate, (guild) => {
        events.emit("forums");
        registerIn(guild).catch(() => {});
      });
      client.on(Events.GuildDelete, () => events.emit("forums"));
      client.on(Events.ChannelCreate, forumsChanged);
      client.on(Events.ChannelDelete, forumsChanged);
      client.on(Events.ChannelUpdate, (_old, ch) => forumsChanged(ch));
      client.on(Events.Error, () => {});
      client.on(Events.MessageCreate, (msg) => {
        if (msg.author?.bot || msg.webhookId) return;
        // A person writing in a guild channel: the connector keeps only the owner, in a post
        // it follows (#205).
        if (msg.guildId) {
          events.emit("post", {
            messageId: msg.id,
            channelId: msg.channelId,
            authorId: msg.author?.id,
            text: msg.content ?? "",
            replyToId: msg.reference?.messageId ?? null,
          });
          return;
        }
        events.emit("dm", {
          userId: msg.author.id,
          username: msg.author.username,
          text: msg.content,
          reply: (text) => msg.reply({ content: text, allowedMentions: { parse: [] } }),
        });
      });
      // Only a real edit: link previews resolving also fire MessageUpdate, with no editedTimestamp.
      client.on(Events.MessageUpdate, (_old, next) => {
        if (!next?.guildId || next.author?.bot || next.webhookId || !next.editedTimestamp) return;
        events.emit("edit", { messageId: next.id, channelId: next.channelId, authorId: next.author?.id });
      });
      client.on(Events.MessageReactionAdd, (reaction, user) => {
        if (user?.bot) return;
        events.emit("reaction", {
          messageId: reaction.message?.id,
          channelId: reaction.message?.channelId,
          userId: user?.id,
          emoji: reaction.emoji?.name ?? null,
        });
      });
      client.on(Events.InteractionCreate, (i) => {
        if (!i.isChatInputCommand?.()) return;
        events.emit("command", {
          name: i.commandName,
          userId: i.user?.id,
          channelId: i.channelId,
          reply: ({ content, ephemeral }) =>
            guarded(async () => {
              const allowedMentions = { parse: [] };
              if (ephemeral) {
                await i.reply({ content, allowedMentions, flags: MessageFlags.Ephemeral });
                return null;
              }
              const r = await i.reply({ content, allowedMentions, withResponse: true });
              const m = r?.resource?.message;
              return m ? { id: m.id } : null;
            }),
        });
      });
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (err, value) => {
          if (settled) return;
          settled = true;
          c0.off(Events.ShardDisconnect, onClose);
          if (err) {
            c0.destroy().catch(() => {});
            reject(err);
          } else resolve(value);
        };
        const onClose = (ev) => {
          if (ev?.code === 4004) settle(kindError("bad_token", "invalid token"));
          else if (ev?.code === 4014) settle(kindError("missing_intent", "disallowed intents"));
        };
        c0.on(Events.ShardDisconnect, onClose);
        c0.once(Events.ClientReady, (c) =>
          settle(null, { bot: { id: c.user.id, username: c.user.username }, applicationId: c.application?.id ?? c.user.id }),
        );
        c0.login(token).catch((e) => settle(classify(e)));
      });
    },

    listForums() {
      const list = [];
      if (!client?.guilds) return list;
      for (const g of client.guilds.cache.values()) {
        for (const ch of g.channels.cache.values()) {
          if (ch.type === ChannelType.GuildForum) list.push({ id: ch.id, name: ch.name, guildId: g.id, guildName: g.name });
        }
      }
      return list;
    },

    ensureTags: (forumId, names) =>
      guarded(async () => {
        let ch = await forum(forumId);
        const missing = names.filter((n) => !ch.availableTags.some((t) => t.name === n));
        if (missing.length) ch = await ch.setAvailableTags([...ch.availableTags, ...missing.map((name) => ({ name }))]);
        return Object.fromEntries(names.map((n) => [n, ch.availableTags.find((t) => t.name === n)?.id]));
      }),

    createPost: (forumId, { name, content, appliedTags }) =>
      guarded(async () => {
        const ch = await forum(forumId);
        const thread = await ch.threads.create({ name, appliedTags, message: { content, allowedMentions: { parse: [] } } });
        return thread.id;
      }),

    // The forum's posts this bot started, named `name`, whose first message ends with `marker`
    // — active, and archived paged back by time until there are no more. Only a post with
    // the room's name has its first message fetched. `complete` is false when the safety cap
    // stopped the search with more archived posts left unseen.
    findPosts: (forumId, { name, marker }) =>
      guarded(async () => {
        const ch = await forum(forumId);
        const named = new Map();
        const keep = (threads) => {
          for (const t of threads) if (t.name === name) named.set(t.id, t);
        };
        keep((await ch.threads.fetchActive()).threads.values());
        let before;
        let complete = true;
        const seen = new Set();
        for (let page = 0; ; page++) {
          if (page >= FIND_PAGES_MAX) {
            complete = false;
            break;
          }
          const archived = await ch.threads.fetchArchived({ type: "public", limit: 100, ...(before !== undefined ? { before } : {}) });
          const list = [...archived.threads.values()];
          const fresh = list.filter((t) => !seen.has(t.id));
          for (const t of list) seen.add(t.id);
          keep(fresh);
          if (!archived.hasMore || list.length === 0) break;
          const oldest = Math.min(...list.map((t) => t.archiveTimestamp ?? Number.POSITIVE_INFINITY));
          // `before` is exclusive, at millisecond grain: a post archived in the same
          // millisecond as the last one seen would be skipped. So the bound is inclusive
          // (oldest + 1) and what comes back twice is dropped by id. A page of nothing new
          // means more posts share one millisecond than a page holds: said, not guessed.
          if (!Number.isFinite(oldest) || fresh.length === 0) {
            complete = false;
            break;
          }
          before = oldest + 1;
        }
        const found = [];
        for (const t of named.values()) {
          if (t.parentId !== ch.id || t.ownerId !== client.user?.id) continue;
          const starter = await t.fetchStarterMessage().catch(() => null);
          if (starter?.content?.split("\n").at(-1) === marker) {
            found.push({ id: t.id, createdAt: t.createdTimestamp ?? 0, archived: Boolean(t.archived) });
          }
        }
        return { found, complete };
      }),

    fetchThread: (id) =>
      guarded(async () => {
        try {
          const t = await client.channels.fetch(id);
          return t ? { id: t.id, archived: Boolean(t.archived) } : null;
        } catch (e) {
          if (classify(e).kind === "missing") return null;
          throw e;
        }
      }),

    // An archived thread accepts only an unarchive, so unarchive before retagging and
    // retag before archiving.
    editThread: (id, { archived, appliedTags }) =>
      guarded(async () => {
        const t = await client.channels.fetch(id);
        if (!t) throw kindError("missing", "thread gone");
        if (!archived && t.archived) await t.setArchived(false);
        if (appliedTags) await t.setAppliedTags(appliedTags);
        if (archived && !t.archived) await t.setArchived(true);
      }),

    deleteThread: (id) => guarded(() => client.rest.delete(Routes.channel(id))),

    registerCommands: (defs) =>
      guarded(async () => {
        commands = defs;
        for (const g of client.guilds.cache.values()) await registerIn(g);
      }),

    // The bot's own word in a post (#205): a reply to a say, a prompt. Never a webhook, so the
    // owner can tell it from the room's lines.
    botSend: ({ threadId, content, replyTo, allowedMentions }) =>
      guarded(async () => {
        const ch = await textChannel(threadId);
        const m = await ch.send({
          content,
          allowedMentions,
          ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}),
        });
        return { id: m.id };
      }),

    // Rewrite the bot's own message, e.g. a prompt that no longer works (#205).
    botEdit: ({ channelId, messageId, content }) =>
      guarded(async () => {
        const ch = await client.channels.fetch(channelId);
        if (!ch?.messages) throw kindError("missing", "channel gone");
        await ch.messages.edit(messageId, { content, allowedMentions: { parse: [] } });
      }),

    react: ({ threadId, messageId, emoji }) =>
      guarded(async () => {
        const ch = await textChannel(threadId);
        await ch.messages.react(messageId, emoji);
      }),

    // Whether this user's reaction is on the message now: a ✅ given while the prompt could not
    // yet be found is still counted once it is (#205 r4).
    reactedBy: ({ channelId, messageId, emoji, userId }) =>
      guarded(async () => {
        const ch = await client.channels.fetch(channelId);
        if (!ch?.messages) throw kindError("missing", "channel gone");
        const reaction = (await ch.messages.fetch({ message: messageId, cache: false })).reactions.cache.get(emoji);
        if (!reaction) return false;
        // A page holds at most 100 users: walk them all.
        let after;
        for (;;) {
          const page = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
          if (page.has(userId)) return true;
          if (page.size < 100) return false;
          after = page.lastKey();
        }
      }),

    sendWebhook: ({ forumId, threadId, username, content, allowedMentions }) =>
      guarded(async () => {
        const body = { content, username, threadId, allowedMentions };
        let sent;
        try {
          sent = await (await webhook(forumId)).send(body);
        } catch (e) {
          if (!(e instanceof DiscordAPIError && e.code === 10015)) throw e;
          webhooks.delete(forumId);
          sent = await (await webhook(forumId)).send(body);
        }
        return { id: sent?.id ?? null };
      }),

    // Oldest first, whatever order Discord hands a page in: the read-back walks forward.
    fetchMessages: (threadId, { after, limit = 100 }) =>
      guarded(async () => {
        const t = await client.channels.fetch(threadId);
        if (!t) throw kindError("missing", "thread gone");
        const page = await t.messages.fetch({ after, limit, cache: false });
        return [...page.values()]
          .map((m) => ({ id: m.id, webhookId: m.webhookId ?? null, username: m.author?.username ?? null, content: m.content ?? "" }))
          .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
      }),

    // The bot's own message with exactly this content, posted at or after `sinceMs`: its id,
    // or null when it is not there (#205). Snowflakes carry their time, so older look-alikes
    // are never searched.
    findOwn: (channelId, { content, sinceMs, pages = 5 }) =>
      guarded(async () => {
        const ch = await client.channels.fetch(channelId);
        if (!ch?.messages) throw kindError("missing", "channel gone");
        const since = BigInt(Math.max(0, Math.floor(sinceMs))) - DISCORD_EPOCH;
        let after = String((since > 0n ? since : 0n) << 22n);
        for (let page = 0; page < pages; page++) {
          const list = [...(await ch.messages.fetch({ after, limit: 100, cache: false })).values()];
          const hit = list.find((m) => m.author?.id === client.user?.id && m.content === content);
          if (hit) return hit.id;
          if (list.length < 100) return null;
          after = list.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), after);
        }
        throw kindError("network", "too many messages to search");
      }),

    async destroy() {
      if (client) await client.destroy().catch(() => {});
      client = null;
    },
  };
}
