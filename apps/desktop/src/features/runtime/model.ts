import type { IAgentActivityEventRuntime } from "@agent-activity/protocol";
import type { ILocalService, ILocalServiceOwnerTarget, IRuntimeTargetSource } from "./types";

const GIB = 1024 ** 3;
export const LOCAL_SERVICE_OWNER_TARGET_LIMIT = 512;

const isHostRuntime = (runtime: IAgentActivityEventRuntime | null | undefined): runtime is IAgentActivityEventRuntime =>
  runtime?.sourceKind === "lettaHost" && Number.isInteger(runtime.sourcePid) && runtime.sourcePid > 1 && Number.isFinite(runtime.sourceStartedAtMs);

export const buildLocalServiceOwnerTargets = ({ sessions, registry }: IRuntimeTargetSource): ILocalServiceOwnerTarget[] => {
  const byProcessIdentity = new Map<string, { target: ILocalServiceOwnerTarget; lastActivityAt: string }>();
  for (const session of sessions) {
    const runtimeEvent = (registry[session.conversationId] ?? []).find((event) => isHostRuntime(event.runtime));
    if (!runtimeEvent?.runtime || !isHostRuntime(runtimeEvent.runtime)) continue;
    const target: ILocalServiceOwnerTarget = {
      conversationId: session.conversationId,
      processId: runtimeEvent.runtime.sourcePid,
      expectedStartTimeMs: runtimeEvent.runtime.sourceStartedAtMs,
      project: session.project,
      herdrPaneId: session.herdrTarget?.sourcePid === runtimeEvent.runtime.sourcePid &&
        Math.abs(session.herdrTarget.sourceStartedAtMs - runtimeEvent.runtime.sourceStartedAtMs) <= 2_000
        ? session.herdrTarget.paneId
        : null,
    };
    const key = `${target.processId}:${target.expectedStartTimeMs}`;
    const previous = byProcessIdentity.get(key);
    if (!previous || Date.parse(session.lastActivityAt) > Date.parse(previous.lastActivityAt)) {
      byProcessIdentity.set(key, { target, lastActivityAt: session.lastActivityAt });
    }
  }
  return [...byProcessIdentity.values()]
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
    .slice(0, LOCAL_SERVICE_OWNER_TARGET_LIMIT)
    .map(({ target }) => target);
};

export const formatRuntimeBytes = (bytes: number | null | undefined): string => {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(bytes >= 10 * GIB ? 0 : 1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
};

export const formatRuntimeCpu = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? "—" : `${Math.round(value)}%`;

export const formatLocalServiceEndpoint = (service: Pick<ILocalService, "bindAddress" | "port">): string => {
  const host = service.bindAddress.includes(":") && !service.bindAddress.startsWith("[")
    ? `[${service.bindAddress}]`
    : service.bindAddress;
  return `${host}:${service.port}`;
};

export const localServiceProcessKey = (service: Pick<ILocalService, "processId" | "processStartTimeMs">): string =>
  `${service.processId}:${service.processStartTimeMs ?? "unknown"}`;

export const localServiceListenerKey = (service: Pick<ILocalService, "processId" | "processStartTimeMs" | "bindAddress" | "port">): string =>
  `${localServiceProcessKey(service)}:${service.bindAddress}:${service.port}`;

export const formatLocalServiceUptime = (startedAtMs: number | null, nowMs = Date.now()): string => {
  if (startedAtMs == null || !Number.isFinite(startedAtMs) || startedAtMs <= 0 || startedAtMs > nowMs) return "—";
  const minutes = Math.max(0, Math.floor((nowMs - startedAtMs) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

const DEMO_SERVICES_BASE_STARTED_AT_MS = Date.now();

export const createDemoLocalServices = (): ILocalService[] => [
  {
    processId: 40_680,
    processStartTimeMs: DEMO_SERVICES_BASE_STARTED_AT_MS - 32 * 60_000,
    processName: "node",
    parentProcessId: 40_600,
    parentProcessName: "letta",
    executablePath: "/opt/homebrew/bin/node",
    commandLine: "node /Users/mahiro/ghq/github.com/haabiz/admin-template/apps/catalog/node_modules/.bin/vite --port 5173",
    userId: 501,
    physicalFootprintBytes: 184 * 1024 ** 2,
    residentSizeBytes: 126 * 1024 ** 2,
    bindAddress: "127.0.0.1",
    port: 5173,
    kind: "http",
    webFrontend: true,
    httpTitle: "Haabiz UI",
    url: "http://127.0.0.1:5173",
    cwd: "/Users/mahiro/ghq/github.com/haabiz/admin-template/apps/catalog",
    owner: { conversationId: "local-conv-haabiz", project: "admin-template", herdrPaneId: "wH:p1" },
    controlAvailable: true,
    controlUnavailableReason: null,
  },
  {
    processId: 40_681,
    processStartTimeMs: DEMO_SERVICES_BASE_STARTED_AT_MS - 18 * 60_000,
    processName: "bun",
    parentProcessId: 40_610,
    parentProcessName: "letta",
    executablePath: "/Users/mahiro/.bun/bin/bun",
    commandLine: "bun run /Users/mahiro/ghq/github.com/j-kizt/building-frontends-pilot-morrow-one/server.ts",
    userId: 501,
    physicalFootprintBytes: 152 * 1024 ** 2,
    residentSizeBytes: 104 * 1024 ** 2,
    bindAddress: "127.0.0.1",
    port: 4173,
    kind: "http",
    webFrontend: true,
    httpTitle: "MORROW — ONE",
    url: "http://127.0.0.1:4173",
    cwd: "/Users/mahiro/ghq/github.com/j-kizt/building-frontends-pilot-morrow-one",
    owner: { conversationId: "local-conv-j-kizt", project: "j-kizt", herdrPaneId: "wB:pH" },
    controlAvailable: true,
    controlUnavailableReason: null,
  },
  {
    processId: 16_584,
    processStartTimeMs: DEMO_SERVICES_BASE_STARTED_AT_MS - 3 * 60 * 60_000,
    processName: "bun",
    parentProcessId: 16_500,
    parentProcessName: "Agent Activity",
    executablePath: "/Users/mahiro/.bun/bin/bun",
    commandLine: "bun /Applications/Agent Activity.app/Contents/Resources/agent-activity-bridge.mjs --port 47621",
    userId: 501,
    physicalFootprintBytes: 42 * 1024 ** 2,
    residentSizeBytes: 31 * 1024 ** 2,
    bindAddress: "127.0.0.1",
    port: 47_621,
    kind: "http",
    webFrontend: false,
    httpTitle: null,
    url: "http://127.0.0.1:47621",
    cwd: "/Users/mahiro/ghq/github.com/j-kizt/agent-activity",
    owner: { conversationId: "local-conv-agent-activity", project: "agent-activity", herdrPaneId: "wV:p1" },
    controlAvailable: false,
    controlUnavailableReason: "Agent Activity bridge is protected",
  },
  {
    processId: 16_590,
    processStartTimeMs: DEMO_SERVICES_BASE_STARTED_AT_MS - 9 * 60_000,
    processName: "Python",
    parentProcessId: 16_500,
    parentProcessName: "letta",
    executablePath: "/usr/bin/python3",
    commandLine: "/usr/bin/python3 -m http.server 8000",
    userId: 501,
    physicalFootprintBytes: 28 * 1024 ** 2,
    residentSizeBytes: 20 * 1024 ** 2,
    bindAddress: "127.0.0.1",
    port: 8000,
    kind: "http",
    webFrontend: false,
    httpTitle: "Directory listing for /",
    url: "http://127.0.0.1:8000",
    cwd: "/Users/mahiro/ghq/github.com/j-kizt/building-frontends-pilot-morrow-one",
    owner: { conversationId: "local-conv-j-kizt", project: "j-kizt", herdrPaneId: "wB:pH" },
    controlAvailable: true,
    controlUnavailableReason: null,
  },
  {
    processId: 1_637,
    processStartTimeMs: DEMO_SERVICES_BASE_STARTED_AT_MS - 2 * 24 * 60 * 60_000,
    processName: "redis-server",
    parentProcessId: 1,
    parentProcessName: "launchd",
    executablePath: "/opt/homebrew/bin/redis-server",
    commandLine: "redis-server 127.0.0.1:6379",
    userId: 501,
    physicalFootprintBytes: 19 * 1024 ** 2,
    residentSizeBytes: 12 * 1024 ** 2,
    bindAddress: "127.0.0.1",
    port: 6379,
    kind: "tcp",
    webFrontend: false,
    httpTitle: null,
    url: null,
    cwd: null,
    owner: null,
    controlAvailable: true,
    controlUnavailableReason: null,
  },
  {
    processId: 1_645,
    processStartTimeMs: DEMO_SERVICES_BASE_STARTED_AT_MS - 4 * 24 * 60 * 60_000,
    processName: "postgres",
    parentProcessId: 1,
    parentProcessName: "launchd",
    executablePath: "/opt/homebrew/bin/postgres",
    commandLine: "/opt/homebrew/bin/postgres -D /opt/homebrew/var/postgresql@16",
    userId: 501,
    physicalFootprintBytes: 65 * 1024 ** 2,
    residentSizeBytes: 52 * 1024 ** 2,
    bindAddress: "::1",
    port: 5432,
    kind: "tcp",
    webFrontend: false,
    httpTitle: null,
    url: null,
    cwd: null,
    owner: null,
    controlAvailable: true,
    controlUnavailableReason: null,
  },
];
