import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { formatLocalServiceEndpoint, formatLocalServiceUptime, formatRuntimeBytes, localServiceListenerKey } from "./model";
import type { ILocalService, ILocalServiceControlResult, IRuntimeMonitorView, LocalServiceControlMode } from "./types";

const openLocalServiceWindow = (url: string): boolean => {
  try {
    return window.open(url, "_blank", "noopener,noreferrer") !== null;
  } catch {
    return false;
  }
};

const openLocalService = async (service: ILocalService): Promise<boolean> => {
  if (!service.url) return false;
  if (typeof window.__TAURI_INTERNALS__ === "undefined") {
    return openLocalServiceWindow(service.url);
  }
  try {
    await invoke("open_external_url", { url: service.url });
    return true;
  } catch {
    return openLocalServiceWindow(service.url);
  }
};

type LocalServiceControlPhase = "idle" | "confirmStop" | "stopping" | "stillRunning" | "confirmForce" | "forceKilling" | "error";

// A bare process name like "node" says nothing about which app it is. The process's
// working directory is usually the project root, so fall back to its folder name
// (e.g. "altra-rich-frontend") to identify the service. Skip uninformative roots.
const projectFromCwd = (cwd: string | null): string | null => {
  if (!cwd) return null;
  const home = window.__GYREDECK_HOME__ ?? "";
  if (cwd === "/" || cwd === home) return null;
  const folder = cwd.split("/").filter(Boolean).at(-1) ?? "";
  return folder.length > 0 ? folder : null;
};

// Bare interpreters (node, python, …) name the runtime, not the service. When the
// process is an interpreter, the entry script (first non-flag arg) is the meaningful
// label; otherwise the process renamed itself (e.g. "next-server (v16.2.5)") and its
// own arg0 basename is the label.
const SCRIPT_EXT = /\.(mjs|js|cjs|ts|py|rb)$/i;
const basename = (value: string): string => value.split("/").filter(Boolean).at(-1) ?? value;

const nameFromCommand = (commandLine: string | null): string | null => {
  if (!commandLine) return null;
  const tokens = commandLine.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const interpreters = ["node", "python3", "python", "ruby", "deno", "bun", "php", "perl"];
  const isInterpreter = interpreters.some((name) => basename(tokens[0]).toLowerCase().startsWith(name));

  let label: string | null;
  if (isInterpreter) {
    // Prefer the entry script (a token ending in a script extension). Matching by
    // extension — not "first non-flag token" — survives spaces in the path, since the
    // basename only needs the trailing path segment. Fall back to null so the caller
    // can use the working-directory folder instead of a bare "node".
    const rest = tokens.slice(1);
    const script = rest.find((token) => SCRIPT_EXT.test(token)) ?? rest.find((token) => !token.startsWith("-"));
    label = script ? basename(script).replace(SCRIPT_EXT, "") : null;
  } else {
    // A process that renamed itself (e.g. "next-server (v16.2.5)").
    label = basename(tokens[0]);
  }
  label = label?.trim() ?? "";
  return label.length > 0 ? label : null;
};

const LocalServiceRow = ({ expanded, onControl, onOpen, onResult, onToggle, service }: {
  expanded: boolean;
  onControl: (service: ILocalService, mode: LocalServiceControlMode) => Promise<ILocalServiceControlResult>;
  onOpen: (service: ILocalService) => void;
  onResult: (message: string) => void;
  onToggle: (service: ILocalService) => void;
  service: ILocalService;
}) => {
  const genericTitle = service.httpTitle?.toLowerCase().startsWith("directory listing") || service.httpTitle?.toLowerCase().startsWith("index of ");
  const displayTitle = service.httpTitle && !genericTitle
    ? service.httpTitle
    : nameFromCommand(service.commandLine) ?? projectFromCwd(service.cwd) ?? service.processName;
  const ownerLabel = service.owner
    ? `Started by agent · ${service.owner.project}`
    : null;
  const detailsId = `local-service-${service.processId}-${service.port}-details`;
  const [phase, setPhase] = useState<LocalServiceControlPhase>("idle");
  const [controlError, setControlError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const busy = phase === "stopping" || phase === "forceKilling";
  const canControl = service.controlAvailable && service.processStartTimeMs != null;

  useEffect(() => {
    if (phase === "confirmStop" || phase === "confirmForce") cancelButtonRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (!expanded && !busy) {
      setPhase("idle");
      setControlError(null);
    }
  }, [busy, expanded]);

  const control = async (mode: LocalServiceControlMode) => {
    if (service.processStartTimeMs == null) return;
    setControlError(null);
    setPhase(mode === "stop" ? "stopping" : "forceKilling");
    const result = await onControl(service, mode);
    if (result.status === "stillRunning") {
      setPhase("stillRunning");
      onResult(`${service.processName} did not stop`);
      return;
    }
    if (["stopped", "killed", "alreadyStopped", "listenerStopped"].includes(result.status)) {
      setPhase("idle");
      onResult(result.status === "killed"
        ? `Force killed ${service.processName}`
        : result.status === "listenerStopped"
          ? `Listener stopped; ${service.processName} is still running`
          : `Stopped ${service.processName}`);
      return;
    }
    setPhase("error");
    const message = result.error ?? "Could not control this process";
    setControlError(message);
    onResult(message);
  };

  const cancelConfirmation = () => {
    setPhase(phase === "confirmForce" ? "stillRunning" : "idle");
    setControlError(null);
  };

  const handleDetailsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || busy) return;
    if (phase === "confirmStop" || phase === "confirmForce") {
      event.preventDefault();
      event.stopPropagation();
      cancelConfirmation();
    }
  };

  return (
    <li className="runtime-service-row" data-expanded={expanded} data-service-kind={service.kind} data-web-frontend={service.webFrontend}>
      <div className="runtime-row-main runtime-service-main">
        <span className="runtime-pressure-mark runtime-service-mark" aria-hidden="true" />
        <button className="runtime-service-disclosure" type="button" aria-expanded={expanded} aria-controls={detailsId} aria-label={`${expanded ? "Collapse" : "Expand"} ${displayTitle} service details on port ${service.port}`} onClick={() => onToggle(service)}>
          <span className="runtime-identity">
            <span className="runtime-project" title={service.httpTitle ?? undefined}>{displayTitle}</span>
            <span className="runtime-conversation">{formatLocalServiceEndpoint(service)}{displayTitle !== service.processName ? ` · ${service.processName}` : ""}</span>
          </span>
          <ChevronRight className="runtime-service-chevron" size={12} strokeWidth={2} aria-hidden="true" />
        </button>
        <span className="runtime-service-kind">{service.kind === "http" ? "HTTP" : "TCP"}</span>
        {service.url ? (
          <button className="row-btn runtime-service-open" type="button" onClick={() => onOpen(service)} aria-label={`Open ${displayTitle} on port ${service.port}`} title="Open in browser">
            <ExternalLink size={12} strokeWidth={2.1} />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div id={detailsId} className="runtime-service-details" onKeyDown={handleDetailsKeyDown} aria-busy={busy}>
          <dl className="runtime-service-detail-list">
            <div><dt>Process</dt><dd>{service.processName} · PID {service.processId}</dd></div>
            <div><dt>Started</dt><dd>{formatLocalServiceUptime(service.processStartTimeMs)} ago{service.userId != null ? ` · UID ${service.userId}` : ""}</dd></div>
            <div><dt>Memory</dt><dd>{formatRuntimeBytes(service.physicalFootprintBytes)} footprint · {formatRuntimeBytes(service.residentSizeBytes)} resident</dd></div>
            <div><dt>Parent</dt><dd>{service.parentProcessName ?? "Unknown"}{service.parentProcessId != null ? ` · PID ${service.parentProcessId}` : ""}</dd></div>
            <div><dt>Bind</dt><dd>{service.bindAddress} · {service.bindAddress === "0.0.0.0" || service.bindAddress === "::" ? "all interfaces" : "local only"}</dd></div>
            {service.executablePath ? <div><dt>Executable</dt><dd>{service.executablePath}</dd></div> : null}
            {service.cwd ? <div><dt>Working directory</dt><dd>{service.cwd}</dd></div> : null}
            {ownerLabel ? <div><dt>Owner</dt><dd title={service.owner?.conversationId}>{ownerLabel}</dd></div> : null}
          </dl>
          <div className="runtime-service-control">
            {phase === "confirmStop" || phase === "confirmForce" ? (
              <div className="runtime-service-confirm" role="group" aria-label={`${phase === "confirmForce" ? "Force kill" : "Stop"} ${service.processName}`}>
                <p>{phase === "confirmForce" ? `Force kill ${service.processName} (PID ${service.processId})? Unsaved work may be lost.` : `Stop ${service.processName} (PID ${service.processId})? This ends every listener owned by this process.`}</p>
                <div className="runtime-service-actions">
                  <button ref={cancelButtonRef} className="pill-btn" type="button" onClick={cancelConfirmation}>Cancel</button>
                  <button className="pill-btn danger" type="button" onClick={() => void control(phase === "confirmForce" ? "forceKill" : "stop")}>{phase === "confirmForce" ? "Force kill" : "Stop process"}</button>
                </div>
              </div>
            ) : busy ? (
              <span className="runtime-service-control-status" role="status">{phase === "stopping" ? `Stopping ${service.processName}…` : `Force killing ${service.processName}…`}</span>
            ) : phase === "stillRunning" ? (
              <div className="runtime-service-actions">
                <span className="runtime-service-control-status">Process did not stop.</span>
                <button className="pill-btn danger" type="button" onClick={() => setPhase("confirmForce")}>Force kill…</button>
              </div>
            ) : (
              <div className="runtime-service-actions">
                {controlError ? <span className="runtime-service-control-error" role="status">{controlError}</span> : null}
                {canControl ? <button className="pill-btn danger" type="button" onClick={() => setPhase("confirmStop")}>Stop process…</button> : <span className="runtime-service-control-status">{service.controlUnavailableReason ?? "Process control unavailable"}</span>}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
};

const LocalServiceGroup = ({ expandedKey, id, label, showHeader = true, onControl, onOpen, onResult, onToggle, services }: {
  expandedKey: string | null;
  id: string;
  label: string;
  showHeader?: boolean;
  onControl: (service: ILocalService, mode: LocalServiceControlMode) => Promise<ILocalServiceControlResult>;
  onOpen: (service: ILocalService) => void;
  onResult: (message: string) => void;
  onToggle: (service: ILocalService) => void;
  services: ILocalService[];
}) => {
  if (services.length === 0) return null;
  const headingId = `runtime-services-${id}-heading`;
  return (
    <section data-service-group={id} aria-labelledby={showHeader ? headingId : undefined} aria-label={showHeader ? undefined : label}>
      {showHeader ? (
        <div className="session-section-head">
          <span id={headingId}>{label}</span>
          <span className="runtime-group-count">{services.length}</span>
        </div>
      ) : null}
      <ul className="runtime-list">
        {services.map((service) => {
          const key = localServiceListenerKey(service);
          return <LocalServiceRow key={key} expanded={expandedKey === key} onControl={onControl} onOpen={onOpen} onResult={onResult} onToggle={onToggle} service={service} />;
        })}
      </ul>
    </section>
  );
};

export const LocalServicesPanel = ({ monitor }: { monitor: IRuntimeMonitorView }) => {
  const [serviceOpenError, setServiceOpenError] = useState<string | null>(null);
  const [expandedServiceKey, setExpandedServiceKey] = useState<string | null>(null);
  const [controlAnnouncement, setControlAnnouncement] = useState("");
  const webFrontends = useMemo(() => monitor.services.filter((service) => service.webFrontend), [monitor.services]);
  const otherServices = useMemo(() => monitor.services.filter((service) => !service.webFrontend), [monitor.services]);
  useEffect(() => {
    if (expandedServiceKey && !monitor.services.some((service) => localServiceListenerKey(service) === expandedServiceKey)) setExpandedServiceKey(null);
  }, [expandedServiceKey, monitor.services]);
  const openService = async (service: ILocalService) => {
    setServiceOpenError(null);
    if (!(await openLocalService(service))) setServiceOpenError("Could not open local service");
  };
  const toggleService = (service: ILocalService) => {
    const key = localServiceListenerKey(service);
    setExpandedServiceKey((current) => current === key ? null : key);
  };
  const controlService = (service: ILocalService, mode: LocalServiceControlMode) => {
    if (service.processStartTimeMs == null) {
      return Promise.resolve({
        processId: service.processId,
        bindAddress: service.bindAddress,
        port: service.port,
        status: "notAllowed",
        signal: null,
        stillListening: true,
        error: "Process identity is unavailable",
      });
    }
    return monitor.controlLocalService({
      processId: service.processId,
      processStartTimeMs: service.processStartTimeMs,
      bindAddress: service.bindAddress,
      port: service.port,
      mode,
    });
  };
  return (
    <section className="runtime-panel" aria-label="Local services">
      <div className="runtime-toolbar">
        <div className="runtime-subtitle">{monitor.services.length} local listeners</div>
        <div className="runtime-toolbar-actions">
          {monitor.servicesLoading ? <span className="runtime-ended-count" role="status">Checking…</span> : null}
          <button className="gear-btn" type="button" onClick={monitor.refreshServices} disabled={monitor.servicesLoading} aria-busy={monitor.servicesLoading} aria-label={monitor.servicesLoading ? "Refreshing Services" : "Refresh Services"} title="Refresh local services">
            <RefreshCw size={13} className={monitor.servicesLoading ? "is-spinning" : undefined} />
          </button>
        </div>
      </div>
      {monitor.servicesError ? <div className="notice-row compact" data-online="false" role="status">{monitor.servicesError}</div> : null}
      {serviceOpenError ? <div className="notice-row compact" data-online="false" role="status">{serviceOpenError}</div> : null}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{controlAnnouncement}</span>
      {monitor.services.length === 0 ? (
        <div className="empty-text small">No listening TCP services detected</div>
      ) : (
        <div className="runtime-service-groups">
          <LocalServiceGroup expandedKey={expandedServiceKey} id="web-frontends" label="Detected web frontends" services={webFrontends} onControl={controlService} onOpen={openService} onResult={setControlAnnouncement} onToggle={toggleService} />
          <LocalServiceGroup expandedKey={expandedServiceKey} id="other" label="Other listeners" showHeader={webFrontends.length > 0} services={otherServices} onControl={controlService} onOpen={openService} onResult={setControlAnnouncement} onToggle={toggleService} />
        </div>
      )}
    </section>
  );
};
