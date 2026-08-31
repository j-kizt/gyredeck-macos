import type { GyredeckEvent } from "@gyredeck/protocol";

/**
 * Context windows for the models Claude Code runs, taken from each model's page in
 * Anthropic's docs. Keys are matched as prefixes so dated snapshots and aliases
 * (claude-sonnet-4-5-20250929 → claude-sonnet-4-5) resolve to their family; no key here
 * is a prefix of another, so match order does not matter.
 *
 * Only Claude Code's adapter reports token usage — Antigravity's hook payload carries no
 * token fields at all and Codex sends a single notify — so in practice this map is the
 * whole feature's reach. A model absent from it renders the token count without a bar
 * rather than against a guessed ceiling: assuming 200k for a 1M-window model reported a
 * 302k conversation as 151% full. Claude Opus 4.5 and earlier are deliberately absent
 * rather than estimated.
 */
const CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ["claude-fable-5", 1_000_000],
  ["claude-opus-5", 1_000_000],
  ["claude-opus-4-8", 1_000_000],
  ["claude-opus-4-7", 1_000_000],
  ["claude-opus-4-6", 1_000_000],
  ["claude-sonnet-5", 1_000_000],
  ["claude-sonnet-4-6", 1_000_000],
  ["claude-sonnet-4-5", 200_000],
  ["claude-haiku-4-5", 200_000],
];

export const resolveContextWindow = (model: string | null | undefined): number | null => {
  if (typeof model !== "string" || model.length === 0) return null;
  for (const [prefix, window] of CONTEXT_WINDOWS) {
    if (model.startsWith(prefix)) return window;
  }
  return null;
};

interface IPromptTokens {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface IContextUsageSnapshot {
  usage: IPromptTokens | null;
  usageAt: string | null;
  /**
   * Last model seen on this conversation. Tracked separately because turn_complete is
   * synthesized from the raw /hook/stop relay and arrives with model unset whenever the
   * bridge cannot resolve the conversation's scope — leaving the window unresolvable
   * even though an earlier event named the model.
   */
  model: string | null;
  modelAt: string | null;
}

/** Keyed by conversationId. */
export type ContextUsageRegistry = Record<string, IContextUsageSnapshot>;

const EMPTY: IContextUsageSnapshot = { usage: null, usageAt: null, model: null, modelAt: null };

const positive = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const newer = (candidate: string, existing: string | null): boolean =>
  existing === null || candidate >= existing;

/**
 * Fold token usage and model identity out of a batch of events into a per-conversation
 * store.
 *
 * This is kept separate from the session event registry on purpose. That registry caps
 * each session at MAX_SESSION_EVENTS_PER_SESSION events, and one busy turn fires far more
 * tool events than the cap — which pushed the turn_complete carrying the usage out of the
 * window and made the meter flicker in and out as work went on. Context size is a running
 * property of the conversation, not a recent event, so it is stored as one.
 *
 * Events may arrive in any order, so each field keeps the newest timestamp it has seen.
 * Returns the same reference when nothing changed, to avoid pointless re-renders.
 */
export const collectContextUsage = (
  current: ContextUsageRegistry,
  events: readonly GyredeckEvent[],
): ContextUsageRegistry => {
  let next: ContextUsageRegistry | null = null;

  const patch = (key: string, apply: (entry: IContextUsageSnapshot) => IContextUsageSnapshot | null) => {
    const entry = (next ?? current)[key] ?? EMPTY;
    const updated = apply(entry);
    if (!updated) return;
    next = { ...(next ?? current), [key]: updated };
  };

  for (const event of events) {
    const key = event.conversationId;
    if (typeof key !== "string" || key.length === 0) continue;

    const model = event.model;
    if (typeof model === "string" && model.length > 0) {
      patch(key, (entry) => {
        if (!newer(event.timestamp, entry.modelAt)) return null;
        if (entry.model === model) return null;
        return { ...entry, model, modelAt: event.timestamp };
      });
    }

    if (event.type !== "turn_complete" || !event.data.usage) continue;
    const usage: IPromptTokens = {
      inputTokens: positive(event.data.usage.inputTokens),
      cacheReadTokens: positive(event.data.usage.cacheReadTokens),
      cacheCreationTokens: positive(event.data.usage.cacheCreationTokens),
    };
    if (usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens === 0) continue;
    patch(key, (entry) =>
      newer(event.timestamp, entry.usageAt)
        ? { ...entry, usage, usageAt: event.timestamp }
        : null);
  }

  return next ?? current;
};

export interface IContextMeter {
  /** Prompt-side tokens: everything the model had to read on the last completed turn. */
  used: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** null when the model's window is unknown — render the count without a bar. */
  window: number | null;
  /** 0-1, clamped. null whenever window is null. */
  ratio: number | null;
}

/**
 * Context size as of the last completed turn. Usage only reaches Gyredeck on
 * turn_complete (the adapter reads it from the transcript when Claude Code's Stop hook
 * fires), so this is a per-turn snapshot: it holds steady while an agent works and steps
 * once the turn ends.
 */
export const buildContextMeter = (
  snapshot: IContextUsageSnapshot | null | undefined,
  fallbackModel: string | null | undefined,
): IContextMeter | null => {
  if (!snapshot?.usage) return null;
  const { inputTokens, cacheReadTokens, cacheCreationTokens } = snapshot.usage;
  const used = inputTokens + cacheReadTokens + cacheCreationTokens;
  if (used === 0) return null;
  const window = resolveContextWindow(snapshot.model ?? fallbackModel);
  return {
    used,
    inputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    window,
    ratio: window ? Math.min(used / window, 1) : null,
  };
};
