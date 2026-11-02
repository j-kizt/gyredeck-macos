/**
 * When the session registry is saved (#280). Kept apart from React so the order of saves,
 * failures and retries can be tested with a fake clock.
 *
 * - Nothing is saved until the stored registry has been read (`ready`).
 * - At most one save every `delayMs` while changes arrive; `flush` saves what is pending now.
 * - A registry that is what was last stored is not saved again.
 * - A failed save is retried with the latest registry, never the one that failed: a newer
 *   save may already have landed, and the old one would replace it.
 */
export const createRegistryWriter = <T>({
  write,
  delayMs,
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = (timer) => clearTimeout(timer as number),
}: {
  write: (registry: T) => Promise<boolean>;
  delayMs: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}) => {
  let ready = false;
  let latest: T | null = null;
  let pending: T | null = null;
  let persisted: T | null = null;
  let timer: unknown = null;

  const schedule = (registry: T) => {
    pending = registry;
    if (timer !== null) return;
    timer = setTimer(flush, delayMs);
  };

  const flush = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const registry = pending;
    if (registry === null) return;
    pending = null;
    void write(registry).then((saved) => {
      if (saved) {
        persisted = registry;
        return;
      }
      if (pending === null && latest !== null && latest !== persisted) schedule(latest);
    });
  };

  return {
    /** The registry changed. */
    update(registry: T) {
      latest = registry;
      if (ready && registry !== persisted) schedule(registry);
    },
    /** The stored registry has been read; `stored` is what it holds, or null if still owed. */
    ready(stored: T | null) {
      ready = true;
      persisted = stored;
    },
    /** Mark a registry as stored by another path (a demo scenario writes its own at once). */
    stored(registry: T) {
      persisted = registry;
    },
    flush,
  };
};
