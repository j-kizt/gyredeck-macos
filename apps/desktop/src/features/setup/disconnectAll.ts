export interface IDisconnectAllResult {
  done: string[];
  failed: Array<{ code: string; reason: string }>;
}

/**
 * Disconnect every room in `rooms` from Discord, one at a time (#205). The set is the one
 * connected when the button was pressed: a room that connects meanwhile is not touched. A room
 * that fails is named with why, never counted as done, so the caller can say which are still
 * connected and try only those again.
 */
export const disconnectAll = async (
  rooms: readonly string[],
  one: (code: string) => Promise<unknown>,
): Promise<IDisconnectAllResult> => {
  const result: IDisconnectAllResult = { done: [], failed: [] };
  for (const code of [...rooms]) {
    try {
      await one(code);
      result.done.push(code);
    } catch (e) {
      result.failed.push({ code, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
};

/**
 * Where each failed room stands now. One still connected is offered "Try again" here; one the
 * Discord member could not leave has moved to `leaving`, whose own row offers "Try leaving
 * again" — so no failed room is ever off the screen, even with no room connected.
 */
export const stillHeld = (
  failed: IDisconnectAllResult["failed"],
  status: { connectedRooms: string[]; leaving?: Record<string, string> },
) => ({
  connected: failed.filter((f) => status.connectedRooms.includes(f.code)),
  leaving: failed.filter((f) => f.code in (status.leaving ?? {})).map((f) => f.code),
});

/**
 * Whether Settings offers Disconnect all: whenever a room is connected or a failed one is still
 * held — not only while the connector is ready, since disconnecting needs no Discord.
 */
export const offerDisconnectAll = (connectedRooms: string[], held: { connected: unknown[]; leaving: unknown[] }) =>
  connectedRooms.length > 0 || held.connected.length > 0 || held.leaving.length > 0;
