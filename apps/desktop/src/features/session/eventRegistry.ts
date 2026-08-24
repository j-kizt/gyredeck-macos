import type { GyredeckEvent } from "@gyredeck/protocol";
import { MAX_RECENT_EVENTS, MAX_SESSION_EVENTS_PER_SESSION } from "./constants";
import type { SessionEventRegistry } from "./types";

export const isSessionEventRegistry = (value: unknown): value is SessionEventRegistry =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (events) =>
      Array.isArray(events) &&
      events.every(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          typeof (event as GyredeckEvent).id === "string" &&
          typeof (event as GyredeckEvent).timestamp === "string" &&
          typeof (event as GyredeckEvent).conversationId === "string",
      ),
  );

export const normalizeSessionEventIdentity = (event: GyredeckEvent): GyredeckEvent => {
  if (event.conversationId !== "default") return event;

  const conversationId = event.agentId
    ? `agent:${event.agentId}`
    : event.cwd
      ? `workspace:${event.cwd}`
      : "default";
  return { ...event, conversationId };
};

export const sortEventsNewestFirst = (events: GyredeckEvent[]): GyredeckEvent[] =>
  [...events].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

export const mergeSessionEvents = (
  current: SessionEventRegistry,
  incoming: GyredeckEvent[],
): SessionEventRegistry => {
  if (incoming.length === 0) return current;

  const incomingByConversation = new Map<string, Map<string, GyredeckEvent>>();
  for (const rawEvent of incoming) {
    const event = normalizeSessionEventIdentity(rawEvent);
    if (!event.conversationId) continue;

    const byId =
      incomingByConversation.get(event.conversationId) ?? new Map<string, GyredeckEvent>();
    byId.set(event.id, event);
    incomingByConversation.set(event.conversationId, byId);
  }

  if (incomingByConversation.size === 0) return current;

  const next = { ...current };
  for (const [conversationId, incomingById] of incomingByConversation) {
    const byId = new Map((current[conversationId] ?? []).map((event) => [event.id, event]));
    for (const [eventId, event] of incomingById) byId.set(eventId, event);
    next[conversationId] = sortEventsNewestFirst([...byId.values()]).slice(
      0,
      MAX_SESSION_EVENTS_PER_SESSION,
    );
  }
  return next;
};

export const normalizeSessionEventRegistry = (
  registry: SessionEventRegistry,
): SessionEventRegistry => mergeSessionEvents({}, Object.values(registry).flat());

export const appendRecentEvent = (
  events: GyredeckEvent[],
  event: GyredeckEvent,
): GyredeckEvent[] => [event, ...events].slice(0, MAX_RECENT_EVENTS);

export const getUniqueSortedEvents = (events: GyredeckEvent[]): GyredeckEvent[] => {
  const byId = new Map<string, GyredeckEvent>();
  for (const event of events) byId.set(event.id, event);
  return sortEventsNewestFirst([...byId.values()]);
};
