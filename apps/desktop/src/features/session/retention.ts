import type { SessionEventRegistry } from "./types";

/**
 * How long stored session data is kept, and how many conversations (#280). Older data is
 * cleared at start, on every change and every hour, so a quiet app sheds it too.
 */
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STORED_CONVERSATIONS = 200;
export const SESSION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const newestAt = (events: SessionEventRegistry[string]) =>
  events.reduce((latest, event) => Math.max(latest, Date.parse(event.timestamp) || 0), 0);

/**
 * Keep conversations with an event inside the retention window, at most the newest 200.
 * Returns the same object when nothing goes, so an unchanged registry is not saved again.
 */
export const pruneSessionEventRegistry = (registry: SessionEventRegistry, now: Date): SessionEventRegistry => {
  const cutoff = now.getTime() - SESSION_RETENTION_MS;
  const kept = Object.entries(registry)
    .map(([conversationId, events]) => [conversationId, events, newestAt(events)] as const)
    .filter(([, , latest]) => latest >= cutoff)
    .sort((a, b) => b[2] - a[2])
    .slice(0, MAX_STORED_CONVERSATIONS);
  if (kept.length === Object.keys(registry).length) return registry;
  return Object.fromEntries(kept.map(([conversationId, events]) => [conversationId, events]));
};

/**
 * Clear a tombstone older than the retention window (#280), unless its conversation is still
 * known. A tombstone hides a conversation only while it is newer than every event of it, so
 * one past the window hides only a conversation whose events are all past it — and those
 * are pruned from the registry too. A conversation still known keeps its tombstone.
 */
export const pruneTombstones = (
  registry: Record<string, number>,
  now: Date,
  known: ReadonlySet<string>,
): Record<string, number> => {
  const cutoff = now.getTime() - SESSION_RETENTION_MS;
  const kept = Object.entries(registry).filter(([conversationId, at]) => at >= cutoff || known.has(conversationId));
  return kept.length === Object.keys(registry).length ? registry : Object.fromEntries(kept);
};
