import type { SessionEventRegistry } from "./types";

/**
 * How long stored session data is kept, and how many conversations (#280). Older data is
 * cleared at start, on every change and every hour, so a quiet app sheds it too.
 */
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STORED_CONVERSATIONS = 200;
export const SESSION_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// A timestamp more than a day ahead is not believed: it would keep its conversation forever.
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * Keep events inside the retention window and conversations that still have one, at most
 * the newest 200. The conversation the person has open is kept whole, whatever its age or
 * rank. Returns the same object when nothing goes, so an unchanged registry is not saved.
 */
export const pruneSessionEventRegistry = (
  registry: SessionEventRegistry,
  now: Date,
  keep: string | null = null,
): SessionEventRegistry => {
  const cutoff = now.getTime() - SESSION_RETENTION_MS;
  const ceiling = now.getTime() + FUTURE_SLACK_MS;
  let changed = false;
  const dated = Object.entries(registry).flatMap(([conversationId, events]) => {
    if (conversationId === keep) return [[conversationId, events, Number.POSITIVE_INFINITY] as const];
    const inside = events.filter((event) => {
      const at = Date.parse(event.timestamp);
      return at >= cutoff && at <= ceiling;
    });
    if (inside.length !== events.length) changed = true;
    if (inside.length === 0) return [];
    return [[conversationId, inside, Math.max(...inside.map((event) => Date.parse(event.timestamp)))] as const];
  });
  dated.sort((a, b) => b[2] - a[2]);
  const open = dated.find(([conversationId]) => conversationId === keep);
  const others = dated.filter(([conversationId]) => conversationId !== keep);
  const kept = open ? [open, ...others.slice(0, MAX_STORED_CONVERSATIONS - 1)] : others.slice(0, MAX_STORED_CONVERSATIONS);
  if (!changed && kept.length === Object.keys(registry).length) return registry;
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
