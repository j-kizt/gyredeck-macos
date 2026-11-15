/** An app event as Rust hands it over: numbered in the order it reached the app. */
export interface INumberedAppEvent {
  n: number;
  event: unknown;
}

/**
 * The order the webview hands on the app's own events in (#391 audit).
 *
 * What Rust kept is read back once the live listener is up, so live events land while that
 * read is in flight, and the two overlap by any amount: more than Rust keeps can arrive in
 * the wait. They are held until the kept ones are in, then both go out in Rust's order, and
 * nothing older than what was last handed on is handed on after it. A message for a
 * session's old room delivered after one for its new room would put its inbox back.
 */
export const createAppEventFeed = (deliver: (event: unknown) => void) => {
  let last = 0;
  let waiting: INumberedAppEvent[] | null = [];
  const inOrder = (item: INumberedAppEvent) => {
    if (typeof item?.n !== "number" || item.n <= last) return;
    last = item.n;
    deliver(item.event);
  };
  return {
    live(item: INumberedAppEvent) {
      if (waiting) waiting.push(item);
      else inOrder(item);
    },
    /** What Rust kept, read once after the listener is up; on a failed read, called with []. */
    kept(items: INumberedAppEvent[]) {
      if (!waiting) return;
      const all = [...items, ...waiting].sort((a, b) => a.n - b.n);
      waiting = null;
      all.forEach(inOrder);
    },
  };
};
