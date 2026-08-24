import type { SessionEventRegistry, ISessionSummary } from "../session/types";

export interface ILocalServiceOwnerTarget {
  conversationId: string;
  processId: number;
  expectedStartTimeMs: number;
  project: string;
}

export type LocalServiceKind = "http" | "tcp";

export interface ILocalServiceOwner {
  conversationId: string;
  project: string;
}

export interface ILocalService {
  processId: number;
  processStartTimeMs: number | null;
  processName: string;
  parentProcessId: number | null;
  parentProcessName: string | null;
  executablePath: string | null;
  commandLine: string | null;
  userId: number | null;
  physicalFootprintBytes: number | null;
  residentSizeBytes: number | null;
  bindAddress: string;
  port: number;
  kind: LocalServiceKind;
  webFrontend: boolean;
  httpTitle: string | null;
  url: string | null;
  cwd: string | null;
  owner: ILocalServiceOwner | null;
  controlAvailable: boolean;
  controlUnavailableReason: string | null;
}

export type LocalServiceControlMode = "stop" | "forceKill";

export interface ILocalServiceControlRequest {
  processId: number;
  processStartTimeMs: number;
  bindAddress: string;
  port: number;
  mode: LocalServiceControlMode;
}

export interface ILocalServiceControlResult {
  processId: number;
  bindAddress: string;
  port: number;
  status: "stopped" | "killed" | "alreadyStopped" | "listenerStopped" | "stillRunning" | "identityChanged" | "notAllowed" | "permissionDenied" | "revalidationUnavailable" | "failed" | "unsupported" | string;
  signal: "SIGTERM" | "SIGKILL" | null;
  stillListening: boolean;
  error: string | null;
}

export interface ILocalServicesSnapshot {
  sampledAtMs: number;
  status: "ok" | "unsupported" | "error" | string;
  error: string | null;
  services: ILocalService[];
}

export interface IRuntimeMonitorView {
  services: ILocalService[];
  servicesError: string | null;
  servicesLoading: boolean;
  refreshServices: () => void;
  controlLocalService: (request: ILocalServiceControlRequest) => Promise<ILocalServiceControlResult>;
}

export interface IRuntimeTargetSource {
  sessions: ISessionSummary[];
  registry: SessionEventRegistry;
}
