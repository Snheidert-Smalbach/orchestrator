import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DetectedProject,
  LogPayload,
  ProcessDiagnostic,
  Preset,
  ProjectResourceUsage,
  ProjectOrderUpdate,
  RuntimeStatusPayload,
  Project,
  Snapshot,
  SystemDiagnostics,
} from "./types";

const STORAGE_KEY = "back-orchestrator.mock.snapshot";
const DEFAULT_ROOT = "C:\\workspace\\apps\\BACK";

const statusListeners = new Set<(payload: RuntimeStatusPayload) => void>();
const logListeners = new Set<(payload: LogPayload) => void>();

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
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
    projects: normalizedProjects,
  };
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
  const rootPath = `${DEFAULT_ROOT}\\${options.name}`;
  const envFiles = options.envFiles ?? [`${rootPath}\\.env`];

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
      `${DEFAULT_ROOT}\\sample_api_pages\\.env`,
      `${DEFAULT_ROOT}\\sample_api_pages\\.env.example`,
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
    shell: "cmd",
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
    name: "node.exe",
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
  const normalizedProject = projectRootPath.toLowerCase();
  const normalizedRoot = rootPath.toLowerCase();

  if (normalizedProject === normalizedRoot) {
    return true;
  }

  const prefix = `${normalizedRoot}\\`;
  if (!normalizedProject.startsWith(prefix)) {
    return false;
  }

  const relative = normalizedProject.slice(prefix.length);
  const segments = relative.split("\\").filter(Boolean);
  return recursive ? segments.length <= 3 : segments.length === 1;
}

export async function scanRoot(rootPath: string, recursive: boolean) {
  if (isTauriRuntime()) {
    return invoke<DetectedProject[]>("scan_root", { rootPath, recursive });
  }

  const snapshot = loadMockSnapshot();
  const importedRoots = new Set(snapshot.projects.map((project) => project.rootPath));

  return detectedSeed
    .filter((project) => isPathWithinScanRoot(project.rootPath, rootPath, recursive))
    .map((project) => ({
      ...project,
      alreadyImported: importedRoots.has(project.rootPath),
    }));
}

export async function inspectProject(rootPath: string, preferredEnvFile?: string | null) {
  if (isTauriRuntime()) {
    return invoke<DetectedProject>("inspect_project", {
      rootPath,
      preferredEnvFile: preferredEnvFile ?? null,
    });
  }

  const detected = detectedSeed.find((project) => project.rootPath === rootPath);
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
  const existingRoots = new Set(snapshot.projects.map((project) => project.rootPath));
  const allowedRoots = selectedRootPaths?.length ? new Set(selectedRootPaths) : null;
  const newProjects = detected
    .filter((project) => !existingRoots.has(project.rootPath))
    .filter((project) => !allowedRoots || allowedRoots.has(project.rootPath))
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
  if (snapshot.projects.some((project) => project.rootPath === detected.rootPath)) {
    return mergePresetIds(snapshot);
  }

  const next = mergePresetIds({
    ...snapshot,
    settings: {
      defaultRoots: [rootPath.split("\\").slice(0, -1).join("\\") || DEFAULT_ROOT],
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




