import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DetectedProject,
  LogPayload,
  ProjectMock,
  ProjectMockCollection,
  ProjectMockSummary,
  ProjectMockSummaryPayload,
  ProjectServiceLink,
  ProcessDiagnostic,
  Preset,
  ProjectResourceUsage,
  ProjectOrderUpdate,
  RuntimeStatusPayload,
  ServiceGraphConnection,
  ServiceGraphEnvVariable,
  ServiceGraphProject,
  ServiceGraphSnapshot,
  ServiceTrafficEvent,
  Project,
  Snapshot,
  SystemDiagnostics,
} from "./types";

const STORAGE_KEY = "back-orchestrator.mock.snapshot";
const MOCK_STORAGE_PREFIX = "back-orchestrator.mock.registry.";
const SERVICE_LINK_STORAGE_KEY = "back-orchestrator.service-links";
const SERVICE_TOPOLOGY_WINDOW_LABEL = "service-topology-window";

const statusListeners = new Set<(payload: RuntimeStatusPayload) => void>();
const logListeners = new Set<(payload: LogPayload) => void>();
const mockSummaryListeners = new Set<(payload: ProjectMockSummaryPayload) => void>();
const trafficListeners = new Set<(payload: ServiceTrafficEvent) => void>();

function detectClientOs() {
  if (typeof navigator === "undefined") {
    return "windows" as const;
  }

  return navigator.platform.toLowerCase().includes("win") ? ("windows" as const) : ("unix" as const);
}

const CLIENT_OS = detectClientOs();
const DEFAULT_ROOT = CLIENT_OS === "windows" ? "C:\\workspace\\apps\\BACK" : "/workspace/apps/BACK";
const DEFAULT_SHELL = CLIENT_OS === "windows" ? "cmd" : "sh";
const DEFAULT_NODE_PROCESS_NAME = CLIENT_OS === "windows" ? "node.exe" : "node";

function normalizePath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function normalizePathForComparison(path: string) {
  return normalizePath(path).toLowerCase();
}

function joinPath(base: string, leaf: string) {
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${leaf}`;
}

function dirname(path: string) {
  const usesBackslash = path.includes("\\") && !path.includes("/");
  const normalized = normalizePath(path).replace(/\/+$/, "");
  const lastSeparator = normalized.lastIndexOf("/");
  if (lastSeparator <= 0) {
    return null;
  }

  const parent = normalized.slice(0, lastSeparator);
  return usesBackslash ? parent.replace(/\//g, "\\") : parent;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildServiceTopologyWindowUrl(focusProjectId?: string | null) {
  const params = new URLSearchParams({ topology: "1" });
  if (focusProjectId) {
    params.set("focusProjectId", focusProjectId);
  }
  return `/?${params.toString()}`;
}

function compareProjects(left: Project, right: Project) {
  return (
    (left.catalogOrder ?? Number.MAX_SAFE_INTEGER) - (right.catalogOrder ?? Number.MAX_SAFE_INTEGER) ||
    left.startupPhase - right.startupPhase ||
    left.name.localeCompare(right.name)
  );
}

function normalizeProject(project: Project, index: number): Project {
  return {
    ...project,
    catalogOrder: project.catalogOrder && project.catalogOrder > 0 ? project.catalogOrder : index + 1,
    waitForPreviousReady: project.waitForPreviousReady ?? false,
    launchMode: project.launchMode ?? "service",
    mockMatchMode: project.mockMatchMode ?? "auto",
    mockUnmatchedStatus: project.mockUnmatchedStatus ?? 404,
    mockSummary: project.mockSummary ?? emptyMockSummary(),
  };
}

function normalizeSnapshot(snapshot: Snapshot): Snapshot {
  const normalizedProjects = snapshot.projects
    .map((project, index) => normalizeProject(project, index))
    .sort(compareProjects)
    .map((project, index) => ({
      ...project,
      catalogOrder: index + 1,
    }));

  return {
    ...snapshot,
    projects: normalizedProjects.map((project) => ({
      ...project,
      mockSummary: readMockSummary(project.id),
    })),
  };
}

function emptyMockSummary(): ProjectMockSummary {
  return {
    totalCount: 0,
    graphqlCount: 0,
    restCount: 0,
    manualCount: 0,
    capturedCount: 0,
    lastUpdatedAt: null,
    routes: [],
  };
}

function mockStorageKey(projectId: string) {
  return `${MOCK_STORAGE_PREFIX}${projectId}`;
}

function normalizeProjectMock(mock: ProjectMock, index: number): ProjectMock {
  return {
    ...mock,
    id: mock.id || createId(`mock-${index}`),
    name: mock.name?.trim() ? mock.name : `${mock.requestMethod || "GET"} ${mock.requestPath || "/"}`,
    source: mock.source ?? "captured",
    kind: mock.kind ?? "rest",
    recordedAt: mock.recordedAt || new Date().toISOString(),
    notes: mock.notes ?? null,
    requestMethod: (mock.requestMethod || "GET").toUpperCase(),
    requestPath: mock.requestPath?.trim() || "/",
    requestQuery: mock.requestQuery ?? "",
    requestHeaders: mock.requestHeaders ?? [],
    requestContentType: mock.requestContentType ?? null,
    requestBody: mock.requestBody ?? "",
    responseStatusCode: Number(mock.responseStatusCode || 200),
    responseReasonPhrase: mock.responseReasonPhrase ?? "OK",
    responseHeaders: mock.responseHeaders ?? [],
    responseContentType: mock.responseContentType ?? null,
    responseBody: mock.responseBody ?? "",
  };
}

function compareMockEntries(left: ProjectMock, right: ProjectMock) {
  return (
    new Date(right.recordedAt).getTime() - new Date(left.recordedAt).getTime() ||
    left.requestPath.localeCompare(right.requestPath) ||
    left.name.localeCompare(right.name)
  );
}

function buildMockSummary(mocks: ProjectMock[]): ProjectMockSummary {
  const routes = [...new Set(mocks.map((mock) => mock.requestPath).filter(Boolean))].slice(0, 4);
  const sortedByDate = [...mocks].sort(compareMockEntries);

  return {
    totalCount: mocks.length,
    graphqlCount: mocks.filter((mock) => mock.kind === "graphql").length,
    restCount: mocks.filter((mock) => mock.kind === "rest" || mock.kind === "http_other").length,
    manualCount: mocks.filter((mock) => mock.source === "manual").length,
    capturedCount: mocks.filter((mock) => mock.source !== "manual").length,
    lastUpdatedAt: sortedByDate[0]?.recordedAt ?? null,
    routes,
  };
}

function normalizeMockCollection(collection: ProjectMockCollection): ProjectMockCollection {
  const mocks = (collection.mocks ?? []).map(normalizeProjectMock).sort(compareMockEntries);
  return {
    summary: buildMockSummary(mocks),
    mocks,
  };
}

function readMockRegistry(projectId: string): ProjectMockCollection {
  const raw = window.localStorage.getItem(mockStorageKey(projectId));
  if (!raw) {
    return {
      summary: emptyMockSummary(),
      mocks: [],
    };
  }

  const parsed = JSON.parse(raw) as ProjectMock[] | ProjectMockCollection;
  if (Array.isArray(parsed)) {
    const mocks = parsed.map(normalizeProjectMock).sort(compareMockEntries);
    return {
      summary: buildMockSummary(mocks),
      mocks,
    };
  }

  return normalizeMockCollection(parsed);
}

function saveMockRegistry(projectId: string, collection: ProjectMockCollection) {
  const normalized = normalizeMockCollection(collection);
  window.localStorage.setItem(mockStorageKey(projectId), JSON.stringify(normalized));
  return normalized;
}

function readMockSummary(projectId: string) {
  if (typeof window === "undefined") {
    return emptyMockSummary();
  }

  return readMockRegistry(projectId).summary;
}

function buildDetectedSeed(options: {
  name: string;
  packageManager: DetectedProject["packageManager"];
  runtimeKind: DetectedProject["runtimeKind"];
  scripts: string[];
  runTarget: string;
  port: number | null;
  hasDockerCompose?: boolean;
  envFiles?: string[];
}) {
  const rootPath = joinPath(DEFAULT_ROOT, options.name);
  const envFiles = options.envFiles ?? [joinPath(rootPath, ".env")];

  return {
    name: options.name,
    rootPath,
    runtimeKind: options.runtimeKind,
    packageManager: options.packageManager,
    envFiles,
    availableScripts: options.scripts,
    suggestedRunMode: "script",
    suggestedRunTarget: options.runTarget,
    suggestedEnvFile: envFiles[0] ?? null,
    suggestedPort: options.port,
    hasDockerCompose: options.hasDockerCompose ?? false,
    alreadyImported: false,
  } satisfies DetectedProject;
}

const detectedSeed: DetectedProject[] = [
  buildDetectedSeed({
    name: "sample_api_core",
    packageManager: "npm",
    runtimeKind: "node",
    scripts: ["start", "start:dev", "start:localenv", "build", "test"],
    runTarget: "start:localenv",
    port: 3032,
  }),
  buildDetectedSeed({
    name: "sample_api_auth",
    packageManager: "pnpm",
    runtimeKind: "node",
    scripts: ["start", "start:dev", "start:local", "start:localenv", "seed"],
    runTarget: "start:local",
    port: 3001,
  }),
  buildDetectedSeed({
    name: "sample_api_catalog",
    packageManager: "pnpm",
    runtimeKind: "node",
    scripts: ["start", "start:dev", "start:local", "start:localenv", "seed"],
    runTarget: "start:local",
    port: 3002,
  }),
  buildDetectedSeed({
    name: "sample_api_pages",
    packageManager: "npm",
    runtimeKind: "node",
    scripts: ["start", "start:dev", "start:localenv", "build", "test"],
    runTarget: "start:localenv",
    port: 3100,
    envFiles: [
      joinPath(joinPath(DEFAULT_ROOT, "sample_api_pages"), ".env"),
      joinPath(joinPath(DEFAULT_ROOT, "sample_api_pages"), ".env.example"),
    ],
  }),
  buildDetectedSeed({
    name: "sample_gateway_stack",
    packageManager: "npm",
    runtimeKind: "docker_compose",
    scripts: ["start", "start:dev", "start:local", "start:localenv", "seed"],
    runTarget: "start:localenv",
    port: null,
    hasDockerCompose: true,
  }),
];

function toProject(detected: DetectedProject): Project {
  return {
    id: createId("project"),
    name: detected.name,
    rootPath: detected.rootPath,
    runtimeKind: detected.runtimeKind,
    packageManager: detected.packageManager,
    runMode: detected.suggestedRunMode,
    runTarget: detected.suggestedRunTarget,
    shell: DEFAULT_SHELL,
    selectedEnvFile: detected.suggestedEnvFile,
    availableEnvFiles: detected.envFiles,
    availableScripts: detected.availableScripts,
    port: detected.suggestedPort,
    readinessMode: detected.suggestedPort ? "port" : "none",
    readinessValue: detected.suggestedPort ? String(detected.suggestedPort) : null,
    launchMode: "service",
    mockMatchMode: "auto",
    mockUnmatchedStatus: 404,
    startupPhase: 1,
    catalogOrder: 0,
    waitForPreviousReady: false,
    enabled: true,
    tags: [],
    mockSummary: emptyMockSummary(),
    envOverrides: [],
    dependencies: [],
    status: "idle",
    lastExitCode: null,
  };
}

function createSystemPreset(projects: Project[]): Preset {
  return {
    id: "all-enabled",
    name: "Todos",
    description: "Ejecuta todos los proyectos habilitados.",
    sortOrder: 0,
    readOnly: true,
    projectIds: projects.filter((project) => project.enabled).map((project) => project.id),
  };
}

function loadMockSnapshot(): Snapshot {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw) {
    return normalizeSnapshot(JSON.parse(raw) as Snapshot);
  }

  const snapshot: Snapshot = {
    settings: {
      defaultRoots: [DEFAULT_ROOT],
    },
    projects: [],
    presets: [],
  };

  const normalizedSnapshot = normalizeSnapshot(snapshot);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizedSnapshot));
  return normalizedSnapshot;
}

function saveMockSnapshot(snapshot: Snapshot) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSnapshot(snapshot)));
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
  return host.trim() || "127.0.0.1";
}

function buildDisplayValue(value: string, isSecret: boolean) {
  if (!isSecret || !value.trim()) {
    return value;
  }

  const visibleTail = value.slice(-4);
  return visibleTail ? `********${visibleTail}` : "********";
}

function isUrlLike(value: string) {
  const trimmed = value.trim();
  return (
    trimmed.includes("://") ||
    trimmed.startsWith("localhost:") ||
    trimmed.startsWith("127.0.0.1:") ||
    trimmed.startsWith("[::1]:")
  );
}

function readMockServiceLinks() {
  if (typeof window === "undefined") {
    return [] as ProjectServiceLink[];
  }

  try {
    const raw = window.localStorage.getItem(SERVICE_LINK_STORAGE_KEY);
    if (!raw) {
      return [] as ProjectServiceLink[];
    }

    return (JSON.parse(raw) as ProjectServiceLink[]).filter((entry) =>
      entry.id && entry.sourceProjectId && entry.sourceEnvKey && entry.targetProjectId,
    );
  } catch {
    return [] as ProjectServiceLink[];
  }
}

function saveMockServiceLinks(links: ProjectServiceLink[]) {
  window.localStorage.setItem(SERVICE_LINK_STORAGE_KEY, JSON.stringify(links));
  return links;
}

function buildMockProjectEnvVariables(project: Project, links: ProjectServiceLink[]) {
  const variables = new Map<string, ServiceGraphEnvVariable>();

  for (const override of project.envOverrides) {
    variables.set(override.key, {
      key: override.key,
      value: override.value,
      displayValue: buildDisplayValue(override.value, override.isSecret),
      source: "override",
      enabled: override.enabled,
      isSecret: override.isSecret,
      isUrlLike: isUrlLike(override.value),
    });
  }

  for (const link of links.filter((entry) => entry.sourceProjectId === project.id)) {
    if (!variables.has(link.sourceEnvKey)) {
      variables.set(link.sourceEnvKey, {
        key: link.sourceEnvKey,
        value: "",
        displayValue: "Configurar desde el mapa",
        source: "missing",
        enabled: true,
        isSecret: /(secret|token|password|key)/i.test(link.sourceEnvKey),
        isUrlLike: false,
      });
    }
  }

  return [...variables.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function buildMockServiceGraphSnapshot(): ServiceGraphSnapshot {
  const snapshot = mergePresetIds(loadMockSnapshot());
  const links = readMockServiceLinks();
  const projectsById = new Map(snapshot.projects.map((project) => [project.id, project]));

  const projects: ServiceGraphProject[] = snapshot.projects.map((project) => ({
    projectId: project.id,
    projectName: project.name,
    status: project.status,
    launchMode: project.launchMode,
    configuredPort: project.port,
    runtimePort: project.port,
    envVariables: buildMockProjectEnvVariables(project, links),
  }));

  const connections: ServiceGraphConnection[] = links
    .map((link) => {
      const sourceProject = projectsById.get(link.sourceProjectId) ?? null;
      const targetProject = projectsById.get(link.targetProjectId) ?? null;
      const sourceValue =
        sourceProject?.envOverrides.find((entry) => entry.key === link.sourceEnvKey)?.value ?? null;
      const resolvedValue = targetProject?.port
        ? `${normalizeProtocol(link.protocol)}://${normalizeHost(link.host)}:${targetProject.port}${normalizeLinkPath(link.path)}${normalizeLinkQuery(link.query)}`
        : null;

      return {
        ...link,
        protocol: normalizeProtocol(link.protocol),
        host: normalizeHost(link.host),
        path: normalizeLinkPath(link.path),
        query: normalizeLinkQuery(link.query),
        resolvedValue,
        sourceValue,
        linkSource: "manual",
      } satisfies ServiceGraphConnection;
    })
    .sort((left, right) =>
      left.sourceProjectId.localeCompare(right.sourceProjectId) ||
      left.sourceEnvKey.localeCompare(right.sourceEnvKey) ||
      left.targetProjectId.localeCompare(right.targetProjectId),
    );

  return {
    projects,
    connections,
  };
}

function emitStatus(payload: RuntimeStatusPayload) {
  for (const listener of statusListeners) {
    listener(payload);
  }
}

function emitLog(payload: LogPayload) {
  for (const listener of logListeners) {
    listener(payload);
  }
}

function emitProjectMockSummary(payload: ProjectMockSummaryPayload) {
  for (const listener of mockSummaryListeners) {
    listener(payload);
  }
}

function emitTraffic(payload: ServiceTrafficEvent) {
  for (const listener of trafficListeners) {
    listener(payload);
  }
}

function mergePresetIds(snapshot: Snapshot) {
  const availableProjectIds = new Set(snapshot.projects.map((project) => project.id));
  const userPresets = snapshot.presets
    .filter((preset) => preset.id !== "all-enabled")
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name))
    .map((preset, index) => ({
      ...preset,
      sortOrder: preset.sortOrder > 0 ? preset.sortOrder : index + 1,
      readOnly: false,
      projectIds: preset.projectIds.filter((projectId) => availableProjectIds.has(projectId)),
    }));

  return {
    ...snapshot,
    presets: [createSystemPreset(snapshot.projects), ...userPresets],
  };
}

export async function getSnapshot() {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("get_snapshot");
  }

  return mergePresetIds(loadMockSnapshot());
}

export async function getServiceGraphSnapshot() {
  if (isTauriRuntime()) {
    return invoke<ServiceGraphSnapshot>("get_service_graph_snapshot");
  }

  return buildMockServiceGraphSnapshot();
}

export async function saveServiceLink(link: ProjectServiceLink) {
  if (isTauriRuntime()) {
    return invoke<ServiceGraphSnapshot>("save_service_link", { link });
  }

  const current = readMockServiceLinks().filter(
    (entry) => !(entry.sourceProjectId === link.sourceProjectId && entry.sourceEnvKey === link.sourceEnvKey && entry.id !== link.id),
  );
  const next = current.some((entry) => entry.id === link.id)
    ? current.map((entry) => (entry.id === link.id ? link : entry))
    : [...current, link];
  saveMockServiceLinks(next);
  return buildMockServiceGraphSnapshot();
}

export async function deleteServiceLink(linkId: string) {
  if (isTauriRuntime()) {
    return invoke<ServiceGraphSnapshot>("delete_service_link", { linkId });
  }

  saveMockServiceLinks(readMockServiceLinks().filter((entry) => entry.id !== linkId));
  return buildMockServiceGraphSnapshot();
}

export async function getRuntimeDiagnostics() {
  if (isTauriRuntime()) {
    return invoke<SystemDiagnostics>("get_runtime_diagnostics");
  }

  const snapshot = mergePresetIds(loadMockSnapshot());
  const activeProjects = snapshot.projects.filter((project) =>
    project.status === "starting" || project.status === "running" || project.status === "ready",
  );

  const projectResources = activeProjects.map((project, index) => {
    const memory = 140 + index * 35;
    return {
      projectId: project.id,
      projectName: project.name,
      trackedPid: 4200 + index,
      totalProcesses: 1,
      totalNodeProcesses: 1,
      totalWorkingSetMb: memory,
      totalNodeWorkingSetMb: memory,
      commandPreview: `${project.packageManager} run ${project.runTarget}`,
    } satisfies ProjectResourceUsage;
  });

  const topNodeProcesses = projectResources.map((resource, index) => ({
    projectId: resource.projectId,
    pid: resource.trackedPid ?? 4200 + index,
    parentPid: null,
    name: DEFAULT_NODE_PROCESS_NAME,
    command: resource.commandPreview ?? "node",
    workingSetMb: resource.totalNodeWorkingSetMb,
  })) satisfies ProcessDiagnostic[];

  const totalNodeWorkingSetMb = topNodeProcesses.reduce((sum, entry) => sum + entry.workingSetMb, 0);

  return {
    collectedAt: new Date().toISOString(),
    totalNodeProcesses: topNodeProcesses.length,
    totalNodeWorkingSetMb,
    totalPhysicalMemoryMb: 16384,
    freePhysicalMemoryMb: Math.max(2048, 16384 - totalNodeWorkingSetMb * 2),
    projectResources,
    topNodeProcesses,
    untrackedNodeProcesses: [],
  } satisfies SystemDiagnostics;
}

function isPathWithinScanRoot(projectRootPath: string, rootPath: string, recursive: boolean) {
  const normalizedProject = normalizePathForComparison(projectRootPath);
  const normalizedRoot = normalizePathForComparison(rootPath).replace(/\/+$/, "");

  if (normalizedProject === normalizedRoot) {
    return true;
  }

  const prefix = `${normalizedRoot}/`;
  if (!normalizedProject.startsWith(prefix)) {
    return false;
  }

  const relative = normalizedProject.slice(prefix.length);
  const segments = relative.split("/").filter(Boolean);
  return recursive ? segments.length <= 3 : segments.length === 1;
}

export async function scanRoot(rootPath: string, recursive: boolean) {
  if (isTauriRuntime()) {
    return invoke<DetectedProject[]>("scan_root", { rootPath, recursive });
  }

  const snapshot = loadMockSnapshot();
  const importedRoots = new Set(snapshot.projects.map((project) => normalizePathForComparison(project.rootPath)));

  return detectedSeed
    .filter((project) => isPathWithinScanRoot(project.rootPath, rootPath, recursive))
    .map((project) => ({
      ...project,
      alreadyImported: importedRoots.has(normalizePathForComparison(project.rootPath)),
    }));
}

export async function inspectProject(rootPath: string, preferredEnvFile?: string | null) {
  if (isTauriRuntime()) {
    return invoke<DetectedProject>("inspect_project", {
      rootPath,
      preferredEnvFile: preferredEnvFile ?? null,
    });
  }

  const detected = detectedSeed.find((project) => normalizePathForComparison(project.rootPath) === normalizePathForComparison(rootPath));
  if (!detected) {
    throw new Error(`No se encontro metadata para ${rootPath}`);
  }

  const selectedEnvFile = preferredEnvFile
    ? detected.envFiles.find((entry) => entry.toLowerCase() === preferredEnvFile.toLowerCase()) ?? null
    : detected.suggestedEnvFile;

  return {
    ...detected,
    suggestedEnvFile: selectedEnvFile,
    alreadyImported: true,
  } satisfies DetectedProject;
}

export async function importDetectedProjects(
  rootPath: string,
  recursive: boolean,
  selectedRootPaths?: string[],
) {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("import_detected_projects", {
      rootPath,
      recursive,
      selectedRootPaths,
    });
  }

  const detected = await scanRoot(rootPath, recursive);
  const snapshot = loadMockSnapshot();
  const existingRoots = new Set(snapshot.projects.map((project) => normalizePathForComparison(project.rootPath)));
  const allowedRoots = selectedRootPaths?.length ? new Set(selectedRootPaths.map((root) => normalizePathForComparison(root))) : null;
  const newProjects = detected
    .filter((project) => !existingRoots.has(normalizePathForComparison(project.rootPath)))
    .filter((project) => !allowedRoots || allowedRoots.has(normalizePathForComparison(project.rootPath)))
    .map(toProject);

  const next = mergePresetIds({
    ...snapshot,
    settings: {
      defaultRoots: [rootPath],
    },
    projects: [...snapshot.projects, ...newProjects].map((project, index) => ({
      ...project,
      catalogOrder: project.catalogOrder > 0 ? project.catalogOrder : index + 1,
    })),
  });

  const normalizedNext = normalizeSnapshot(next);
  saveMockSnapshot(normalizedNext);
  return normalizedNext;
}

export async function importSingleProject(rootPath: string, preferredEnvFile?: string | null) {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("import_single_project", {
      rootPath,
      preferredEnvFile: preferredEnvFile ?? null,
    });
  }

  const detected = await inspectProject(rootPath, preferredEnvFile);
  const snapshot = loadMockSnapshot();
  if (snapshot.projects.some((project) => normalizePathForComparison(project.rootPath) === normalizePathForComparison(detected.rootPath))) {
    return mergePresetIds(snapshot);
  }

  const next = mergePresetIds({
    ...snapshot,
    settings: {
      defaultRoots: [dirname(rootPath) ?? DEFAULT_ROOT],
    },
    projects: [...snapshot.projects, toProject(detected)].map((project, index) => ({
      ...project,
      catalogOrder: project.catalogOrder > 0 ? project.catalogOrder : index + 1,
    })),
  });

  const normalizedNext = normalizeSnapshot(next);
  saveMockSnapshot(normalizedNext);
  return normalizedNext;
}

export async function saveProject(project: Project) {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("save_project", { project });
  }

  const snapshot = loadMockSnapshot();
  const index = snapshot.projects.findIndex((entry) => entry.id === project.id);
  const nextCatalogOrder =
    project.catalogOrder > 0
      ? project.catalogOrder
      : snapshot.projects.reduce((max, entry) => Math.max(max, entry.catalogOrder ?? 0), 0) + 1;
  const nextProjects =
    index >= 0
      ? snapshot.projects.map((entry) =>
          entry.id === project.id ? { ...project, catalogOrder: nextCatalogOrder } : entry,
        )
      : [...snapshot.projects, { ...project, catalogOrder: nextCatalogOrder }];
  const next = mergePresetIds({
    ...snapshot,
    projects: nextProjects,
  });

  const normalizedNext = normalizeSnapshot(next);
  saveMockSnapshot(normalizedNext);
  return normalizedNext;
}

export async function savePreset(preset: Preset) {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("save_preset", { preset });
  }

  const snapshot = loadMockSnapshot();
  const userPresets = snapshot.presets.filter((entry) => entry.id !== "all-enabled");
  const nextSortOrder =
    preset.sortOrder > 0
      ? preset.sortOrder
      : userPresets.reduce((max, entry) => Math.max(max, entry.sortOrder ?? 0), 0) + 1;
  const index = userPresets.findIndex((entry) => entry.id === preset.id);
  const nextPresets =
    index >= 0
      ? userPresets.map((entry) =>
          entry.id === preset.id
            ? { ...preset, sortOrder: nextSortOrder, readOnly: false }
            : entry,
        )
      : [...userPresets, { ...preset, sortOrder: nextSortOrder, readOnly: false }];

  const next = mergePresetIds({
    ...snapshot,
    presets: nextPresets,
  });

  const normalizedNext = normalizeSnapshot(next);
  saveMockSnapshot(normalizedNext);
  return normalizedNext;
}

export async function deletePreset(presetId: string) {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("delete_preset", { presetId });
  }

  const snapshot = loadMockSnapshot();
  const next = mergePresetIds({
    ...snapshot,
    presets: snapshot.presets.filter((preset) => preset.id !== presetId && preset.id !== "all-enabled"),
  });

  const normalizedNext = normalizeSnapshot(next);
  saveMockSnapshot(normalizedNext);
  return normalizedNext;
}

export async function reorderProjects(updates: ProjectOrderUpdate[]) {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("reorder_projects", { updates });
  }

  const snapshot = loadMockSnapshot();
  const nextOrder = new Map(updates.map((entry) => [entry.projectId, entry.catalogOrder]));
  const next = mergePresetIds({
    ...snapshot,
    projects: snapshot.projects
      .map((project) => ({
        ...project,
        catalogOrder: nextOrder.get(project.id) ?? project.catalogOrder,
      }))
      .sort(compareProjects)
      .map((project, index) => ({
        ...project,
        catalogOrder: index + 1,
      })),
  });

  const normalizedNext = normalizeSnapshot(next);
  saveMockSnapshot(normalizedNext);
  return normalizedNext;
}

export async function deleteProject(projectId: string) {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("delete_project", { projectId });
  }

  const snapshot = loadMockSnapshot();
  window.localStorage.removeItem(mockStorageKey(projectId));
  const next = mergePresetIds({
    ...snapshot,
    projects: snapshot.projects.filter((project) => project.id !== projectId),
  });

  const normalizedNext = normalizeSnapshot(next);
  saveMockSnapshot(normalizedNext);
  return normalizedNext;
}

export async function startProjects(projectIds?: string[]) {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("start_projects", { projectIds: projectIds ?? null });
  }

  const snapshot = loadMockSnapshot();
  const ids = new Set(projectIds?.length ? projectIds : snapshot.projects.filter((project) => project.enabled).map((project) => project.id));
  const nextProjects = snapshot.projects.map((project) =>
    ids.has(project.id) ? { ...project, status: "starting" as const } : project,
  );
  const next = mergePresetIds({ ...snapshot, projects: nextProjects });
  const normalizedNext = normalizeSnapshot(next);
  saveMockSnapshot(normalizedNext);

  const orderedProjects = normalizedNext.projects
    .filter((entry) => ids.has(entry.id))
    .sort(compareProjects);
  const mockServiceLinks = readMockServiceLinks();
  const projectsById = new Map(normalizedNext.projects.map((project) => [project.id, project]));
  let previousReadyAt = 0;

  for (const [index, project] of orderedProjects.entries()) {
    const startAt = index === 0 ? 0 : (project.waitForPreviousReady ? previousReadyAt : 0);
    const readyAt = startAt + 900;
    previousReadyAt = readyAt;

    window.setTimeout(() => {
      emitStatus({
        projectId: project.id,
        status: "starting",
        exitCode: null,
        message: `Iniciando ${project.runTarget}`,
      });
      emitLog({
        projectId: project.id,
        stream: "system",
        line: `> ${project.rootPath}`,
        timestamp: new Date().toISOString(),
      });
      emitLog({
        projectId: project.id,
        stream: "stdout",
        line: `${project.name} ejecutando ${project.runMode === "script" ? "script" : "comando"} ${project.runTarget}`,
        timestamp: new Date().toISOString(),
      });
    }, startAt);

    window.setTimeout(() => {
      emitStatus({
        projectId: project.id,
        status: "ready",
        exitCode: null,
        message: project.port ? `Escuchando en ${project.port}` : "Proceso listo",
      });
      emitLog({
        projectId: project.id,
        stream: "stdout",
        line: project.port ? `Ready on port ${project.port}` : "Ready",
        timestamp: new Date().toISOString(),
      });

      const outgoingLinks = mockServiceLinks.filter((entry) => entry.sourceProjectId === project.id);
      outgoingLinks.forEach((link, linkIndex) => {
        const targetProject = projectsById.get(link.targetProjectId);
        if (!targetProject) {
          return;
        }

        const failed = linkIndex % 4 === 3;
        window.setTimeout(() => {
          emitTraffic({
            id: createId("traffic"),
            sourceProjectId: project.id,
            sourceLabel: project.name,
            targetProjectId: targetProject.id,
            method: linkIndex % 2 === 0 ? "GET" : "POST",
            path: normalizeLinkPath(link.path) || "/health",
            statusCode: failed ? 502 : 200,
            ok: !failed,
            durationMs: 42 + linkIndex * 17,
            error: failed ? `Timeout llamando ${targetProject.name}` : null,
            timestamp: new Date().toISOString(),
          });
        }, 420 + linkIndex * 180);
      });
    }, readyAt);
  }

  return normalizedNext;
}

export async function stopProjects(projectIds?: string[]) {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("stop_projects", { projectIds: projectIds ?? null });
  }

  const snapshot = loadMockSnapshot();
  const ids = new Set(projectIds?.length ? projectIds : snapshot.projects.map((project) => project.id));
  const next = mergePresetIds({
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      ids.has(project.id) ? { ...project, status: "stopped" as const } : project,
    ),
  });

  const normalizedNext = normalizeSnapshot(next);
  saveMockSnapshot(normalizedNext);

  for (const project of normalizedNext.projects.filter((entry) => ids.has(entry.id))) {
    emitStatus({
      projectId: project.id,
      status: "stopped",
      exitCode: 0,
      message: "Proceso detenido",
    });
  }

  return normalizedNext;
}

export async function forceStopProjects(projectIds?: string[]) {
  if (isTauriRuntime()) {
    return invoke<Snapshot>("force_stop_projects", { projectIds: projectIds ?? null });
  }

  const snapshot = loadMockSnapshot();
  const ids = new Set(projectIds?.length ? projectIds : snapshot.projects.map((project) => project.id));
  const next = mergePresetIds({
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      ids.has(project.id)
        ? { ...project, status: "stopped" as const, lastExitCode: 0 }
      : project,
    ),
  });

  const normalizedNext = normalizeSnapshot(next);
  saveMockSnapshot(normalizedNext);

  for (const project of normalizedNext.projects.filter((entry) => ids.has(entry.id))) {
    emitStatus({
      projectId: project.id,
      status: "stopped",
      exitCode: 0,
      message: "Proceso detenido por fuerza",
    });
    emitLog({
      projectId: project.id,
      stream: "system",
      line: project.port
        ? `Force stop liberando puerto ${project.port}`
        : "Force stop ejecutado",
      timestamp: new Date().toISOString(),
    });
  }

  return normalizedNext;
}

export async function getProjectMocks(projectId: string) {
  if (isTauriRuntime()) {
    const collection = await invoke<ProjectMockCollection>("get_project_mocks", { projectId });
    return normalizeMockCollection(collection);
  }

  return readMockRegistry(projectId);
}

export async function saveProjectMock(projectId: string, mock: ProjectMock) {
  if (isTauriRuntime()) {
    const collection = await invoke<ProjectMockCollection>("save_project_mock", { projectId, mock });
    return normalizeMockCollection(collection);
  }

  const current = readMockRegistry(projectId);
  const nextMock = normalizeProjectMock(mock, current.mocks.length);
  const nextMocks = current.mocks.some((entry) => entry.id === nextMock.id)
    ? current.mocks.map((entry) => (entry.id === nextMock.id ? nextMock : entry))
    : [...current.mocks, nextMock];

  const collection = saveMockRegistry(projectId, {
    summary: buildMockSummary(nextMocks),
    mocks: nextMocks,
  });
  emitProjectMockSummary({ projectId, summary: collection.summary });
  return collection;
}

export async function deleteProjectMock(projectId: string, mockId: string) {
  if (isTauriRuntime()) {
    const collection = await invoke<ProjectMockCollection>("delete_project_mock", { projectId, mockId });
    return normalizeMockCollection(collection);
  }

  const current = readMockRegistry(projectId);
  const nextMocks = current.mocks.filter((mock) => mock.id !== mockId);
  const collection = saveMockRegistry(projectId, {
    summary: buildMockSummary(nextMocks),
    mocks: nextMocks,
  });
  emitProjectMockSummary({ projectId, summary: collection.summary });
  return collection;
}

export async function listenRuntimeEvents(
  onStatus: (payload: RuntimeStatusPayload) => void,
  onLog: (payload: LogPayload) => void,
) {
  if (isTauriRuntime()) {
    const unlistenStatus = await listen<RuntimeStatusPayload>("project-status", (event) => {
      onStatus(event.payload);
    });
    const unlistenLog = await listen<LogPayload>("project-log", (event) => {
      onLog(event.payload);
    });

    return () => {
      unlistenStatus();
      unlistenLog();
    };
  }

  statusListeners.add(onStatus);
  logListeners.add(onLog);

  return () => {
    statusListeners.delete(onStatus);
    logListeners.delete(onLog);
  };
}

export async function listenProjectMockSummaryEvents(
  onSummary: (payload: ProjectMockSummaryPayload) => void,
) {
  if (isTauriRuntime()) {
    const unlistenSummary = await listen<ProjectMockSummaryPayload>("project-mock-summary", (event) => {
      onSummary(event.payload);
    });

    return () => {
      unlistenSummary();
    };
  }

  mockSummaryListeners.add(onSummary);

  return () => {
    mockSummaryListeners.delete(onSummary);
  };
}

export async function listenServiceTrafficEvents(
  onTraffic: (payload: ServiceTrafficEvent) => void,
) {
  if (isTauriRuntime()) {
    const unlistenTraffic = await listen<ServiceTrafficEvent>("service-traffic", (event) => {
      onTraffic(event.payload);
    });

    return () => {
      unlistenTraffic();
    };
  }

  trafficListeners.add(onTraffic);

  return () => {
    trafficListeners.delete(onTraffic);
  };
}

export async function openServiceTopologyWindow(focusProjectId?: string | null) {
  const url = buildServiceTopologyWindowUrl(focusProjectId);

  if (isTauriRuntime()) {
    await invoke("open_service_topology_window", {
      focusProjectId: focusProjectId ?? null,
    });
    return;
  }

  const popup = window.open(
    url,
    SERVICE_TOPOLOGY_WINDOW_LABEL,
    "popup=yes,width=1760,height=1100,resizable=yes,scrollbars=yes",
  );
  popup?.focus();
}

export async function pickRootFromDialog(defaultPath?: string | null) {
  const initialPath = defaultPath ?? DEFAULT_ROOT;

  if (!isTauriRuntime()) {
    return initialPath;
  }

  const { open } = await import("@tauri-apps/plugin-dialog");
  const selection = await open({
    directory: true,
    multiple: false,
    defaultPath: initialPath,
  });

  if (Array.isArray(selection)) {
    return selection[0] ?? null;
  }

  return selection;
}

export function getDefaultRoot() {
  return DEFAULT_ROOT;
}




