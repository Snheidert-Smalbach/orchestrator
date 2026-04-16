import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Activity,
  ArrowRightLeft,
  Cable,
  Network,
  Radio,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  deleteServiceLink,
  getServiceGraphSnapshot,
  getSnapshot,
  listenServiceTrafficEvents,
  saveProject as saveProjectConfig,
  saveServiceLink,
} from "../lib/tauri";
import type {
  Project,
  ProjectEnvOverride,
  ProjectServiceLink,
  ServiceGraphConnection,
  ServiceGraphEnvVariable,
  ServiceGraphProject,
  ServiceGraphSnapshot,
  ServiceTrafficEvent,
} from "../lib/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { DialogShell } from "./ui/dialog-shell";
import { EmptyState } from "./ui/empty-state";
import { FieldHint, FieldLabel, FieldLabelWrap } from "./ui/field";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  focusProjectId?: string | null;
};
type StandaloneProps = {
  focusProjectId?: string | null;
};
type ServiceTopologyShell = "dialog" | "standalone";
type ServiceTopologyNodePosition = { x: number; y: number };
type ServiceTopologySurfaceProps = {
  active: boolean;
  focusProjectId?: string | null;
  shell: ServiceTopologyShell;
  onOpenChange?: (open: boolean) => void;
};
type TopologyWindowFocusPayload = {
  focusProjectId?: string | null;
};

type LinkDraft = {
  id: string;
  sourceProjectId: string;
  sourceEnvKey: string;
  targetProjectId: string;
  targetEnvKey: string;
  protocol: string;
  host: string;
  path: string;
  query: string;
  sourceKind: "manual" | "inferred" | "new";
};

type ServiceNodeData = {
  project: ServiceGraphProject;
  focused: boolean;
  liveStatus: "ok" | "error" | null;
  lastActivityLabel: string | null;
};

type ServiceNode = Node<ServiceNodeData, "service">;
type ResolvedTrafficEvent = ServiceTrafficEvent & {
  resolvedSourceProjectId: string | null;
  resolvedSourceLabel: string;
  resolvedTargetLabel: string;
  matchedConnectionIds: string[];
};

const LIVE_WINDOW_MS = 14000;
const LIVE_PANEL_EVENTS = 4;
const DEFAULT_LINK_HOST = "127.0.0.1";
const DEFAULT_TARGET_ENV_KEY = "PORT";
const SERVICE_TOPOLOGY_LAYOUT_STORAGE_KEY = "back-orchestrator.service-topology-layout.v1";
const NODE_WIDTH = 214;
const GRID_GAP_X = 278;
const GRID_GAP_Y = 184;
const PROJECT_COLUMNS = 4;

function createLinkId() {
  return `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function envDraftKey(projectId: string, envKey: string) {
  return `${projectId}::${envKey}`;
}

function normalizeLinkPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeLinkQuery(query: string) {
  const trimmed = query.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("?") ? trimmed : `?${trimmed}`;
}

function normalizeProtocol(protocol: string) {
  return protocol.trim().toLowerCase() === "https" ? "https" : "http";
}

function normalizeHost(host: string) {
  return host.trim() || DEFAULT_LINK_HOST;
}

function buildDefaultPosition(index: number) {
  return {
    x: (index % PROJECT_COLUMNS) * GRID_GAP_X,
    y: Math.floor(index / PROJECT_COLUMNS) * GRID_GAP_Y,
  };
}

function loadStoredNodePositions() {
  if (typeof window === "undefined") {
    return {} as Record<string, ServiceTopologyNodePosition>;
  }

  try {
    const raw = window.localStorage.getItem(SERVICE_TOPOLOGY_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return {} as Record<string, ServiceTopologyNodePosition>;
    }

    const parsed = JSON.parse(raw) as Record<string, Partial<ServiceTopologyNodePosition>>;
    return Object.entries(parsed).reduce<Record<string, ServiceTopologyNodePosition>>((accumulator, [projectId, position]) => {
      if (typeof position?.x === "number" && Number.isFinite(position.x) && typeof position?.y === "number" && Number.isFinite(position.y)) {
        accumulator[projectId] = { x: position.x, y: position.y };
      }
      return accumulator;
    }, {});
  } catch {
    return {} as Record<string, ServiceTopologyNodePosition>;
  }
}

function persistNodePositions(positions: Record<string, ServiceTopologyNodePosition>) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(SERVICE_TOPOLOGY_LAYOUT_STORAGE_KEY, JSON.stringify(positions));
}

function parseTemplateFromValue(value: string | null | undefined) {
  if (!value?.trim()) {
    return {
      protocol: "http",
      host: DEFAULT_LINK_HOST,
      path: "",
      query: "",
    };
  }

  try {
    const normalized = value.includes("://") ? value : `http://${value}`;
    const url = new URL(normalized);
    return {
      protocol: normalizeProtocol(url.protocol.replace(":", "")),
      host: normalizeHost(url.hostname),
      path: url.pathname === "/" ? "" : normalizeLinkPath(url.pathname),
      query: normalizeLinkQuery(url.search),
    };
  } catch {
    return {
      protocol: "http",
      host: DEFAULT_LINK_HOST,
      path: "",
      query: "",
    };
  }
}

function pickDefaultEnvKey(project: ServiceGraphProject | null) {
  if (!project) {
    return "";
  }

  return (
    project.envVariables.find((env) => env.isUrlLike && env.enabled)?.key ??
    project.envVariables.find((env) => env.enabled)?.key ??
    project.envVariables[0]?.key ??
    ""
  );
}

function buildLinkDraftFromConnection(connection: ServiceGraphConnection): LinkDraft {
  return {
    id: connection.linkSource === "manual" ? connection.id : createLinkId(),
    sourceProjectId: connection.sourceProjectId,
    sourceEnvKey: connection.sourceEnvKey,
    targetProjectId: connection.targetProjectId,
    targetEnvKey: connection.targetEnvKey ?? DEFAULT_TARGET_ENV_KEY,
    protocol: normalizeProtocol(connection.protocol),
    host: normalizeHost(connection.host),
    path: normalizeLinkPath(connection.path),
    query: normalizeLinkQuery(connection.query),
    sourceKind: connection.linkSource === "inferred" ? "inferred" : "manual",
  };
}

function formatActivityLabel(event: ServiceTrafficEvent | null) {
  if (!event) {
    return null;
  }

  return `${event.method} ${event.path} ${event.statusCode ?? (event.error ? "ERR" : "...")}`;
}

function normalizeMatchText(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeMatchPath(path: string | null | undefined) {
  const normalized = normalizeLinkPath(path ?? "");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function scoreConnectionPathMatch(connectionPath: string, requestPath: string) {
  const normalizedConnectionPath = normalizeMatchPath(connectionPath);
  const normalizedRequestPath = normalizeMatchPath(requestPath);

  if (!normalizedConnectionPath || !normalizedRequestPath) {
    return 0;
  }

  if (normalizedRequestPath === normalizedConnectionPath) {
    return 48;
  }

  if (normalizedRequestPath.startsWith(`${normalizedConnectionPath}/`)) {
    return 28;
  }

  return 0;
}

function resolveTrafficEvent(
  event: ServiceTrafficEvent,
  connections: ServiceGraphConnection[],
  projectsById: Map<string, ServiceGraphProject>,
): ResolvedTrafficEvent {
  const targetConnections = connections.filter((connection) => connection.targetProjectId === event.targetProjectId);
  const normalizedSourceLabel = normalizeMatchText(event.sourceLabel);
  let resolvedSourceProjectId = event.sourceProjectId;

  if (!resolvedSourceProjectId && normalizedSourceLabel) {
    const labelMatches = targetConnections.filter(
      (connection) => normalizeMatchText(projectsById.get(connection.sourceProjectId)?.projectName) === normalizedSourceLabel,
    );
    const uniqueLabelSources = [...new Set(labelMatches.map((connection) => connection.sourceProjectId))];
    if (uniqueLabelSources.length === 1) {
      resolvedSourceProjectId = uniqueLabelSources[0];
    }
  }

  if (!resolvedSourceProjectId && targetConnections.length) {
    const pathMatches = targetConnections.filter((connection) => scoreConnectionPathMatch(connection.path, event.path) > 0);
    const uniquePathSources = [...new Set(pathMatches.map((connection) => connection.sourceProjectId))];
    if (uniquePathSources.length === 1) {
      resolvedSourceProjectId = uniquePathSources[0];
    } else if (uniquePathSources.length === 0) {
      const uniqueSources = [...new Set(targetConnections.map((connection) => connection.sourceProjectId))];
      if (uniqueSources.length === 1) {
        resolvedSourceProjectId = uniqueSources[0];
      }
    }
  }

  const scopedConnections = resolvedSourceProjectId
    ? targetConnections.filter((connection) => connection.sourceProjectId === resolvedSourceProjectId)
    : targetConnections;
  const pathScopedMatches = scopedConnections.filter((connection) => scoreConnectionPathMatch(connection.path, event.path) > 0);
  const matchedConnections =
    pathScopedMatches.length > 0
      ? pathScopedMatches
      : resolvedSourceProjectId
        ? scopedConnections
        : targetConnections.length === 1
          ? targetConnections
          : [];

  return {
    ...event,
    resolvedSourceProjectId,
    resolvedSourceLabel:
      (resolvedSourceProjectId ? projectsById.get(resolvedSourceProjectId)?.projectName : null) ?? event.sourceLabel ?? "externo",
    resolvedTargetLabel: projectsById.get(event.targetProjectId)?.projectName ?? event.targetProjectId,
    matchedConnectionIds: matchedConnections.map((connection) => connection.id),
  };
}

function trafficTimestampValue(value: string) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildTargetOptions(projects: ServiceGraphProject[], sourceProjectId: string) {
  return projects.filter((project) => project.projectId !== sourceProjectId);
}

function buildTargetEnvOptions(targetProject: ServiceGraphProject | null) {
  if (!targetProject) {
    return [DEFAULT_TARGET_ENV_KEY];
  }

  const keys = targetProject.envVariables.map((env) => env.key).filter((key) => /port/i.test(key));
  return [...new Set([DEFAULT_TARGET_ENV_KEY, ...keys])];
}

function describeLinkPreview(draft: LinkDraft, targetProject: ServiceGraphProject | null, targetEnvKey: string) {
  const targetEnv = targetProject?.envVariables.find((env) => env.key === targetEnvKey) ?? null;
  const rawPort = targetEnv?.value ?? String(targetProject?.runtimePort ?? targetProject?.configuredPort ?? "");
  const portText = rawPort.trim().replace(/[^\d].*$/, "");
  const port = portText || String(targetProject?.runtimePort ?? targetProject?.configuredPort ?? "");

  if (!port) {
    return "El destino todavía no expone un puerto resoluble.";
  }

  return `${normalizeProtocol(draft.protocol)}://${normalizeHost(draft.host)}:${port}${normalizeLinkPath(draft.path)}${normalizeLinkQuery(draft.query)}`;
}

function buildEnvOverrideId(projectId: string, envKey: string, existingId?: string | null) {
  return existingId ?? `${projectId}-override-${envKey.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function isSecretEnvKey(envKey: string) {
  return /(secret|token|password|key)/i.test(envKey);
}

function upsertEnvOverride(
  project: Project,
  envKey: string,
  envValue: string,
  sourceEnv?: ServiceGraphEnvVariable | null,
) {
  const nextOverrides = [...project.envOverrides];
  const existingIndex = nextOverrides.findIndex((entry) => entry.key === envKey);
  const nextOverride: ProjectEnvOverride = {
    id: buildEnvOverrideId(project.id, envKey, existingIndex >= 0 ? nextOverrides[existingIndex]?.id : null),
    key: envKey,
    value: envValue,
    enabled: true,
    isSecret: sourceEnv?.isSecret ?? isSecretEnvKey(envKey),
  };

  if (existingIndex >= 0) {
    nextOverrides[existingIndex] = nextOverride;
  } else {
    nextOverrides.push(nextOverride);
  }

  return {
    ...project,
    envOverrides: nextOverrides,
  } satisfies Project;
}

function ServiceTopologyNode({ data }: NodeProps<ServiceNode>) {
  const runtimePort = data.project.runtimePort ?? data.project.configuredPort;
  const configuredPort = data.project.configuredPort;
  const portLabel =
    runtimePort && configuredPort && runtimePort !== configuredPort
      ? `${runtimePort} · cfg ${configuredPort}`
      : runtimePort ?? configuredPort ?? "sin puerto";

  return (
    <div
      title={data.lastActivityLabel ?? "Click para configurar variables y enlaces"}
      className={[
        "service-topology-node",
        data.focused ? "service-topology-node--focused" : "",
        data.liveStatus === "error" ? "service-topology-node--error" : "",
      ].join(" ")}
    >
      <Handle type="target" id="target" position={Position.Left} className="service-topology-node__target" />
      <Handle type="source" id="source" position={Position.Right} className="service-topology-node__source" />

      <div className="service-topology-node__compact">
        <div className="service-topology-node__compactHeader">
          <span className={["service-topology-node__status", `is-${data.project.status}`].join(" ")}>
            <Radio className="h-3 w-3" />
            {data.project.status}
          </span>
          <span className="service-topology-node__compactHint">
            <Settings2 className="h-3 w-3" />
            env
          </span>
        </div>

        <h3 className="service-topology-node__compactTitle">{data.project.projectName}</h3>

        <div className="service-topology-node__compactPorts">
          <span className="service-topology-node__portPill">{portLabel}</span>
          {data.project.launchMode !== "service" ? (
            <span className="service-topology-node__modePill">{data.project.launchMode}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  service: ServiceTopologyNode,
};

function ServiceTopologySurface({ active, onOpenChange, focusProjectId, shell }: ServiceTopologySurfaceProps) {
  const [graphSnapshot, setGraphSnapshot] = useState<ServiceGraphSnapshot | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [trafficEvents, setTrafficEvents] = useState<ServiceTrafficEvent[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(focusProjectId ?? null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [draftLink, setDraftLink] = useState<LinkDraft | null>(null);
  const [nodePositions, setNodePositions] = useState<Record<string, ServiceTopologyNodePosition>>(loadStoredNodePositions);
  const [envDrafts, setEnvDrafts] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (active) {
      setSelectedProjectId(focusProjectId ?? null);
    }
  }, [active, focusProjectId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    void Promise.all([getServiceGraphSnapshot(), getSnapshot()])
      .then(([nextGraph, nextSnapshot]) => {
        if (cancelled) {
          return;
        }

        setGraphSnapshot(nextGraph);
        setProjects(nextSnapshot.projects);
        setTrafficEvents([]);
        setSelectedConnectionId(null);
        setDraftLink(null);
        setSelectedProjectId((current) => current ?? focusProjectId ?? nextGraph.projects[0]?.projectId ?? null);
      })
      .catch((errorValue) => {
        if (!cancelled) {
          setError(errorValue instanceof Error ? errorValue.message : "No fue posible cargar el mapa visual.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [active, focusProjectId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    let dispose: (() => void) | null = null;
    void listenServiceTrafficEvents((payload) => {
      setTrafficEvents((current) => [...current, payload].slice(-120));
    }).then((unlisten) => {
      dispose = unlisten;
    });

    return () => {
      dispose?.();
    };
  }, [active]);

  useEffect(() => {
    if (shell !== "standalone" || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let dispose: (() => void) | null = null;
    void import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow().listen<TopologyWindowFocusPayload>("service-topology-focus-project", (event) => {
          if (event.payload.focusProjectId) {
            setSelectedProjectId(event.payload.focusProjectId);
          }
          setSelectedConnectionId(null);
          setDraftLink(null);
        }),
      )
      .then((unlisten) => {
        dispose = unlisten;
      })
      .catch(() => {
        dispose = null;
      });

    return () => {
      dispose?.();
    };
  }, [shell]);

  useEffect(() => {
    if (!graphSnapshot) {
      return;
    }

    setNodePositions((current) => {
      const next = { ...current };
      graphSnapshot.projects.forEach((project, index) => {
        if (!next[project.projectId]) {
          next[project.projectId] = buildDefaultPosition(index);
        }
      });
      return next;
    });

    setEnvDrafts(
      graphSnapshot.projects.reduce<Record<string, string>>((accumulator, project) => {
        project.envVariables.forEach((env) => {
          accumulator[envDraftKey(project.projectId, env.key)] = env.value;
        });
        return accumulator;
      }, {}),
    );
  }, [graphSnapshot]);

  useEffect(() => {
    persistNodePositions(nodePositions);
  }, [nodePositions]);

  const graphProjectsById = useMemo(() => {
    return new Map(graphSnapshot?.projects.map((project) => [project.projectId, project]) ?? []);
  }, [graphSnapshot]);

  const projectsById = useMemo(() => {
    return new Map(projects.map((project) => [project.id, project]));
  }, [projects]);

  const liveTraffic = useMemo(() => {
    const cutoff = Date.now() - LIVE_WINDOW_MS;
    return trafficEvents.filter((event) => trafficTimestampValue(event.timestamp) >= cutoff);
  }, [trafficEvents]);

  const resolvedLiveTraffic = useMemo<ResolvedTrafficEvent[]>(() => {
    if (!graphSnapshot) {
      return liveTraffic.map((event) => ({
        ...event,
        resolvedSourceProjectId: event.sourceProjectId,
        resolvedSourceLabel: event.sourceLabel ?? "externo",
        resolvedTargetLabel: event.targetProjectId,
        matchedConnectionIds: [],
      }));
    }

    return liveTraffic.map((event) => resolveTrafficEvent(event, graphSnapshot.connections, graphProjectsById));
  }, [graphProjectsById, graphSnapshot, liveTraffic]);

  const trafficByProject = useMemo(() => {
    const entries = new Map<string, { liveStatus: "ok" | "error" | null; lastActivityLabel: string | null }>();

    for (const event of resolvedLiveTraffic) {
      const currentTarget = entries.get(event.targetProjectId) ?? {
        liveStatus: null,
        lastActivityLabel: null,
      };
      currentTarget.liveStatus = event.ok ? (currentTarget.liveStatus === "error" ? "error" : "ok") : "error";
      currentTarget.lastActivityLabel = formatActivityLabel(event);
      entries.set(event.targetProjectId, currentTarget);

      if (event.resolvedSourceProjectId) {
        const currentSource = entries.get(event.resolvedSourceProjectId) ?? {
          liveStatus: null,
          lastActivityLabel: null,
        };
        if (!currentSource.lastActivityLabel) {
          currentSource.lastActivityLabel = formatActivityLabel(event);
        }
        currentSource.liveStatus = !event.ok ? "error" : currentSource.liveStatus ?? "ok";
        entries.set(event.resolvedSourceProjectId, currentSource);
      }
    }

    return entries;
  }, [resolvedLiveTraffic]);

  const nodes = useMemo<ServiceNode[]>(() => {
    if (!graphSnapshot) {
      return [];
    }

    return graphSnapshot.projects.map((project, index) => {
      const traffic = trafficByProject.get(project.projectId) ?? {
        liveStatus: null,
        lastActivityLabel: null,
      };

      return {
        id: project.projectId,
        type: "service",
        position: nodePositions[project.projectId] ?? buildDefaultPosition(index),
        data: {
          project,
          focused: selectedProjectId === project.projectId,
          liveStatus: traffic.liveStatus,
          lastActivityLabel: traffic.lastActivityLabel,
        },
        style: { width: NODE_WIDTH },
      };
    });
  }, [graphSnapshot, nodePositions, selectedProjectId, trafficByProject]);

  const edges = useMemo<Edge[]>(() => {
    if (!graphSnapshot) {
      return [];
    }

    return graphSnapshot.connections.map((connection) => {
      const recentMatch = [...resolvedLiveTraffic]
        .reverse()
        .find((event) => event.matchedConnectionIds.includes(connection.id));
      const isSelected = selectedConnectionId === connection.id;
      const stroke = recentMatch
        ? recentMatch.ok
          ? "rgba(34, 197, 94, 0.88)"
          : "rgba(248, 113, 113, 0.92)"
        : connection.linkSource === "manual"
          ? "rgba(35, 213, 246, 0.9)"
          : "rgba(148, 163, 184, 0.55)";

      const label = recentMatch
        ? `${recentMatch.method} ${connection.sourceEnvKey} ${recentMatch.statusCode ?? "ERR"}`
        : connection.linkSource === "manual"
          ? connection.sourceEnvKey
          : `Auto ${connection.sourceEnvKey}`;

      return {
        id: connection.id,
        source: connection.sourceProjectId,
        sourceHandle: "source",
        target: connection.targetProjectId,
        targetHandle: "target",
        type: "smoothstep",
        animated: Boolean(recentMatch),
        interactionWidth: 28,
        zIndex: recentMatch ? 20 : isSelected ? 12 : 3,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 18,
          height: 18,
          color: stroke,
        },
        label,
        labelStyle: {
          fill: recentMatch?.ok ? "#8bff4d" : recentMatch ? "#f87171" : "#dce7f3",
          fontSize: 10,
          fontWeight: 700,
        },
        labelBgStyle: {
          fill: "rgba(9, 17, 33, 0.92)",
          fillOpacity: 1,
          stroke: isSelected ? "rgba(35, 213, 246, 0.9)" : "rgba(148, 163, 184, 0.2)",
          strokeWidth: 1,
        },
        style: {
          stroke,
          strokeWidth: recentMatch ? (isSelected ? 4.6 : 4.1) : isSelected ? 3.1 : 2.1,
          opacity: recentMatch ? 1 : 0.92,
          strokeDasharray: connection.linkSource === "inferred" ? "7 5" : undefined,
        },
      };
    });
  }, [graphSnapshot, resolvedLiveTraffic, selectedConnectionId]);

  const selectedConnection = useMemo(() => {
    return graphSnapshot?.connections.find((connection) => connection.id === selectedConnectionId) ?? null;
  }, [graphSnapshot, selectedConnectionId]);

  const activeDraft = draftLink ?? (selectedConnection ? buildLinkDraftFromConnection(selectedConnection) : null);
  const activeSourceGraphProject = activeDraft ? graphProjectsById.get(activeDraft.sourceProjectId) ?? null : null;
  const activeTargetGraphProject = activeDraft ? graphProjectsById.get(activeDraft.targetProjectId) ?? null : null;
  const selectedProjectGraph = selectedProjectId ? graphProjectsById.get(selectedProjectId) ?? null : null;
  const selectedProjectFull = selectedProjectId ? projectsById.get(selectedProjectId) ?? null : null;
  const linkSourceEnv =
    activeDraft && activeSourceGraphProject
      ? activeSourceGraphProject.envVariables.find((env) => env.key === activeDraft.sourceEnvKey) ?? null
      : null;
  const linkEnvDraftValue = activeDraft
    ? envDrafts[envDraftKey(activeDraft.sourceProjectId, activeDraft.sourceEnvKey)] ?? linkSourceEnv?.value ?? ""
    : "";
  const targetOptions = activeDraft && graphSnapshot ? buildTargetOptions(graphSnapshot.projects, activeDraft.sourceProjectId) : [];
  const targetEnvOptions = activeDraft ? buildTargetEnvOptions(activeTargetGraphProject) : [DEFAULT_TARGET_ENV_KEY];

  async function reloadTopologyData(options?: {
    preserveConnectionId?: string | null;
    preserveProjectId?: string | null;
  }) {
    const [nextGraph, nextSnapshot] = await Promise.all([getServiceGraphSnapshot(), getSnapshot()]);
    setGraphSnapshot(nextGraph);
    setProjects(nextSnapshot.projects);

    const nextProjectId =
      options?.preserveProjectId && nextGraph.projects.some((project) => project.projectId === options.preserveProjectId)
        ? options.preserveProjectId
        : nextGraph.projects[0]?.projectId ?? null;
    const nextConnectionId =
      options?.preserveConnectionId && nextGraph.connections.some((connection) => connection.id === options.preserveConnectionId)
        ? options.preserveConnectionId
        : null;

    setSelectedProjectId(nextProjectId);
    setSelectedConnectionId(nextConnectionId);
    return { nextGraph, nextSnapshot };
  }

  async function refreshSnapshot() {
    setIsLoading(true);
    setError(null);

    try {
      await reloadTopologyData({
        preserveConnectionId: selectedConnectionId,
        preserveProjectId: selectedProjectId,
      });
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "No fue posible refrescar el mapa.");
    } finally {
      setIsLoading(false);
    }
  }

  async function persistEnvValue(projectId: string, envKey: string, envValue: string, envMeta?: ServiceGraphEnvVariable | null) {
    const project = projectsById.get(projectId);
    if (!project) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      await saveProjectConfig(upsertEnvOverride(project, envKey, envValue, envMeta));
      await reloadTopologyData({
        preserveConnectionId: selectedConnectionId,
        preserveProjectId: projectId,
      });
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "No fue posible guardar el override del .env.");
      throw errorValue;
    } finally {
      setIsSaving(false);
    }
  }

  async function persistLink(nextDraft: LinkDraft) {
    if (!nextDraft.sourceProjectId || !nextDraft.sourceEnvKey || !nextDraft.targetProjectId) {
      setError("Selecciona variable origen y microservicio destino antes de guardar.");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const nextGraph = await saveServiceLink({
        id: nextDraft.id,
        sourceProjectId: nextDraft.sourceProjectId,
        sourceEnvKey: nextDraft.sourceEnvKey,
        targetProjectId: nextDraft.targetProjectId,
        targetEnvKey: nextDraft.targetEnvKey || DEFAULT_TARGET_ENV_KEY,
        protocol: normalizeProtocol(nextDraft.protocol),
        host: normalizeHost(nextDraft.host),
        path: normalizeLinkPath(nextDraft.path),
        query: normalizeLinkQuery(nextDraft.query),
      } satisfies ProjectServiceLink);
      const nextSnapshot = await getSnapshot();
      setGraphSnapshot(nextGraph);
      setProjects(nextSnapshot.projects);
      const savedConnection = nextGraph.connections.find(
        (connection) =>
          connection.linkSource === "manual" &&
          connection.sourceProjectId === nextDraft.sourceProjectId &&
          connection.sourceEnvKey === nextDraft.sourceEnvKey,
      );
      setSelectedConnectionId(savedConnection?.id ?? null);
      setSelectedProjectId(nextDraft.sourceProjectId);
      setDraftLink(null);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "No fue posible guardar el enlace.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveLinkWithEnv() {
    if (!activeDraft) {
      return;
    }

    const envValue = envDrafts[envDraftKey(activeDraft.sourceProjectId, activeDraft.sourceEnvKey)] ?? linkSourceEnv?.value ?? "";
    const sourceEnvMeta = activeSourceGraphProject?.envVariables.find((env) => env.key === activeDraft.sourceEnvKey) ?? null;
    const currentStoredValue = linkSourceEnv?.value ?? "";

    try {
      if (envValue !== currentStoredValue || sourceEnvMeta?.source === "env_file" || sourceEnvMeta?.source === "missing") {
        await persistEnvValue(activeDraft.sourceProjectId, activeDraft.sourceEnvKey, envValue, sourceEnvMeta);
      }
      await persistLink(activeDraft);
    } catch {
      // error state already updated
    }
  }

  async function handleDeleteLink() {
    if (!selectedConnection || selectedConnection.linkSource !== "manual") {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const nextGraph = await deleteServiceLink(selectedConnection.id);
      const nextSnapshot = await getSnapshot();
      setGraphSnapshot(nextGraph);
      setProjects(nextSnapshot.projects);
      setSelectedConnectionId(null);
      setDraftLink(null);
      setSelectedProjectId(selectedConnection.sourceProjectId);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : "No fue posible eliminar el enlace.");
    } finally {
      setIsSaving(false);
    }
  }

  function handleConnect(connection: Connection) {
    if (!graphSnapshot || !connection.source || !connection.target) {
      return;
    }

    const sourceProject = graphProjectsById.get(connection.source) ?? null;
    const existingManual = graphSnapshot.connections.find(
      (entry) => entry.linkSource === "manual" && entry.sourceProjectId === connection.source && entry.targetProjectId === connection.target,
    );
    const defaultEnvKey = existingManual?.sourceEnvKey ?? pickDefaultEnvKey(sourceProject);
    const template = existingManual
      ? parseTemplateFromValue(existingManual.resolvedValue ?? existingManual.sourceValue)
      : parseTemplateFromValue(sourceProject?.envVariables.find((env) => env.key === defaultEnvKey)?.value ?? null);

    setSelectedProjectId(connection.source);
    setSelectedConnectionId(existingManual?.id ?? null);
    setDraftLink({
      id: existingManual?.id ?? createLinkId(),
      sourceProjectId: connection.source,
      sourceEnvKey: defaultEnvKey,
      targetProjectId: connection.target,
      targetEnvKey: existingManual?.targetEnvKey ?? DEFAULT_TARGET_ENV_KEY,
      protocol: existingManual?.protocol ?? template.protocol,
      host: existingManual?.host ?? template.host,
      path: existingManual?.path ?? template.path,
      query: existingManual?.query ?? template.query,
      sourceKind: existingManual ? "manual" : "new",
    });
  }

  const recentFailuresForActiveLink = activeDraft
    ? resolvedLiveTraffic.some(
        (event) =>
          event.resolvedSourceProjectId === activeDraft.sourceProjectId &&
          event.targetProjectId === activeDraft.targetProjectId &&
          !event.ok,
      )
    : false;

  return (
    <DialogShell
      open={active}
      onOpenChange={onOpenChange ?? (() => undefined)}
      title="Mapa visual de .env y tráfico entre microservicios"
      description="Nodos compactos para ver estado y puertos, con edición lateral amigable para variables y redirecciones."
      contentClassName="ui-dialog-content--topology"
      bodyClassName="ui-dialog-body--topology"
      actions={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={() => setTrafficEvents([])} disabled={!trafficEvents.length}>
            <Activity className="h-3.5 w-3.5" />
            Limpiar actividad
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void refreshSnapshot()} disabled={isLoading}>
            <RefreshCw className={["h-3.5 w-3.5", isLoading ? "animate-spin" : ""].join(" ")} />
            Refrescar
          </Button>
        </>
      }
    >
      <div className="service-topology">
        <div className="service-topology__canvas">
          {graphSnapshot ? (
            <ReactFlow
              fitView
              minZoom={0.22}
              maxZoom={1.6}
              nodeTypes={nodeTypes}
              nodes={nodes}
              edges={edges}
              onConnect={handleConnect}
              onNodeClick={(_, node) => {
                setSelectedProjectId(node.id);
                setSelectedConnectionId(null);
                setDraftLink(null);
              }}
              onPaneClick={() => setSelectedConnectionId(null)}
              onNodeDragStop={(_, node) =>
                setNodePositions((current) => ({
                  ...current,
                  [node.id]: node.position,
                }))
              }
              onEdgeClick={(_, edge) => {
                setSelectedConnectionId(edge.id);
                const connection = graphSnapshot.connections.find((entry) => entry.id === edge.id) ?? null;
                setSelectedProjectId(connection?.sourceProjectId ?? null);
                setDraftLink(null);
              }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="rgba(148, 163, 184, 0.14)" gap={24} size={1.1} />
              <MiniMap pannable zoomable className="service-topology__minimap" />
              <Controls className="service-topology__controls" />
            </ReactFlow>
          ) : (
            <div className="service-topology__emptyCanvas">
              <EmptyState
                title={isLoading ? "Cargando grafo" : "Sin datos del grafo"}
                description={isLoading ? "Leyendo proyectos, puertos, variables y enlaces." : error ?? "No hay datos suficientes para pintar el flujo."}
              />
            </div>
          )}
        </div>

        <aside className="service-topology__sidebar">
          <Card tone="accent" className="p-3.5">
            <div className="service-topology__sectionHeader">
              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Actividad reciente</p>
                <h3 className="mt-0.5 text-[12px] font-semibold text-textStrong">Pulso en tiempo real</h3>
              </div>
              <Badge
                variant={resolvedLiveTraffic.some((entry) => !entry.ok) ? "danger" : resolvedLiveTraffic.length ? "success" : "secondary"}
              >
                {resolvedLiveTraffic.length}
              </Badge>
            </div>

            <div className="service-topology__trafficList">
              {resolvedLiveTraffic.slice(-LIVE_PANEL_EVENTS).reverse().map((event) => (
                <div key={event.id} className={["service-topology__trafficItem", event.ok ? "" : "is-error"].join(" ")}>
                  <div className="service-topology__trafficRoute">
                    <span className="service-topology__trafficEndpoint" title={event.resolvedSourceLabel}>
                      {event.resolvedSourceLabel}
                    </span>
                    <ArrowRightLeft className="service-topology__trafficArrow" />
                    <span className="service-topology__trafficEndpoint is-target" title={event.resolvedTargetLabel}>
                      {event.resolvedTargetLabel}
                    </span>
                    <Badge variant={event.ok ? "success" : "danger"}>{event.statusCode ?? "ERR"}</Badge>
                  </div>
                  <p className="service-topology__trafficDetail">
                    {event.method} {event.path} {event.durationMs != null ? `· ${event.durationMs} ms` : ""}
                  </p>
                  {!event.ok && event.error ? (
                    <p className="service-topology__trafficError" title={event.error}>
                      {event.error}
                    </p>
                  ) : null}
                </div>
              ))}
              {!resolvedLiveTraffic.length ? (
                <p className="text-[11px] text-textMuted">Todavía no hay tráfico reciente para animar el flujo.</p>
              ) : null}
            </div>
          </Card>

          <Card tone={activeDraft?.sourceKind === "inferred" ? "warning" : "muted"} className="p-4">
            <div className="service-topology__sectionHeader">
              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Enlace seleccionado</p>
                <h3 className="mt-1 text-[13px] font-semibold text-textStrong">
                  {activeDraft ? "Redirección y valor actual del .env" : "Crea o selecciona un enlace"}
                </h3>
              </div>
              {activeDraft ? <Badge variant="info">{activeDraft.sourceKind === "new" ? "Nuevo" : activeDraft.sourceKind}</Badge> : null}
            </div>

            {activeDraft ? (
              <div className="mt-3 grid gap-3">
                <div className="service-topology__linkSummary">
                  <div className="service-topology__summaryRow">
                    <span className="service-topology__summaryLabel">Origen</span>
                    <span className="service-topology__summaryValue">{activeSourceGraphProject?.projectName ?? activeDraft.sourceProjectId}</span>
                  </div>
                  <div className="service-topology__summaryRow">
                    <span className="service-topology__summaryLabel">Archivo .env</span>
                    <span className="service-topology__summaryValue">{projectsById.get(activeDraft.sourceProjectId)?.selectedEnvFile ?? "Solo override"}</span>
                  </div>
                  <div className="service-topology__summaryRow">
                    <span className="service-topology__summaryLabel">Preview</span>
                    <span className="service-topology__summaryValue">
                      {describeLinkPreview(activeDraft, activeTargetGraphProject, activeDraft.targetEnvKey)}
                    </span>
                  </div>
                </div>

                <div className="service-topology__panelGrid">
                  <FieldLabelWrap>
                    <FieldLabel>Variable origen</FieldLabel>
                    <Select
                      value={activeDraft.sourceEnvKey}
                      onChange={(event) => {
                        const nextKey = event.target.value;
                        const sourceEnv = activeSourceGraphProject?.envVariables.find((env) => env.key === nextKey) ?? null;
                        const template = parseTemplateFromValue(sourceEnv?.value ?? null);
                        setDraftLink({
                          ...activeDraft,
                          sourceEnvKey: nextKey,
                          protocol: activeDraft.sourceKind === "new" ? template.protocol : activeDraft.protocol,
                          host: activeDraft.sourceKind === "new" ? template.host : activeDraft.host,
                          path: activeDraft.sourceKind === "new" ? template.path : activeDraft.path,
                          query: activeDraft.sourceKind === "new" ? template.query : activeDraft.query,
                        });
                      }}
                    >
                      {(activeSourceGraphProject?.envVariables ?? []).map((env) => (
                        <option key={env.key} value={env.key}>
                          {env.key} {env.source === "override" ? "· override" : env.source === "env_file" ? "· env" : ""}
                        </option>
                      ))}
                    </Select>
                    <FieldHint>Escoge la variable `.env` que quieres redirigir hacia otro microservicio.</FieldHint>
                  </FieldLabelWrap>

                  <FieldLabelWrap className="service-topology__panelGridWide">
                    <FieldLabel>Valor actual del .env</FieldLabel>
                    <Input
                      value={linkEnvDraftValue}
                      onChange={(event) =>
                        setEnvDrafts((current) => ({
                          ...current,
                          [envDraftKey(activeDraft.sourceProjectId, activeDraft.sourceEnvKey)]: event.target.value,
                        }))
                      }
                      placeholder="http://localhost:3000/api"
                    />
                    <FieldHint>Se guardará como override activo para el microservicio origen al guardar la redirección.</FieldHint>
                  </FieldLabelWrap>

                  <FieldLabelWrap>
                    <FieldLabel>Redirigir hacia</FieldLabel>
                    <Select
                      value={activeDraft.targetProjectId}
                      onChange={(event) => {
                        const nextTargetId = event.target.value;
                        const nextTargetProject = graphProjectsById.get(nextTargetId) ?? null;
                        const nextTargetEnvKey = buildTargetEnvOptions(nextTargetProject)[0] ?? DEFAULT_TARGET_ENV_KEY;
                        setDraftLink({
                          ...activeDraft,
                          targetProjectId: nextTargetId,
                          targetEnvKey: nextTargetEnvKey,
                        });
                      }}
                    >
                      {targetOptions.map((project) => (
                        <option key={project.projectId} value={project.projectId}>
                          {project.projectName} · {project.runtimePort ?? project.configuredPort ?? "sin puerto"} · {project.status}
                        </option>
                      ))}
                    </Select>
                  </FieldLabelWrap>

                  <FieldLabelWrap>
                    <FieldLabel>Puerto destino</FieldLabel>
                    <Select value={activeDraft.targetEnvKey} onChange={(event) => setDraftLink({ ...activeDraft, targetEnvKey: event.target.value })}>
                      {targetEnvOptions.map((envKey) => (
                        <option key={envKey} value={envKey}>
                          {envKey}
                        </option>
                      ))}
                    </Select>
                  </FieldLabelWrap>

                  <FieldLabelWrap>
                    <FieldLabel>Protocolo</FieldLabel>
                    <Select value={activeDraft.protocol} onChange={(event) => setDraftLink({ ...activeDraft, protocol: event.target.value })}>
                      <option value="http">http</option>
                      <option value="https">https</option>
                    </Select>
                  </FieldLabelWrap>

                  <FieldLabelWrap>
                    <FieldLabel>Host</FieldLabel>
                    <Input value={activeDraft.host} onChange={(event) => setDraftLink({ ...activeDraft, host: event.target.value })} />
                  </FieldLabelWrap>

                  <FieldLabelWrap className="service-topology__panelGridWide">
                    <FieldLabel>Path</FieldLabel>
                    <Input value={activeDraft.path} onChange={(event) => setDraftLink({ ...activeDraft, path: event.target.value })} placeholder="/api/v1" />
                  </FieldLabelWrap>

                  <FieldLabelWrap className="service-topology__panelGridWide">
                    <FieldLabel>Query</FieldLabel>
                    <Input value={activeDraft.query} onChange={(event) => setDraftLink({ ...activeDraft, query: event.target.value })} placeholder="?channel=local" />
                  </FieldLabelWrap>
                </div>

                {activeDraft.sourceKind === "inferred" ? (
                  <p className="text-[11px] text-warn">Este enlace fue detectado automáticamente. Al guardar, quedará persistido como conexión manual.</p>
                ) : null}

                {recentFailuresForActiveLink ? (
                  <p className="text-[11px] text-danger">Este enlace tuvo fallos recientes. La actividad reciente te muestra el error más nuevo.</p>
                ) : null}

                <div className="flex flex-wrap justify-end gap-2">
                  {selectedConnection?.linkSource === "manual" ? (
                    <Button type="button" variant="destructive" size="sm" onClick={() => void handleDeleteLink()} disabled={isSaving}>
                      <Trash2 className="h-3.5 w-3.5" />
                      Eliminar enlace
                    </Button>
                  ) : null}
                  <Button type="button" variant="default" size="sm" onClick={() => void handleSaveLinkWithEnv()} disabled={isSaving}>
                    <Save className="h-3.5 w-3.5" />
                    Guardar redirección
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <EmptyState
                  title="Selecciona un edge o arrastra entre nodos"
                  description="Conecta un microservicio con otro y termina la configuración desde este panel con selects más claros."
                />
              </div>
            )}
          </Card>

          <Card tone="muted" className="p-4">
            <div className="service-topology__sectionHeader">
              <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Servicio seleccionado</p>
                <h3 className="mt-1 text-[13px] font-semibold text-textStrong">
                  {selectedProjectGraph ? selectedProjectGraph.projectName : "Selecciona un nodo"}
                </h3>
              </div>
              {selectedProjectGraph ? <Badge variant="secondary">{selectedProjectGraph.status}</Badge> : null}
            </div>

            {selectedProjectGraph && selectedProjectFull ? (
              <div className="mt-3 grid gap-3">
                <div className="service-topology__serviceMeta">
                  <span>
                    <Cable className="h-3.5 w-3.5" />
                    puerto {selectedProjectGraph.runtimePort ?? selectedProjectGraph.configuredPort ?? "n/a"}
                  </span>
                  <span>
                    <ArrowRightLeft className="h-3.5 w-3.5" />
                    {selectedProjectFull.selectedEnvFile ?? "solo overrides"}
                  </span>
                </div>

                <div className="service-topology__envEditorList">
                  {selectedProjectGraph.envVariables.length ? (
                    selectedProjectGraph.envVariables.map((env) => {
                      const draftValue = envDrafts[envDraftKey(selectedProjectGraph.projectId, env.key)] ?? env.value;
                      return (
                        <div key={`${selectedProjectGraph.projectId}-${env.key}`} className="service-topology__envEditorItem">
                          <div className="service-topology__envEditorHeader">
                            <div>
                              <p className="service-topology__envEditorKey">{env.key}</p>
                              <p className="service-topology__envEditorMeta">
                                {env.source} {env.enabled ? "" : "· deshabilitada"} {env.isUrlLike ? "· url" : ""}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setSelectedConnectionId(null);
                                setDraftLink({
                                  id: createLinkId(),
                                  sourceProjectId: selectedProjectGraph.projectId,
                                  sourceEnvKey: env.key,
                                  targetProjectId:
                                    buildTargetOptions(graphSnapshot?.projects ?? [], selectedProjectGraph.projectId)[0]?.projectId ?? "",
                                  targetEnvKey: DEFAULT_TARGET_ENV_KEY,
                                  ...parseTemplateFromValue(draftValue),
                                  sourceKind: "new",
                                });
                              }}
                            >
                              <Network className="h-3.5 w-3.5" />
                              Usar en enlace
                            </Button>
                          </div>

                          <div className="service-topology__envEditorControls">
                            <Input
                              value={draftValue}
                              onChange={(event) =>
                                setEnvDrafts((current) => ({
                                  ...current,
                                  [envDraftKey(selectedProjectGraph.projectId, env.key)]: event.target.value,
                                }))
                              }
                              placeholder="Valor override"
                            />
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => void persistEnvValue(selectedProjectGraph.projectId, env.key, draftValue, env)}
                              disabled={isSaving}
                            >
                              Guardar
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <EmptyState
                      title="Sin variables detectadas"
                      description="Este microservicio no expone variables `.env` detectables todavía."
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-3">
                <EmptyState
                  title="Haz click en un nodo"
                  description="Desde aquí puedes ajustar valores `.env` del microservicio sin sobrecargar el nodo visual."
                />
              </div>
            )}
          </Card>

          {error ? (
            <Card tone="danger" className="p-4 text-[11px] text-danger">
              {error}
            </Card>
          ) : null}
        </aside>
      </div>
    </DialogShell>
  );
}

export function ServiceTopologyModal({ open, onOpenChange, focusProjectId }: Props) {
  return <ServiceTopologySurface active={open} onOpenChange={onOpenChange} focusProjectId={focusProjectId} shell="dialog" />;
}

export function ServiceTopologyStandaloneWindow({ focusProjectId }: StandaloneProps) {
  return <ServiceTopologySurface active focusProjectId={focusProjectId} shell="standalone" />;
}
