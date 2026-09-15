import type { IAgentUsageState, IUsageMetric } from "../usage/types";

/**
 * The levels worth interrupting for, low first so the worst one wins a tie.
 *
 * Zero earns its own band rather than sharing the 10% one: running out is not a sharper
 * warning, it is a different fact — nothing more can be done until the quota resets.
 * Repeating it is not a risk, because crossing is what fires and there is nothing below
 * zero to cross into.
 */
export const QUOTA_THRESHOLDS = [0, 10, 20] as const;

export type QuotaBand = (typeof QUOTA_THRESHOLDS)[number] | null;

export interface IQuotaAlert {
  providerId: string;
  providerLabel: string;
  metricLabel: string;
  threshold: number;
  leftPercent: number;
  resetLabel: string | null;
}

/** Which band a reading sits in, or null when there is still room. */
export const bandOf = (leftPercent: number | null): QuotaBand => {
  if (leftPercent === null) return null;
  for (const threshold of QUOTA_THRESHOLDS) {
    if (leftPercent <= threshold) return threshold;
  }
  return null;
};

/**
 * Where each of a provider's metrics stood last time, so the next look can be compared
 * to it rather than reported on its own.
 *
 * Keyed by the metric's label because that is what identifies it across polls — the
 * array order is the provider's to change.
 */
export type QuotaMark = Record<string, QuotaBand>;

export const markOf = (usage: IAgentUsageState | undefined): QuotaMark => {
  const mark: QuotaMark = {};
  for (const metric of usage?.metrics ?? []) {
    mark[metric.label] = bandOf(metric.leftPercent);
  }
  return mark;
};

/**
 * Only a reading that can be trusted to be current.
 *
 * Three separate paths set `stale`: hydrating from the cache at boot, a failed refresh
 * that keeps the last good numbers, and a live response that carries a Status line
 * alongside cached figures. In all three the number on screen is real but old, and old
 * is not evidence that quota has just fallen.
 */
export const isFresh = (usage: IAgentUsageState | undefined): boolean =>
  Boolean(usage) && usage!.status === "online" && !usage!.stale;

/**
 * What crossed a threshold between two looks at one provider.
 *
 * Compared rather than reported: usage is polled every fifteen minutes and returns the
 * current figure every time, so "currently at 12%" would interrupt four times an hour
 * for one quota that is simply low. Only the moment it *became* low is news.
 *
 * Nothing is reported against a first look. Opening the app to find quota already spent
 * is a state, not an event, and announcing it would teach a person to dismiss these
 * without reading them.
 *
 * Crossing two thresholds in one step reports the lower one alone: the answer to "how
 * bad is it" is 10%, and a second banner saying 20% only argues with it.
 */
export const quotaAlertsBetween = (
  before: QuotaMark | undefined,
  usage: IAgentUsageState,
  providerLabel: string,
): IQuotaAlert[] => {
  if (!before || !isFresh(usage)) return [];
  const alerts: IQuotaAlert[] = [];

  for (const metric of usage.metrics) {
    const band = bandOf(metric.leftPercent);
    if (band === null || metric.leftPercent === null) continue;
    const was = before[metric.label];
    // Unknown last time means nothing to have crossed — a metric the provider has only
    // just started reporting is a first look of its own.
    if (!(metric.label in before)) continue;
    // Deeper than before, or newly below any threshold at all.
    if (was !== undefined && was !== null && band >= was) continue;
    alerts.push({
      providerId: usage.providerId,
      providerLabel,
      metricLabel: metricName(metric),
      threshold: band,
      leftPercent: metric.leftPercent,
      resetLabel: metric.resetLabel,
    });
  }

  return alerts;
};

/** What to call the metric in one line of a banner. */
const metricName = (metric: IUsageMetric): string =>
  metric.groupLabel ? `${metric.groupLabel} · ${metric.label}` : metric.label;
