export interface IGithubCommit {
  sha: string;
  message: string;
  author: string;
  committed_at: string;
}

export interface IGithubRun {
  name: string;
  status: string;
  conclusion: string | null;
  branch: string;
  created_at: string;
}

export interface IGithubPull {
  number: number;
  title: string;
  author: string;
  updated_at: string;
}

export interface IGithubRepoStatus {
  repo: string;
  commit: IGithubCommit | null;
  runs: IGithubRun[];
  open_pr_count: number;
  pulls: IGithubPull[];
  error: string | null;
}

export type GitProvider = "github" | "gitlab";

export interface IGhAccount {
  login: string;
  active: boolean;
  provider: GitProvider;
}

export interface IDeviceCodeStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export interface IDevicePollResult {
  status: "pending" | "success";
  login: string | null;
}

export type GithubRepoState =
  | { status: "loading" }
  | { status: "ready"; data: IGithubRepoStatus; updatedAt: number }
  | { status: "error"; message: string; data?: IGithubRepoStatus; updatedAt?: number };
