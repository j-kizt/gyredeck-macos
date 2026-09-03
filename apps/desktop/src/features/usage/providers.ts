import type { IUsageMetricGroup, IUsageProviderConfig } from "./types";

/**
 * Declaration order is the tab order, once anything unusable has sunk to the bottom
 * (see the sort in components.tsx) — so this list is the running order for the common
 * case where every provider is reporting.
 */
export const USAGE_PROVIDERS: IUsageProviderConfig[] = [
  {
    id: "agy",
    label: "Antigravity",
    command: "agy_usage",
    iconPath: "/provider-icons/antigravity.svg",
    color: "#4285f4",
  },
  {
    id: "claude",
    label: "Claude Code",
    command: "claude_usage",
    iconPath: "/provider-icons/claude.svg",
    color: "#d97757",
    links: [
      { label: "Status", url: "https://status.anthropic.com/" },
      { label: "Console", url: "https://console.anthropic.com/" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex_usage",
    iconPath: "/provider-icons/codex.svg",
    color: "#10a37f",
    links: [
      { label: "Status", url: "https://status.openai.com/" },
      {
        label: "Usage dashboard",
        url: "https://chatgpt.com/codex/settings/usage",
      },
    ],
  },
];

export const USAGE_METRIC_GROUPS: IUsageMetricGroup[] = [
  {
    label: "Gemini models",
    models: ["Gemini Flash", "Gemini Pro"],
    metrics: [],
  },
  {
    label: "Claude and GPT models",
    models: ["Claude Opus", "Claude Sonnet", "GPT-OSS"],
    metrics: [],
  },
];

export const getUsageMetricGroupLabel = (label: string): string | null => {
  const normalizedLabel = label.toLowerCase();

  if (normalizedLabel.includes("gemini")) {
    return "Gemini models";
  }

  if (normalizedLabel.includes("claude") || normalizedLabel.includes("gpt")) {
    return "Claude and GPT models";
  }

  return null;
};

export const getUsageMetricGroupModels = (label: string | null): string[] =>
  USAGE_METRIC_GROUPS.find((group) => group.label === label)?.models ?? [];
