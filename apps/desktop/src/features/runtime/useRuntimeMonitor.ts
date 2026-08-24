import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildLocalServiceOwnerTargets, createDemoLocalServices, localServiceProcessKey } from "./model";
import type { ILocalService, ILocalServiceControlRequest, ILocalServiceControlResult, ILocalServiceOwnerTarget, ILocalServicesSnapshot, IRuntimeMonitorView, IRuntimeTargetSource } from "./types";

const ACTIVE_REFRESH_MS = 5_000;

interface IUseRuntimeMonitorOptions extends IRuntimeTargetSource {
  servicesActive: boolean;
  canUseNativeControls: boolean;
  demoMode: boolean;
}

export const useRuntimeMonitor = ({ canUseNativeControls, demoMode, registry, servicesActive, sessions }: IUseRuntimeMonitorOptions): IRuntimeMonitorView => {
  const serviceOwnerTargets = useMemo(() => buildLocalServiceOwnerTargets({ registry, sessions }), [registry, sessions]);
  const serviceOwnerTargetsRef = useRef(serviceOwnerTargets);
  const servicesLoadingRef = useRef(false);
  const servicesControlInFlightRef = useRef(false);
  const servicesRequestVersionRef = useRef(0);
  const demoStoppedProcessKeysRef = useRef(new Set<string>());
  const [services, setServices] = useState<ILocalService[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesError, setServicesError] = useState<string | null>(null);

  useEffect(() => {
    serviceOwnerTargetsRef.current = serviceOwnerTargets;
  }, [serviceOwnerTargets]);

  const refreshServices = useCallback(async () => {
    if (servicesLoadingRef.current || servicesControlInFlightRef.current) return;
    const requestVersion = servicesRequestVersionRef.current + 1;
    servicesRequestVersionRef.current = requestVersion;
    if (demoMode) {
      if (servicesRequestVersionRef.current === requestVersion) {
        setServices(createDemoLocalServices().filter((service) => !demoStoppedProcessKeysRef.current.has(localServiceProcessKey(service))));
        setServicesError(null);
      }
      return;
    }
    if (!canUseNativeControls) {
      setServices([]);
      setServicesError("Local services need the native Gyredeck app");
      return;
    }
    servicesLoadingRef.current = true;
    setServicesLoading(true);
    try {
      const ownerTargets: ILocalServiceOwnerTarget[] = serviceOwnerTargetsRef.current;
      const snapshot = await invoke<ILocalServicesSnapshot>("local_services", { ownerTargets });
      if (servicesRequestVersionRef.current !== requestVersion) return;
      setServices(snapshot.services);
      setServicesError(snapshot.error);
    } catch (reason) {
      if (servicesRequestVersionRef.current === requestVersion) {
        setServices([]);
        setServicesError(reason instanceof Error ? reason.message : "Could not inspect local services");
      }
    } finally {
      servicesLoadingRef.current = false;
      setServicesLoading(false);
    }
  }, [canUseNativeControls, demoMode]);

  const controlLocalService = useCallback(async (request: ILocalServiceControlRequest): Promise<ILocalServiceControlResult> => {
    if (demoMode) {
      const result: ILocalServiceControlResult = {
        processId: request.processId,
        bindAddress: request.bindAddress,
        port: request.port,
        status: request.mode === "stop" ? "stillRunning" : "killed",
        signal: request.mode === "stop" ? "SIGTERM" : "SIGKILL",
        stillListening: request.mode === "stop",
        error: null,
      };
      if (request.mode === "forceKill") {
        const processKey = `${request.processId}:${request.processStartTimeMs}`;
        demoStoppedProcessKeysRef.current.add(processKey);
        setServices((current) => current.filter((service) => localServiceProcessKey(service) !== processKey));
      }
      return result;
    }
    if (!canUseNativeControls) {
      return {
        processId: request.processId,
        bindAddress: request.bindAddress,
        port: request.port,
        status: "unsupported",
        signal: null,
        stillListening: false,
        error: "Local service control needs the native Gyredeck app",
      };
    }
    if (servicesControlInFlightRef.current) {
      return {
        processId: request.processId,
        bindAddress: request.bindAddress,
        port: request.port,
        status: "failed",
        signal: null,
        stillListening: true,
        error: "Another service control is still running",
      };
    }
    servicesControlInFlightRef.current = true;
    try {
      const result = await invoke<ILocalServiceControlResult>("control_local_service", { request });
      if (["stopped", "killed", "alreadyStopped"].includes(result.status)) {
        const processKey = `${request.processId}:${request.processStartTimeMs}`;
        setServices((current) => current.filter((service) => localServiceProcessKey(service) !== processKey));
        window.setTimeout(() => void refreshServices(), 150);
      } else if (result.status === "listenerStopped") {
        setServices((current) => current.filter((service) => !(
          service.processId === request.processId &&
          service.processStartTimeMs === request.processStartTimeMs &&
          service.bindAddress === request.bindAddress &&
          service.port === request.port
        )));
        window.setTimeout(() => void refreshServices(), 150);
      } else if (["identityChanged", "notAllowed"].includes(result.status)) {
        window.setTimeout(() => void refreshServices(), 150);
      }
      return result;
    } catch (reason) {
      return {
        processId: request.processId,
        bindAddress: request.bindAddress,
        port: request.port,
        status: "failed",
        signal: null,
        stillListening: true,
        error: reason instanceof Error ? reason.message : "Could not control the local service",
      };
    } finally {
      servicesControlInFlightRef.current = false;
    }
  }, [canUseNativeControls, demoMode, refreshServices]);

  useEffect(() => {
    if (!servicesActive) return undefined;
    void refreshServices();
    const timer = window.setInterval(() => void refreshServices(), ACTIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshServices, servicesActive]);

  return {
    services,
    servicesError,
    servicesLoading,
    refreshServices: () => void refreshServices(),
    controlLocalService,
  };
};
