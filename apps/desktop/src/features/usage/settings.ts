import type { IUsageSettings, UsageTimeFormat } from "./types";

const STORAGE_KEY = "gyredeck.usage-settings";
/**
 * The same for every provider (#192). Three minutes is the floor because it is about the
 * interval reported safe for Claude's usage endpoint; asked faster, it answers 429.
 * A saved value no longer listed (5, 15) falls back to the default.
 */
export const REFRESH_MINUTES = [3, 10, 30, 60];

export const DEFAULT_USAGE_SETTINGS: IUsageSettings = {
  refreshMs: 3 * 60_000,
  usageMode: "left",
  resetMode: "relative",
  timeFormat: "auto",
};

export const readUsageSettings = (): IUsageSettings => {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<IUsageSettings> | null;

    if (!parsed) {
      return DEFAULT_USAGE_SETTINGS;
    }

    return {
      refreshMs:
        typeof parsed.refreshMs === "number" &&
        REFRESH_MINUTES.includes(parsed.refreshMs / 60_000)
          ? parsed.refreshMs
          : DEFAULT_USAGE_SETTINGS.refreshMs,
      usageMode: parsed.usageMode === "used" ? "used" : "left",
      resetMode: parsed.resetMode === "absolute" ? "absolute" : "relative",
      timeFormat: ["auto", "12h", "24h"].includes(parsed.timeFormat ?? "")
        ? (parsed.timeFormat as UsageTimeFormat)
        : "auto",
    };
  } catch {
    return DEFAULT_USAGE_SETTINGS;
  }
};

export const writeUsageSettings = (settings: IUsageSettings): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Current state remains active when local storage is unavailable.
  }
};

const formatDuration = (milliseconds: number): string => {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);

  if (days) {
    return `${days}d ${hours}h`;
  }

  if (hours) {
    return `${hours}h ${minutes % 60}m`;
  }

  return `${minutes}m`;
};

export const formatAbsoluteTime = (
  timestamp: string,
  format: UsageTimeFormat,
): string | null => {
  const date = new Date(timestamp);

  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: format === "auto" ? undefined : format === "12h",
  }).format(date);
  // A time alone reads as today's (#227): an eight-day-old reading showed "Outdated ·
  // 15:48", and a weekly reset five days out showed "Reset at 09:00". Any other day is named.
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return time;
  }
  const day = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
  return `${day} ${time}`;
};

export const formatResetLabel = (
  resetsAt: string | undefined,
  settings: IUsageSettings,
): string | null => {
  if (!resetsAt) {
    return null;
  }

  if (settings.resetMode === "absolute") {
    const value = formatAbsoluteTime(resetsAt, settings.timeFormat);
    return value ? `Reset at ${value}` : null;
  }

  const delta = Date.parse(resetsAt) - Date.now();

  if (!Number.isFinite(delta)) {
    return null;
  }

  if (delta <= 0) {
    return "Reset soon";
  }

  return `Resets in ${formatDuration(delta)}`;
};
