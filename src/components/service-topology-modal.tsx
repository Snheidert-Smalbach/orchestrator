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
  ChevronLeft,
  ChevronRight,
  Database,
  Globe,
  HardDrive,
  Layers,
  Mail,
  MessageSquare,
  Network,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Square,
  Trash2,
  Video,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteServiceLink,
  getServiceGraphSnapshot,
  getSnapshot,
  listenRuntimeEvents,
  listenServiceTrafficEvents,
  saveProject as saveProjectConfig,
  saveServiceLink,
} from "../lib/tauri";
import type {
  InfraNodeKind,
  ManualInfraNode,
  Project,
  ProjectEnvOverride,
  ProjectServiceLink,
  ServiceGraphConnection,
  ServiceGraphEnvVariable,
  ServiceGraphProject,
  ServiceGraphSnapshot,
  ServiceTrafficEvent,
  TopologySession,
} from "../lib/types";
import { useTranslation } from "../i18n";
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
  noPortLabel: string;
  clickToConfigureLabel: string;
};

type InfraNodeData = {
  kind: InfraNodeKind;
  label: string;
  isManual: boolean;
};

type DetectedInfraRef = {
  id: string;
  kind: InfraNodeKind;
  label: string;
};

type DetectedInfraEdge = {
  id: string;
  sourceProjectId: string;
  sourceEnvKey: string;
  infraNodeId: string;
  kind: InfraNodeKind;
};

type ServiceNode = Node<ServiceNodeData, "service">;
type InfraNode = Node<InfraNodeData, "infra">;

type ResolvedTrafficEvent = ServiceTrafficEvent & {
  resolvedSourceProjectId: string | null;
  resolvedSourceLabel: string;
  resolvedTargetLabel: string;
  matchedConnectionIds: string[];
};

const LIVE_WINDOW_MS = 14000;
const LIVE_PANEL_EVENTS = 4;
const TRAFFIC_FLUSH_INTERVAL_MS = 120;
const TOPOLOGY_REFRESH_DEBOUNCE_MS = 260;
const DEFAULT_LINK_HOST = "127.0.0.1";
const DEFAULT_TARGET_ENV_KEY = "PORT";
const SERVICE_TOPOLOGY_LAYOUT_STORAGE_KEY = "back-orchestrator.service-topology-layout.v1";
const TOPOLOGY_SESSIONS_STORAGE_KEY = "back-orchestrator.topology-sessions.v1";
const MANUAL_INFRA_STORAGE_KEY = "back-orchestrator.manual-infra-nodes.v1";
const NODE_WIDTH = 214;
const INFRA_NODE_WIDTH = 150;
const GRID_GAP_X = 278;
const GRID_GAP_Y = 184;
const PROJECT_COLUMNS = 4;
const MAX_SESSIONS = 20;

const INFRA_PATTERNS: { keyRegex: RegExp; kind: InfraNodeKind; label: string }[] = [
  { keyRegex: /redis/i, kind: "redis", label: "Redis" },
  { keyRegex: /mongo/i, kind: "mongodb", label: "MongoDB" },
  { keyRegex: /postgres|postgresql|pg_url|pg_dsn/i, kind: "postgres", label: "PostgreSQL" },
  { keyRegex: /mysql|mariadb/i, kind: "mysql", label: "MySQL" },
  { keyRegex: /kafka/i, kind: "kafka", label: "Kafka" },
  { keyRegex: /rabbitmq|amqp/i, kind: "rabbitmq", label: "RabbitMQ" },
  { keyRegex: /elastic/i, kind: "elasticsearch", label: "Elasticsearch" },
  { keyRegex: /s3|minio/i, kind: "s3", label: "S3 / Storage" },
  { keyRegex: /smtp|sendgrid|mailgun|mailhog/i, kind: "smtp", label: "SMTP / Mail" },
];

const DATABASE_URL_PREFIXES: { prefix: string; kind: InfraNodeKind; label: string }[] = [
  { prefix: "postgres://", kind: "postgres", label: "PostgreSQL" },
  { prefix: "postgresql://", kind: "postgres", label: "PostgreSQL" },
  { prefix: "mysql://", kind: "mysql", label: "MySQL" },
  { prefix: "mongodb://", kind: "mongodb", label: "MongoDB" },
  { prefix: "mongodb+srv://", kind: "mongodb", label: "MongoDB" },
  { prefix: "redis://", kind: "redis", label: "Redis" },
  { prefix: "rediss://", kind: "redis", label: "Redis" },
  { prefix: "amqp://", kind: "rabbitmq", label: "RabbitMQ" },
  { prefix: "amqps://", kind: "rabbitmq", label: "RabbitMQ" },
];

type InfraMeta = { bg: string; fg: string; label: string; Icon: React.ComponentType<{ className?: string }> };

const INFRA_META: Record<InfraNodeKind, InfraMeta> = {
  redis: { bg: "#DC382D", fg: "#fff", label: "Redis", Icon: Database },
  mongodb: { bg: "#10AA50", fg: "#fff", label: "MongoDB", Icon: Database },
  postgres: { bg: "#336791", fg: "#fff", label: "PostgreSQL", Icon: Database },
  mysql: { bg: "#4479A1", fg: "#fff", label: "MySQL", Icon: Database },
  kafka: { bg: "#1C1C1E", fg: "#fff", label: "Kafka", Icon: Zap },
  rabbitmq: { bg: "#FF6600", fg: "#fff", label: "RabbitMQ", Icon: MessageSquare },
  elasticsearch: { bg: "#FEC514", fg: "#231F20", label: "Elasticsearch", Icon: Search },
  s3: { bg: "#FF9900", fg: "#fff", label: "S3 / Storage", Icon: HardDrive },
  smtp: { bg: "#7B68EE", fg: "#fff", label: "SMTP / Mail", Icon: Mail },
  external: { bg: "#64748B", fg: "#fff", label: "External", Icon: Globe },
};

const ALL_INFRA_KINDS: InfraNodeKind[] = [
  "redis", "mongodb", "postgres", "mysql", "kafka", "rabbitmq", "elasticsearch", "s3", "smtp", "external",
];

// ── Utility functions ─────────────────────────────────────────────────────────

function createLinkId() {
  return `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createInfraId() {
  return `manual-infra-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createSessionId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function envDraftKey(projectId: string, envKey: string) {
  return `${projectId}::${envKey}`;
}

function normalizeLinkPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeLinkQuery(query: string) {
  const trimmed = query.trim();
  if (!trimmed) return "";
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

function buildDefaultInfraPosition(infraIndex: number, projectCount: number) {
  const canvasRows = Math.ceil(projectCount / PROJECT_COLUMNS);
  return {
    x: PROJECT_COLUMNS * GRID_GAP_X + 60,
    y: infraIndex * (GRID_GAP_Y * 0.85),
  };
}

function loadStoredNodePositions() {
  if (typeof window === "undefined") {
    return {} as Record<string, ServiceTopologyNodePosition>;
  }

  try {
    const raw = window.localStorage.getItem(SERVICE_TOPOLOGY_LAYOUT_STORAGE_KEY);
    if (!raw) return {} as Record<string, ServiceTopologyNodePosition>;

    const parsed = JSON.parse(raw) as Record<string, Partial<ServiceTopologyNodePosition>>;
    return Object.entries(parsed).reduce<Record<string, ServiceTopologyNodePosition>>((acc, [id, pos]) => {
      if (typeof pos?.x === "number" && Number.isFinite(pos.x) && typeof pos?.y === "number" && Number.isFinite(pos.y)) {
        acc[id] = { x: pos.x, y: pos.y };
      }
      return acc;
    }, {});
  } catch {
    return {} as Record<string, ServiceTopologyNodePosition>;
  }
}

function persistNodePositions(positions: Record<string, ServiceTopologyNodePosition>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SERVICE_TOPOLOGY_LAYOUT_STORAGE_KEY, JSON.stringify(positions));
}

function loadSessions(): TopologySession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(TOPOLOGY_SESSIONS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TopologySession[]) : [];
  } catch {
    return [];
  }
}

function persistSessions(sessions: TopologySession[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOPOLOGY_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
}

function loadManualInfraNodes(): ManualInfraNode[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MANUAL_INFRA_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ManualInfraNode[]) : [];
  } catch {
    return [];
  }
}

function persistManualInfraNodes(nodes: ManualInfraNode[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MANUAL_INFRA_STORAGE_KEY, JSON.stringify(nodes));
}

function parseTemplateFromValue(value: string | null | undefined) {
  if (!value?.trim()) {
    return { protocol: "http", host: DEFAULT_LINK_HOST, path: "", query: "" };
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
    return { protocol: "http", host: DEFAULT_LINK_HOST, path: "", query: "" };
  }
}

function pickDefaultEnvKey(project: ServiceGraphProject | null) {
  if (!project) return "";
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
  if (!event) return null;
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

  if (!normalizedConnectionPath || !normalizedRequestPath) return 0;
  if (normalizedRequestPath === normalizedConnectionPath) return 48;
  if (normalizedRequestPath.startsWith(`${normalizedConnectionPath}/`)) return 28;
  return 0;
}

function resolveTrafficEvent(
  event: ServiceTrafficEvent,
  connections: ServiceGraphConnection[],
  projectsById: Map<string, ServiceGraphProject>,
  externalLabel: string,
): ResolvedTrafficEvent {
  const targetConnections = connections.filter((c) => c.targetProjectId === event.targetProjectId);
  const normalizedSourceLabel = normalizeMatchText(event.sourceLabel);
  let resolvedSourceProjectId = event.sourceProjectId;

  if (!resolvedSourceProjectId && normalizedSourceLabel) {
    const labelMatches = targetConnections.filter(
      (c) => normalizeMatchText(projectsById.get(c.sourceProjectId)?.projectName) === normalizedSourceLabel,
    );
    const uniqueLabelSources = [...new Set(labelMatches.map((c) => c.sourceProjectId))];
    if (uniqueLabelSources.length === 1) {
      resolvedSourceProjectId = uniqueLabelSources[0];
    }
  }

  if (!resolvedSourceProjectId && targetConnections.length) {
    const pathMatches = targetConnections.filter((c) => scoreConnectionPathMatch(c.path, event.path) > 0);
    const uniquePathSources = [...new Set(pathMatches.map((c) => c.sourceProjectId))];
    if (uniquePathSources.length === 1) {
      resolvedSourceProjectId = uniquePathSources[0];
    } else if (uniquePathSources.length === 0) {
      const uniqueSources = [...new Set(targetConnections.map((c) => c.sourceProjectId))];
      if (uniqueSources.length === 1) {
        resolvedSourceProjectId = uniqueSources[0];
      }
    }
  }

  const scopedConnections = resolvedSourceProjectId
    ? targetConnections.filter((c) => c.sourceProjectId === resolvedSourceProjectId)
    : targetConnections;
  const pathScopedMatches = scopedConnections.filter((c) => scoreConnectionPathMatch(c.path, event.path) > 0);
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
      (resolvedSourceProjectId ? projectsById.get(resolvedSourceProjectId)?.projectName : null) ?? event.sourceLabel ?? externalLabel,
    resolvedTargetLabel: projectsById.get(event.targetProjectId)?.projectName ?? event.targetProjectId,
    matchedConnectionIds: matchedConnections.map((c) => c.id),
  };
}

function trafficTimestampValue(value: string) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildTargetOptions(projects: ServiceGraphProject[], sourceProjectId: string) {
  return projects.filter((p) => p.projectId !== sourceProjectId);
}

function buildTargetEnvOptions(targetProject: ServiceGraphProject | null) {
  if (!targetProject) return [DEFAULT_TARGET_ENV_KEY];
  const keys = targetProject.envVariables.map((env) => env.key).filter((key) => /port/i.test(key));
  return [...new Set([DEFAULT_TARGET_ENV_KEY, ...keys])];
}

function describeLinkPreview(draft: LinkDraft, targetProject: ServiceGraphProject | null, targetEnvKey: string, noPortMessage: string) {
  const targetEnv = targetProject?.envVariables.find((env) => env.key === targetEnvKey) ?? null;
  const rawPort = targetEnv?.value ?? String(targetProject?.runtimePort ?? targetProject?.configuredPort ?? "");
  const portText = rawPort.trim().replace(/[^\d].*$/, "");
  const port = portText || String(targetProject?.runtimePort ?? targetProject?.configuredPort ?? "");

  if (!port) return noPortMessage;
  return `${normalizeProtocol(draft.protocol)}://${normalizeHost(draft.host)}:${port}${normalizeLinkPath(draft.path)}${normalizeLinkQuery(draft.query)}`;
}

function buildEnvOverrideId(projectId: string, envKey: string, existingId?: string | null) {
  return existingId ?? `${projectId}-override-${envKey.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function isSecretEnvKey(envKey: string) {
  return /(secret|token|password|key)/i.test(envKey);
}

function upsertEnvOverride(project: Project, envKey: string, envValue: string, sourceEnv?: ServiceGraphEnvVariable | null) {
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

  return { ...project, envOverrides: nextOverrides } satisfies Project;
}

function detectInfraFromSnapshot(snapshot: ServiceGraphSnapshot): {
  infraNodes: DetectedInfraRef[];
  infraEdges: DetectedInfraEdge[];
} {
  const foundKinds = new Map<InfraNodeKind, DetectedInfraRef>();
  const infraEdges: DetectedInfraEdge[] = [];

  for (const project of snapshot.projects) {
    for (const env of project.envVariables) {
      if (!env.enabled) continue;

      let matched: { kind: InfraNodeKind; label: string } | null = null;

      for (const pattern of INFRA_PATTERNS) {
        if (pattern.keyRegex.test(env.key)) {
          matched = { kind: pattern.kind, label: pattern.label };
          break;
        }
      }

      if (!matched && env.value) {
        for (const entry of DATABASE_URL_PREFIXES) {
          if (env.value.startsWith(entry.prefix)) {
            matched = { kind: entry.kind, label: entry.label };
            break;
          }
        }
      }

      if (matched) {
        const infraId = `infra-auto-${matched.kind}`;
        if (!foundKinds.has(matched.kind)) {
          foundKinds.set(matched.kind, { id: infraId, kind: matched.kind, label: matched.label });
        }
        infraEdges.push({
          id: `infra-edge-${project.projectId}-${env.key}-${matched.kind}`,
          sourceProjectId: project.projectId,
          sourceEnvKey: env.key,
          infraNodeId: infraId,
          kind: matched.kind,
        });
      }
    }
  }

  return { infraNodes: Array.from(foundKinds.values()), infraEdges };
}

function formatSessionDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// ── Node components ───────────────────────────────────────────────────────────

function ServiceTopologyNode({ data }: NodeProps<ServiceNode>) {
  const runtimePort = data.project.runtimePort ?? data.project.configuredPort;
  const configuredPort = data.project.configuredPort;
  const portLabel =
    runtimePort && configuredPort && runtimePort !== configuredPort
      ? `${runtimePort} · cfg ${configuredPort}`
      : runtimePort ?? configuredPort ?? data.noPortLabel;

  return (
    <div
      title={data.lastActivityLabel ?? data.clickToConfigureLabel}
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

function InfraTopologyNode({ data }: NodeProps<InfraNode>) {
  const meta = INFRA_META[data.kind];
  const Icon = meta.Icon;

  return (
    <div className="infra-topology-node" title={data.label}>
      <Handle type="target" id="target" position={Position.Left} className="service-topology-node__target" />
      <Handle type="source" id="source" position={Position.Right} className="service-topology-node__source" />
      <div className="infra-topology-node__inner">
        <span className="infra-topology-node__icon" style={{ background: meta.bg, color: meta.fg }}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="infra-topology-node__label">{data.label}</span>
        {data.isManual ? <span className="infra-topology-node__manual" /> : null}
      </div>
    </div>
  );
}

const nodeTypes = {
  service: ServiceTopologyNode,
  infra: InfraTopologyNode,
};

// ── Main surface ──────────────────────────────────────────────────────────────

function ServiceTopologySurface({ active, onOpenChange, focusProjectId, shell }: ServiceTopologySurfaceProps) {
  const { t } = useTranslation();

  // ── Core state ────────────────────────────────────────────────────────────
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

  // ── Session state ─────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<TopologySession[]>(loadSessions);
  const [isRecording, setIsRecording] = useState(false);
  const [pendingSessionName, setPendingSessionName] = useState("");
  const [showSaveSessionDialog, setShowSaveSessionDialog] = useState(false);
  const [activeReplayId, setActiveReplayId] = useState<string | null>(null);
  const [replayMode, setReplayMode] = useState<"timeline" | "step">("timeline");
  const [replayStep, setReplayStep] = useState(0);
  const [replayTime, setReplayTime] = useState(0);

  // ── Infra / palette state ─────────────────────────────────────────────────
  const [manualInfraNodes, setManualInfraNodes] = useState<ManualInfraNode[]>(loadManualInfraNodes);
  const [showPalette, setShowPalette] = useState(false);
  const [infraVisible, setInfraVisible] = useState(true);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const selectedProjectIdRef = useRef<string | null>(focusProjectId ?? null);
  const selectedConnectionIdRef = useRef<string | null>(null);
  const pendingTrafficRef = useRef<ServiceTrafficEvent[]>([]);
  const trafficFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const topologyRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRecordingRef = useRef(false);
  const recordedEventsRef = useRef<ServiceTrafficEvent[]>([]);

  useEffect(() => { selectedProjectIdRef.current = selectedProjectId; }, [selectedProjectId]);
  useEffect(() => { selectedConnectionIdRef.current = selectedConnectionId; }, [selectedConnectionId]);

  useEffect(() => {
    if (active) setSelectedProjectId(focusProjectId ?? null);
  }, [active, focusProjectId]);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    void Promise.all([getServiceGraphSnapshot(), getSnapshot()])
      .then(([nextGraph, nextSnapshot]) => {
        if (cancelled) return;
        setGraphSnapshot(nextGraph);
        setProjects(nextSnapshot.projects);
        setTrafficEvents([]);
        setSelectedConnectionId(null);
        setDraftLink(null);
        setSelectedProjectId((current) => current ?? focusProjectId ?? nextGraph.projects[0]?.projectId ?? null);
      })
      .catch((errorValue) => {
        if (!cancelled) setError(errorValue instanceof Error ? errorValue.message : t("topology.errorLoad"));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [active, focusProjectId]);

  useEffect(() => {
    if (!active) return;

    let dispose: (() => void) | null = null;
    const flushTraffic = () => {
      trafficFlushTimerRef.current = null;
      if (!pendingTrafficRef.current.length) return;
      const batch = pendingTrafficRef.current;
      pendingTrafficRef.current = [];
      if (isRecordingRef.current) {
        recordedEventsRef.current = [...recordedEventsRef.current, ...batch];
      }
      setTrafficEvents((current) => [...current, ...batch].slice(-120));
    };

    void listenServiceTrafficEvents((payload) => {
      pendingTrafficRef.current.push(payload);
      if (trafficFlushTimerRef.current == null) {
        trafficFlushTimerRef.current = window.setTimeout(flushTraffic, TRAFFIC_FLUSH_INTERVAL_MS);
      }
    }).then((unlisten) => { dispose = unlisten; });

    return () => {
      if (trafficFlushTimerRef.current != null) {
        window.clearTimeout(trafficFlushTimerRef.current);
        trafficFlushTimerRef.current = null;
      }
      pendingTrafficRef.current = [];
      dispose?.();
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;

    let dispose: (() => void) | null = null;
    const scheduleTopologyRefresh = () => {
      if (topologyRefreshTimerRef.current != null) {
        window.clearTimeout(topologyRefreshTimerRef.current);
      }
      topologyRefreshTimerRef.current = window.setTimeout(() => {
        topologyRefreshTimerRef.current = null;
        void reloadTopologyData({
          preserveConnectionId: selectedConnectionIdRef.current,
          preserveProjectId: selectedProjectIdRef.current,
        }).catch(() => undefined);
      }, TOPOLOGY_REFRESH_DEBOUNCE_MS);
    };

    void listenRuntimeEvents(
      (payload) => {
        setProjects((current) =>
          current.map((project) =>
            project.id === payload.projectId
              ? { ...project, status: payload.status, lastExitCode: payload.exitCode }
              : project,
          ),
        );
        setGraphSnapshot((current) =>
          current
            ? {
                ...current,
                projects: current.projects.map((p) =>
                  p.projectId === payload.projectId ? { ...p, status: payload.status } : p,
                ),
              }
            : current,
        );
        scheduleTopologyRefresh();
      },
      () => undefined,
    ).then((unlisten) => { dispose = unlisten; });

    return () => {
      if (topologyRefreshTimerRef.current != null) {
        window.clearTimeout(topologyRefreshTimerRef.current);
        topologyRefreshTimerRef.current = null;
      }
      dispose?.();
    };
  }, [active]);

  useEffect(() => {
    if (shell !== "standalone" || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

    let dispose: (() => void) | null = null;
    void import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow().listen<TopologyWindowFocusPayload>("service-topology-focus-project", (event) => {
          if (event.payload.focusProjectId) setSelectedProjectId(event.payload.focusProjectId);
          setSelectedConnectionId(null);
          setDraftLink(null);
        }),
      )
      .then((unlisten) => { dispose = unlisten; })
      .catch(() => { dispose = null; });

    return () => { dispose?.(); };
  }, [shell]);

  useEffect(() => {
    if (!graphSnapshot) return;

    setNodePositions((current) => {
      const next = { ...current };
      graphSnapshot.projects.forEach((project, index) => {
        if (!next[project.projectId]) {
          next[project.projectId] = buildDefaultPosition(index);
        }
      });
      return next;
    });

    setEnvDrafts((current) => {
      const next = { ...current };
      graphSnapshot.projects.forEach((project) => {
        project.envVariables.forEach((env) => {
          const key = envDraftKey(project.projectId, env.key);
          if (!(key in next)) next[key] = env.value;
        });
      });
      return next;
    });
  }, [graphSnapshot]);

  useEffect(() => { persistNodePositions(nodePositions); }, [nodePositions]);
  useEffect(() => { persistManualInfraNodes(manualInfraNodes); }, [manualInfraNodes]);

  // ── Derived maps ──────────────────────────────────────────────────────────
  const graphProjectsById = useMemo(
    () => new Map(graphSnapshot?.projects.map((p) => [p.projectId, p]) ?? []),
    [graphSnapshot],
  );
  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  const externalLabel = t("topology.externalLabel");

  // ── Infra detection ───────────────────────────────────────────────────────
  const { infraNodes: detectedInfraNodes, infraEdges: detectedInfraEdges } = useMemo(() => {
    if (!graphSnapshot) return { infraNodes: [] as DetectedInfraRef[], infraEdges: [] as DetectedInfraEdge[] };
    return detectInfraFromSnapshot(graphSnapshot);
  }, [graphSnapshot]);

  const allInfraNodeData = useMemo(() => {
    const detected = detectedInfraNodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, isManual: false }));
    const manual = manualInfraNodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, isManual: true }));
    const byId = new Map<string, { id: string; kind: InfraNodeKind; label: string; isManual: boolean }>();
    for (const n of [...detected, ...manual]) byId.set(n.id, n);
    return Array.from(byId.values());
  }, [detectedInfraNodes, manualInfraNodes]);

  // ── Session replay ────────────────────────────────────────────────────────
  const activeReplaySession = useMemo(
    () => sessions.find((s) => s.id === activeReplayId) ?? null,
    [sessions, activeReplayId],
  );

  const replayEvents = useMemo<ServiceTrafficEvent[] | null>(() => {
    if (!activeReplaySession) return null;
    if (replayMode === "step") {
      return activeReplaySession.events.slice(0, replayStep + 1);
    }
    const firstTs = trafficTimestampValue(activeReplaySession.events[0]?.timestamp ?? "0");
    return activeReplaySession.events.filter(
      (e) => trafficTimestampValue(e.timestamp) - firstTs <= replayTime,
    );
  }, [activeReplaySession, replayMode, replayStep, replayTime]);

  // ── Live traffic (or replay override) ────────────────────────────────────
  const liveTraffic = useMemo(() => {
    if (replayEvents !== null) return replayEvents;
    const cutoff = Date.now() - LIVE_WINDOW_MS;
    return trafficEvents.filter((event) => trafficTimestampValue(event.timestamp) >= cutoff);
  }, [trafficEvents, replayEvents]);

  const resolvedLiveTraffic = useMemo<ResolvedTrafficEvent[]>(() => {
    if (!graphSnapshot) {
      return liveTraffic.map((event) => ({
        ...event,
        resolvedSourceProjectId: event.sourceProjectId,
        resolvedSourceLabel: event.sourceLabel ?? externalLabel,
        resolvedTargetLabel: event.targetProjectId,
        matchedConnectionIds: [],
      }));
    }
    return liveTraffic.map((event) =>
      resolveTrafficEvent(event, graphSnapshot.connections, graphProjectsById, externalLabel),
    );
  }, [graphProjectsById, graphSnapshot, liveTraffic, externalLabel]);

  const trafficByProject = useMemo(() => {
    const entries = new Map<string, { liveStatus: "ok" | "error" | null; lastActivityLabel: string | null }>();
    for (const event of resolvedLiveTraffic) {
      const currentTarget = entries.get(event.targetProjectId) ?? { liveStatus: null, lastActivityLabel: null };
      currentTarget.liveStatus = event.ok ? (currentTarget.liveStatus === "error" ? "error" : "ok") : "error";
      currentTarget.lastActivityLabel = formatActivityLabel(event);
      entries.set(event.targetProjectId, currentTarget);

      if (event.resolvedSourceProjectId) {
        const currentSource = entries.get(event.resolvedSourceProjectId) ?? { liveStatus: null, lastActivityLabel: null };
        if (!currentSource.lastActivityLabel) currentSource.lastActivityLabel = formatActivityLabel(event);
        currentSource.liveStatus = !event.ok ? "error" : currentSource.liveStatus ?? "ok";
        entries.set(event.resolvedSourceProjectId, currentSource);
      }
    }
    return entries;
  }, [resolvedLiveTraffic]);

  const recentMatchByConnectionId = useMemo(() => {
    const matches = new Map<string, ResolvedTrafficEvent>();
    for (let i = resolvedLiveTraffic.length - 1; i >= 0; i -= 1) {
      const event = resolvedLiveTraffic[i];
      for (const connectionId of event.matchedConnectionIds) {
        if (!matches.has(connectionId)) matches.set(connectionId, event);
      }
    }
    return matches;
  }, [resolvedLiveTraffic]);

  const noPortLabel = t("topology.noPort");
  const clickToConfigureLabel = t("topology.clickToConfigure");

  // ── Nodes ─────────────────────────────────────────────────────────────────
  const nodes = useMemo<(ServiceNode | InfraNode)[]>(() => {
    if (!graphSnapshot) return [];

    const serviceNodes: ServiceNode[] = graphSnapshot.projects.map((project, index) => {
      const traffic = trafficByProject.get(project.projectId) ?? { liveStatus: null, lastActivityLabel: null };
      return {
        id: project.projectId,
        type: "service" as const,
        position: nodePositions[project.projectId] ?? buildDefaultPosition(index),
        data: {
          project,
          focused: selectedProjectId === project.projectId,
          liveStatus: traffic.liveStatus,
          lastActivityLabel: traffic.lastActivityLabel,
          noPortLabel,
          clickToConfigureLabel,
        },
        style: { width: NODE_WIDTH },
      };
    });

    const projectCount = graphSnapshot.projects.length;
    const infraNodesRendered: InfraNode[] = allInfraNodeData.map((infra, index) => ({
      id: infra.id,
      type: "infra" as const,
      position: nodePositions[infra.id] ?? buildDefaultInfraPosition(index, projectCount),
      data: { kind: infra.kind, label: infra.label, isManual: infra.isManual },
      style: { width: INFRA_NODE_WIDTH },
    }));

    return infraVisible ? [...serviceNodes, ...infraNodesRendered] : serviceNodes;
  }, [graphSnapshot, nodePositions, selectedProjectId, trafficByProject, noPortLabel, clickToConfigureLabel, allInfraNodeData, infraVisible]);

  // ── Edges ─────────────────────────────────────────────────────────────────
  const edges = useMemo<Edge[]>(() => {
    if (!graphSnapshot) return [];

    const serviceEdges: Edge[] = graphSnapshot.connections.map((connection) => {
      const recentMatch = recentMatchByConnectionId.get(connection.id);
      const isSelected = selectedConnectionId === connection.id;
      const stroke = recentMatch
        ? recentMatch.ok ? "rgba(34, 197, 94, 0.88)" : "rgba(248, 113, 113, 0.92)"
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
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: stroke },
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

    const infraEdges: Edge[] = detectedInfraEdges.map((edge) => {
      const meta = INFRA_META[edge.kind];
      return {
        id: edge.id,
        source: edge.sourceProjectId,
        sourceHandle: "source",
        target: edge.infraNodeId,
        targetHandle: "target",
        type: "smoothstep",
        animated: false,
        interactionWidth: 20,
        zIndex: 2,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: meta.bg },
        label: edge.sourceEnvKey,
        labelStyle: { fill: "#94a3b8", fontSize: 9, fontWeight: 600 },
        labelBgStyle: { fill: "rgba(9, 17, 33, 0.85)", fillOpacity: 1, stroke: "rgba(148, 163, 184, 0.15)", strokeWidth: 1 },
        style: { stroke: meta.bg, strokeWidth: 1.6, opacity: 0.7, strokeDasharray: "5 4" },
      };
    });

    return infraVisible ? [...serviceEdges, ...infraEdges] : serviceEdges;
  }, [graphSnapshot, recentMatchByConnectionId, selectedConnectionId, detectedInfraEdges, infraVisible]);

  const selectedConnection = useMemo(
    () => graphSnapshot?.connections.find((c) => c.id === selectedConnectionId) ?? null,
    [graphSnapshot, selectedConnectionId],
  );

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

  // ── Handlers: topology ────────────────────────────────────────────────────
  async function reloadTopologyData(options?: { preserveConnectionId?: string | null; preserveProjectId?: string | null }) {
    const [nextGraph, nextSnapshot] = await Promise.all([getServiceGraphSnapshot(), getSnapshot()]);
    setGraphSnapshot(nextGraph);
    setProjects(nextSnapshot.projects);

    const nextProjectId =
      options?.preserveProjectId && nextGraph.projects.some((p) => p.projectId === options.preserveProjectId)
        ? options.preserveProjectId
        : nextGraph.projects[0]?.projectId ?? null;
    const nextConnectionId =
      options?.preserveConnectionId && nextGraph.connections.some((c) => c.id === options.preserveConnectionId)
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
      await reloadTopologyData({ preserveConnectionId: selectedConnectionId, preserveProjectId: selectedProjectId });
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : t("topology.errorRefresh"));
    } finally {
      setIsLoading(false);
    }
  }

  async function persistEnvValue(projectId: string, envKey: string, envValue: string, envMeta?: ServiceGraphEnvVariable | null) {
    const project = projectsById.get(projectId);
    if (!project) return;

    setIsSaving(true);
    setError(null);
    try {
      await saveProjectConfig(upsertEnvOverride(project, envKey, envValue, envMeta));
      await reloadTopologyData({ preserveConnectionId: selectedConnectionId, preserveProjectId: projectId });
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : t("topology.errorSaveEnv"));
      throw errorValue;
    } finally {
      setIsSaving(false);
    }
  }

  async function persistLink(nextDraft: LinkDraft) {
    if (!nextDraft.sourceProjectId || !nextDraft.sourceEnvKey || !nextDraft.targetProjectId) {
      setError(t("topology.errorSelectSource"));
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
        (c) => c.linkSource === "manual" && c.sourceProjectId === nextDraft.sourceProjectId && c.sourceEnvKey === nextDraft.sourceEnvKey,
      );
      setSelectedConnectionId(savedConnection?.id ?? null);
      setSelectedProjectId(nextDraft.sourceProjectId);
      setDraftLink(null);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : t("topology.errorSaveLink"));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveLinkWithEnv() {
    if (!activeDraft) return;
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
    if (!selectedConnection || selectedConnection.linkSource !== "manual") return;

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
      setError(errorValue instanceof Error ? errorValue.message : t("topology.errorDeleteLink"));
    } finally {
      setIsSaving(false);
    }
  }

  function handleConnect(connection: Connection) {
    if (!graphSnapshot || !connection.source || !connection.target) return;

    // Ignore connections to/from infra nodes (they can't be saved as service links)
    const isInfraSource = allInfraNodeData.some((n) => n.id === connection.source);
    const isInfraTarget = allInfraNodeData.some((n) => n.id === connection.target);
    if (isInfraSource || isInfraTarget) return;

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

  // ── Handlers: sessions ────────────────────────────────────────────────────
  function startRecording() {
    isRecordingRef.current = true;
    recordedEventsRef.current = [];
    setIsRecording(true);
    setPendingSessionName(`Session ${new Date().toLocaleTimeString()}`);
  }

  function stopRecording() {
    isRecordingRef.current = false;
    setIsRecording(false);
    setShowSaveSessionDialog(true);
  }

  function confirmSaveSession() {
    const events = recordedEventsRef.current;
    if (!events.length) {
      setShowSaveSessionDialog(false);
      return;
    }

    const firstTs = trafficTimestampValue(events[0].timestamp);
    const lastTs = trafficTimestampValue(events[events.length - 1].timestamp);

    const session: TopologySession = {
      id: createSessionId(),
      name: pendingSessionName.trim() || `Session ${new Date().toLocaleString()}`,
      createdAt: new Date().toISOString(),
      durationMs: Math.max(0, lastTs - firstTs),
      events,
    };

    const nextSessions = [...sessions, session].slice(-MAX_SESSIONS);
    setSessions(nextSessions);
    persistSessions(nextSessions);
    recordedEventsRef.current = [];
    setShowSaveSessionDialog(false);
    setShowSessionsPanel(true);
  }

  function discardRecording() {
    recordedEventsRef.current = [];
    setShowSaveSessionDialog(false);
  }

  function deleteSession(sessionId: string) {
    const nextSessions = sessions.filter((s) => s.id !== sessionId);
    setSessions(nextSessions);
    persistSessions(nextSessions);
    if (activeReplayId === sessionId) {
      setActiveReplayId(null);
    }
  }

  function startReplay(session: TopologySession) {
    setActiveReplayId(session.id);
    setReplayMode("timeline");
    setReplayStep(0);
    setReplayTime(0);
  }

  function stopReplay() {
    setActiveReplayId(null);
  }

  // ── Handlers: infra palette ───────────────────────────────────────────────
  function addManualInfraNode(kind: InfraNodeKind) {
    const meta = INFRA_META[kind];
    const projectCount = graphSnapshot?.projects.length ?? 0;
    const existingManualCount = manualInfraNodes.length;

    const newNode: ManualInfraNode = {
      id: createInfraId(),
      kind,
      label: meta.label,
      position: buildDefaultInfraPosition(detectedInfraNodes.length + existingManualCount, projectCount),
    };

    const nextNodes = [...manualInfraNodes, newNode];
    setManualInfraNodes(nextNodes);
    setShowPalette(false);
  }

  function removeManualInfraNode(nodeId: string) {
    const nextNodes = manualInfraNodes.filter((n) => n.id !== nodeId);
    setManualInfraNodes(nextNodes);
  }

  const recentFailuresForActiveLink = activeDraft
    ? resolvedLiveTraffic.some(
        (event) =>
          event.resolvedSourceProjectId === activeDraft.sourceProjectId &&
          event.targetProjectId === activeDraft.targetProjectId &&
          !event.ok,
      )
    : false;

  // ── UI: toolbar ────────────────────────────────────────────────────────────
  const actionsContent = (
    <>
      <Button
        type="button"
        variant={showPalette ? "default" : "secondary"}
        size="sm"
        onClick={() => setShowPalette((v) => !v)}
        title={t("topology.paletteTitle")}
      >
        <Layers className="h-3.5 w-3.5" />
        {t("topology.palette")}
      </Button>

      <Button
        type="button"
        variant={infraVisible ? "secondary" : "ghost"}
        size="sm"
        onClick={() => setInfraVisible((v) => !v)}
        title={infraVisible ? t("topology.infraHide") : t("topology.infraShow")}
      >
        <Database className="h-3.5 w-3.5" />
        {infraVisible ? t("topology.infraHide") : t("topology.infraShow")}
      </Button>

      <Button type="button" variant="secondary" size="sm" onClick={() => setTrafficEvents([])} disabled={!trafficEvents.length}>
        <Activity className="h-3.5 w-3.5" />
        {t("topology.clearActivity")}
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => void refreshSnapshot()} disabled={isLoading}>
        <RefreshCw className={["h-3.5 w-3.5", isLoading ? "animate-spin" : ""].join(" ")} />
        {t("topology.refresh")}
      </Button>
    </>
  );

  // ── UI: sessions card (always visible, unified) ───────────────────────────
  const sessionsCardContent = (
    <Card tone="muted" className="p-4">
      <div className="service-topology__sectionHeader">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">{t("topology.sessionsSection")}</p>
          <h3 className="mt-1 text-[13px] font-semibold text-textStrong">{t("topology.sessionsTitle")}</h3>
        </div>
        <div className="flex gap-1.5 items-center flex-shrink-0">
          {isRecording ? (
            <>
              <span className="topology-recording__dot" style={{ display: "inline-block" }} />
              <Button type="button" variant="destructive" size="sm" onClick={stopRecording}>
                <Square className="h-3 w-3" />
                {t("topology.recordStop")}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={startRecording}
              disabled={!!activeReplaySession}
            >
              <Video className="h-3 w-3" style={{ color: "rgb(248 113 113)" }} />
              {t("topology.recordStart")}
            </Button>
          )}
        </div>
      </div>

      {/* Save dialog after stopping recording */}
      {showSaveSessionDialog ? (
        <div className="topology-sessions__saveDialog">
          <p className="text-[11px] text-textSoft font-medium">{t("topology.sessionSavePrompt")}</p>
          <Input
            value={pendingSessionName}
            onChange={(e) => setPendingSessionName(e.target.value)}
            placeholder={t("topology.sessionNamePlaceholder")}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmSaveSession();
              if (e.key === "Escape") discardRecording();
            }}
          />
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={discardRecording}>
              {t("topology.sessionDiscard")}
            </Button>
            <Button type="button" variant="default" size="sm" onClick={confirmSaveSession}>
              <Save className="h-3 w-3" />
              {t("topology.sessionSave")}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Active replay controls */}
      {activeReplaySession ? (
        <div className="topology-sessions__replayBox">
          <div className="topology-sessions__replayHeader">
            <div className="min-w-0">
              <p className="text-[9px] uppercase tracking-[0.14em] text-accent font-bold mb-0.5">{t("topology.replaySection")}</p>
              <p className="text-[11px] font-semibold text-textStrong truncate" title={activeReplaySession.name}>
                {activeReplaySession.name}
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={stopReplay} title={t("topology.replayStop")}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant={replayMode === "timeline" ? "default" : "secondary"}
              onClick={() => setReplayMode("timeline")}
            >
              {t("topology.replayTimeline")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={replayMode === "step" ? "default" : "secondary"}
              onClick={() => setReplayMode("step")}
            >
              {t("topology.replayStep")}
            </Button>
          </div>

          {replayMode === "timeline" ? (
            <div className="grid gap-1.5 mt-1">
              <input
                type="range"
                min={0}
                max={activeReplaySession.durationMs || 1}
                value={replayTime}
                onChange={(e) => setReplayTime(Number(e.target.value))}
                className="topology-replay__slider"
              />
              <div className="flex justify-between text-[10px] text-textMuted">
                <span>{formatSessionDuration(replayTime)}</span>
                <span>{formatSessionDuration(activeReplaySession.durationMs)}</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 mt-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setReplayStep((s) => Math.max(0, s - 1))}
                disabled={replayStep === 0}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                {t("topology.replayPrev")}
              </Button>
              <span className="text-[11px] text-textSoft tabular-nums">
                {replayStep + 1} / {activeReplaySession.events.length}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setReplayStep((s) => Math.min(activeReplaySession.events.length - 1, s + 1))}
                disabled={replayStep >= activeReplaySession.events.length - 1}
              >
                {t("topology.replayNext")}
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {/* Sessions list */}
      <div className="mt-3 topology-sessions__list">
        {sessions.length > 0 ? (
          sessions.map((session) => (
            <div
              key={session.id}
              className={["topology-sessions__item", activeReplayId === session.id ? "is-active" : ""].join(" ")}
            >
              <div className="topology-sessions__meta">
                <span className="topology-sessions__name">{session.name}</span>
                <span className="topology-sessions__stats">
                  {session.events.length} {t("topology.sessionEvents")} · {formatSessionDuration(session.durationMs)}
                </span>
              </div>
              <div className="topology-sessions__actions">
                {activeReplayId === session.id ? (
                  <Button type="button" variant="destructive" size="sm" onClick={stopReplay} title={t("topology.replayStop")}>
                    <Square className="h-3 w-3" />
                  </Button>
                ) : (
                  <Button type="button" variant="secondary" size="sm" onClick={() => startReplay(session)} title={t("topology.replayStart")}>
                    <Play className="h-3 w-3" />
                  </Button>
                )}
                <Button type="button" variant="ghost" size="sm" onClick={() => deleteSession(session.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))
        ) : (
          !isRecording && !showSaveSessionDialog ? (
            <p className="text-[11px] text-textMuted mt-1">{t("topology.sessionsEmpty")}</p>
          ) : null
        )}
      </div>
    </Card>
  );

  // ── UI: palette panel ──────────────────────────────────────────────────────
  const palettePanelContent = showPalette ? (
    <Card tone="muted" className="p-4">
      <div className="service-topology__sectionHeader">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">{t("topology.paletteSection")}</p>
          <h3 className="mt-1 text-[13px] font-semibold text-textStrong">{t("topology.paletteTitle")}</h3>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowPalette(false)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="mt-1 text-[11px] text-textMuted">{t("topology.paletteDesc")}</p>
      <div className="topology-palette__grid mt-3">
        {ALL_INFRA_KINDS.map((kind) => {
          const meta = INFRA_META[kind];
          const Icon = meta.Icon;
          const alreadyAuto = detectedInfraNodes.some((n) => n.kind === kind);
          return (
            <button
              key={kind}
              type="button"
              className="topology-palette__item"
              onClick={() => addManualInfraNode(kind)}
              title={meta.label}
            >
              <span className="topology-palette__icon" style={{ background: meta.bg, color: meta.fg }}>
                <Icon className="h-4 w-4" />
              </span>
              <span className="topology-palette__name">{meta.label}</span>
              {alreadyAuto ? <span className="topology-palette__auto">{t("topology.paletteAuto")}</span> : null}
            </button>
          );
        })}
      </div>

      {manualInfraNodes.length > 0 ? (
        <div className="mt-3">
          <p className="text-[10px] uppercase tracking-[0.12em] text-textSoft mb-1.5">{t("topology.paletteManual")}</p>
          <div className="grid gap-1">
            {manualInfraNodes.map((node) => {
              const meta = INFRA_META[node.kind];
              const Icon = meta.Icon;
              return (
                <div key={node.id} className="topology-palette__manualItem">
                  <span className="topology-palette__icon" style={{ background: meta.bg, color: meta.fg }}>
                    <Icon className="h-3 w-3" />
                  </span>
                  <span className="text-[11px] text-textSoft flex-1">{node.label}</span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeManualInfraNode(node.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </Card>
  ) : null;

  // ── UI: recording indicator ────────────────────────────────────────────────
  const recordingIndicator = isRecording ? (
    <div className="topology-recording__indicator">
      <span className="topology-recording__dot" />
      {t("topology.recordingLive")}
    </div>
  ) : null;

  // ── UI: main body ──────────────────────────────────────────────────────────
  const topologyBody = (
    <div className="service-topology">
      <div className="service-topology__canvas">
        {recordingIndicator}
        {graphSnapshot ? (
          <ReactFlow
            fitView
            minZoom={0.22}
            maxZoom={1.6}
            onlyRenderVisibleElements
            nodeTypes={nodeTypes}
            nodes={nodes}
            edges={edges}
            onConnect={handleConnect}
            onNodeClick={(_, node) => {
              // Only select project nodes in the sidebar
              if (allInfraNodeData.some((n) => n.id === node.id)) return;
              setSelectedProjectId(node.id);
              setSelectedConnectionId(null);
              setDraftLink(null);
            }}
            onPaneClick={() => setSelectedConnectionId(null)}
            onNodeDragStop={(_, node) =>
              setNodePositions((current) => ({ ...current, [node.id]: node.position }))
            }
            onEdgeClick={(_, edge) => {
              // Only handle service->service edges
              if (detectedInfraEdges.some((e) => e.id === edge.id)) return;
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
              title={isLoading ? t("topology.loadingGraph") : t("topology.noGraphData")}
              description={isLoading ? t("topology.loadingGraphDesc") : error ?? t("topology.noGraphDataDesc")}
            />
          </div>
        )}
      </div>

      <aside className="service-topology__sidebar">
        {sessionsCardContent}
        {palettePanelContent}

        <Card tone="accent" className="p-3.5">
          <div className="service-topology__sectionHeader">
            <div>
              <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">{t("topology.activitySection")}</p>
              <h3 className="mt-0.5 text-[12px] font-semibold text-textStrong">{t("topology.activityTitle")}</h3>
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
                  <span className="service-topology__flowArrow">
                    <span className="service-topology__flowArrow__dot" />
                  </span>
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
              <p className="text-[11px] text-textMuted">{t("topology.noTraffic")}</p>
            ) : null}
          </div>
        </Card>

        <Card tone={activeDraft?.sourceKind === "inferred" ? "warning" : "muted"} className="p-4">
          <div className="service-topology__sectionHeader">
            <div>
              <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">{t("topology.linkSection")}</p>
              <h3 className="mt-1 text-[13px] font-semibold text-textStrong">
                {activeDraft ? t("topology.linkTitle") : t("topology.linkEmpty")}
              </h3>
            </div>
            {activeDraft ? (
              <Badge variant="info">
                {activeDraft.sourceKind === "new" ? t("topology.linkNew") : activeDraft.sourceKind}
              </Badge>
            ) : null}
          </div>

          {activeDraft ? (
            <div className="mt-3 grid gap-3">
              <div className="service-topology__linkSummary">
                <div className="service-topology__summaryRow">
                  <span className="service-topology__summaryLabel">{t("topology.linkSummaryOrigin")}</span>
                  <span className="service-topology__summaryValue">{activeSourceGraphProject?.projectName ?? activeDraft.sourceProjectId}</span>
                </div>
                <div className="service-topology__summaryRow">
                  <span className="service-topology__summaryLabel">{t("topology.linkSummaryEnvFile")}</span>
                  <span className="service-topology__summaryValue">
                    {projectsById.get(activeDraft.sourceProjectId)?.selectedEnvFile ?? t("topology.linkOnlyOverride")}
                  </span>
                </div>
                <div className="service-topology__summaryRow">
                  <span className="service-topology__summaryLabel">{t("topology.linkSummaryPreview")}</span>
                  <span className="service-topology__summaryValue">
                    {describeLinkPreview(activeDraft, activeTargetGraphProject, activeDraft.targetEnvKey, t("topology.noPortResolvable"))}
                  </span>
                </div>
              </div>

              <div className="service-topology__panelGrid">
                <FieldLabelWrap>
                  <FieldLabel>{t("topology.linkSourceVarLabel")}</FieldLabel>
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
                  <FieldHint>{t("topology.linkSourceVarHint")}</FieldHint>
                </FieldLabelWrap>

                <FieldLabelWrap className="service-topology__panelGridWide">
                  <FieldLabel>{t("topology.linkCurrentValue")}</FieldLabel>
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
                  <FieldHint>{t("topology.linkCurrentValueHint")}</FieldHint>
                </FieldLabelWrap>

                <FieldLabelWrap>
                  <FieldLabel>{t("topology.linkRedirectTo")}</FieldLabel>
                  <Select
                    value={activeDraft.targetProjectId}
                    onChange={(event) => {
                      const nextTargetId = event.target.value;
                      const nextTargetProject = graphProjectsById.get(nextTargetId) ?? null;
                      const nextTargetEnvKey = buildTargetEnvOptions(nextTargetProject)[0] ?? DEFAULT_TARGET_ENV_KEY;
                      setDraftLink({ ...activeDraft, targetProjectId: nextTargetId, targetEnvKey: nextTargetEnvKey });
                    }}
                  >
                    {targetOptions.map((project) => (
                      <option key={project.projectId} value={project.projectId}>
                        {project.projectName} · {project.runtimePort ?? project.configuredPort ?? t("topology.noPort")} · {project.status}
                      </option>
                    ))}
                  </Select>
                </FieldLabelWrap>

                <FieldLabelWrap>
                  <FieldLabel>{t("topology.linkTargetPort")}</FieldLabel>
                  <Select value={activeDraft.targetEnvKey} onChange={(event) => setDraftLink({ ...activeDraft, targetEnvKey: event.target.value })}>
                    {targetEnvOptions.map((envKey) => (
                      <option key={envKey} value={envKey}>{envKey}</option>
                    ))}
                  </Select>
                </FieldLabelWrap>

                <FieldLabelWrap>
                  <FieldLabel>{t("topology.linkProtocol")}</FieldLabel>
                  <Select value={activeDraft.protocol} onChange={(event) => setDraftLink({ ...activeDraft, protocol: event.target.value })}>
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </Select>
                </FieldLabelWrap>

                <FieldLabelWrap>
                  <FieldLabel>{t("topology.linkHost")}</FieldLabel>
                  <Input value={activeDraft.host} onChange={(event) => setDraftLink({ ...activeDraft, host: event.target.value })} />
                </FieldLabelWrap>

                <FieldLabelWrap className="service-topology__panelGridWide">
                  <FieldLabel>{t("topology.linkPath")}</FieldLabel>
                  <Input value={activeDraft.path} onChange={(event) => setDraftLink({ ...activeDraft, path: event.target.value })} placeholder="/api/v1" />
                </FieldLabelWrap>

                <FieldLabelWrap className="service-topology__panelGridWide">
                  <FieldLabel>{t("topology.linkQuery")}</FieldLabel>
                  <Input value={activeDraft.query} onChange={(event) => setDraftLink({ ...activeDraft, query: event.target.value })} placeholder="?channel=local" />
                </FieldLabelWrap>
              </div>

              {activeDraft.sourceKind === "inferred" ? (
                <p className="text-[11px] text-warn">{t("topology.linkInferred")}</p>
              ) : null}

              {recentFailuresForActiveLink ? (
                <p className="text-[11px] text-danger">{t("topology.linkRecentFailures")}</p>
              ) : null}

              <div className="flex flex-wrap justify-end gap-2">
                {selectedConnection?.linkSource === "manual" ? (
                  <Button type="button" variant="destructive" size="sm" onClick={() => void handleDeleteLink()} disabled={isSaving}>
                    <Trash2 className="h-3.5 w-3.5" />
                    {t("topology.linkDeleteBtn")}
                  </Button>
                ) : null}
                <Button type="button" variant="default" size="sm" onClick={() => void handleSaveLinkWithEnv()} disabled={isSaving}>
                  <Save className="h-3.5 w-3.5" />
                  {t("topology.linkSaveBtn")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <EmptyState
                title={t("topology.linkSelectEdge")}
                description={t("topology.linkSelectEdgeDesc")}
              />
            </div>
          )}
        </Card>

        <Card tone="muted" className="p-4">
          <div className="service-topology__sectionHeader">
            <div>
              <p className="text-[10px] uppercase tracking-[0.16em] text-textSoft">{t("topology.serviceSection")}</p>
              <h3 className="mt-1 text-[13px] font-semibold text-textStrong">
                {selectedProjectGraph ? selectedProjectGraph.projectName : t("topology.serviceSelectNode")}
              </h3>
            </div>
            {selectedProjectGraph ? <Badge variant="secondary">{selectedProjectGraph.status}</Badge> : null}
          </div>

          {selectedProjectGraph && selectedProjectFull ? (
            <div className="mt-3 grid gap-3">
              <div className="service-topology__serviceMeta">
                <span>
                  <Cable className="h-3.5 w-3.5" />
                  {t("topology.servicePort", { port: String(selectedProjectGraph.runtimePort ?? selectedProjectGraph.configuredPort ?? "n/a") })}
                </span>
                <span>
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  {selectedProjectFull.selectedEnvFile ?? t("topology.serviceOnlyOverrides")}
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
                              {env.source}
                              {!env.enabled ? ` ${t("topology.serviceEnvDisabled")}` : ""}
                              {env.isUrlLike ? ` ${t("topology.serviceEnvUrl")}` : ""}
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
                            {t("topology.serviceUseInLink")}
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
                            placeholder={t("topology.serviceEnvPlaceholder")}
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => void persistEnvValue(selectedProjectGraph.projectId, env.key, draftValue, env)}
                            disabled={isSaving}
                          >
                            {t("topology.serviceSave")}
                          </Button>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <EmptyState
                    title={t("topology.serviceNoVars")}
                    description={t("topology.serviceNoVarsDesc")}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <EmptyState
                title={t("topology.serviceClickNode")}
                description={t("topology.serviceClickNodeDesc")}
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
  );

  if (shell === "standalone") {
    return (
      <div className="service-topology-window">
        <div className="service-topology-window__header">
          <div>
            <h1 className="service-topology-window__title">{t("topology.title")}</h1>
            <p className="service-topology-window__desc">{t("topology.description")}</p>
          </div>
          <div className="service-topology-window__actions">{actionsContent}</div>
        </div>
        <div className="service-topology-window__body">{topologyBody}</div>
      </div>
    );
  }

  return (
    <DialogShell
      open={active}
      onOpenChange={onOpenChange ?? (() => undefined)}
      title={t("topology.title")}
      description={t("topology.description")}
      contentClassName="ui-dialog-content--topology"
      bodyClassName="ui-dialog-body--topology"
      actions={actionsContent}
    >
      {topologyBody}
    </DialogShell>
  );
}

export function ServiceTopologyModal({ open, onOpenChange, focusProjectId }: Props) {
  return <ServiceTopologySurface active={open} onOpenChange={onOpenChange} focusProjectId={focusProjectId} shell="dialog" />;
}

export function ServiceTopologyStandaloneWindow({ focusProjectId }: StandaloneProps) {
  return <ServiceTopologySurface active focusProjectId={focusProjectId} shell="standalone" />;
}
