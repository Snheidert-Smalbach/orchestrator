import { create } from "zustand";
import {
  deletePreset,
  deleteProject,
  forceStopProjects,
  getDefaultRoot,
  getRuntimeDiagnostics,
  getSnapshot,
  importDetectedProjects,
  importSingleProject,
  listenRuntimeEvents,
  reorderProjects as reorderProjectsInBackend,
  savePreset,
  saveProject,
  scanRoot,
  startProjects,
  stopProjects,
} from "../lib/tauri";
import type {
  DetectedProject,
  LogPayload,
  ProjectMockSummary,
  Preset,
  Project,
  RuntimeStatusPayload,
  Settings,
  SystemDiagnostics,
} from "../lib/types";

type LogState = Record<string, LogPayload[]>;
type RuntimeMessageState = Record<string, string | null>;
type PersistProjectOptions = {
  quiet?: boolean;
};

const LOG_FLUSH_INTERVAL_MS = 80;
let queuedLogPayloads: LogPayload[] = [];
let flushQueuedLogs: (() => void) | null = null;
let queuedLogTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeEventsUnlisten: (() => void) | null = null;
let runtimeEventsPromise: Promise<void> | null = null;

interface AppStore {
  settings: Settings;
  projects: Project[];
  presets: Preset[];
  diagnostics: SystemDiagnostics | null;
  detectedProjects: DetectedProject[];
  logs: LogState;
  combinedLogs: LogPayload[];
  runtimeMessages: RuntimeMessageState;
  forceStopProjectIds: string[];
  forceStartProjectIds: string[];
  selectedPresetId: string;
  selectedProjectId: string | null;
  isLoading: boolean;
  isBusy: boolean;
  isScanOpen: boolean;
  error: string | null;
  subscriptionsReady: boolean;
  bootstrap: () => Promise<void>;
  refreshDiagnostics: () => Promise<void>;
  selectProject: (projectId: string | null) => void;
  setScanOpen: (open: boolean) => void;
  scan: (rootPath?: string, recursive?: boolean) => Promise<void>;
  importDetected: (rootPath: string, recursive: boolean, selectedRootPaths?: string[]) => Promise<void>;
  importProjectPath: (rootPath: string, preferredEnvFile?: string | null) => Promise<void>;
  persistProject: (project: Project, options?: PersistProjectOptions) => Promise<void>;
  persistPreset: (preset: Preset) => Promise<void>;
  removePreset: (presetId: string) => Promise<void>;
  selectPreset: (presetId: string) => void;
  reorderProjects: (orderedProjectIds: string[]) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  start: (projectIds?: string[]) => Promise<void>;
  stop: (projectIds?: string[]) => Promise<void>;
  forceStop: (projectIds?: string[]) => Promise<void>;
  forceStart: (projectIds?: string[]) => Promise<void>;
  appendLog: (payload: LogPayload) => void;
  appendProjectMessage: (projectIds: string[], message: string, stream?: LogPayload["stream"]) => void;
  applyRuntimeStatus: (payload: RuntimeStatusPayload) => void;
  patchProjectMockSummary: (projectId: string, summary: ProjectMockSummary) => void;
}

const defaultSettings: Settings = {
  defaultRoots: [getDefaultRoot()],
};

function capLogs(entries: LogPayload[]) {
  return entries.slice(-500);
}

function queueLogPayload(payload: LogPayload) {
  queuedLogPayloads.push(payload);

  if (queuedLogTimer != null) {
    return;
  }

  queuedLogTimer = setTimeout(() => {
    queuedLogTimer = null;
    flushQueuedLogs?.();
  }, LOG_FLUSH_INTERVAL_MS);
}

function mergeIds(...groups: string[][]) {
  return [...new Set(groups.flat())];
}

function excludeIds(source: string[], ids: string[]) {
  if (!ids.length) {
    return source;
  }

  const blocked = new Set(ids);
  return source.filter((id) => !blocked.has(id));
}

function compareProjects(left: Project, right: Project) {
  return (
    left.catalogOrder - right.catalogOrder ||
    left.startupPhase - right.startupPhase ||
    left.name.localeCompare(right.name)
  );
}

function reorderProjectList(projects: Project[], orderedProjectIds: string[]) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  const orderedProjects: Project[] = [];

  for (const projectId of orderedProjectIds) {
    const project = projectById.get(projectId);
    if (!project || seen.has(projectId)) {
      continue;
    }

    orderedProjects.push(project);
    seen.add(projectId);
  }

  for (const project of [...projects].sort(compareProjects)) {
    if (!seen.has(project.id)) {
      orderedProjects.push(project);
    }
  }

  return orderedProjects.map((project, index) => ({
    ...project,
    catalogOrder: index + 1,
  }));
}

function isStopCandidateStatus(status: Project["status"]) {
  return status === "starting" || status === "running" || status === "ready";
}

function isForceStopCandidateStatus(status: Project["status"]) {
  return isStopCandidateStatus(status) || status === "failed";
}

function isForceStartCandidateStatus(status: Project["status"]) {
  return status === "failed";
}

function resolveStopTargetIds(projects: Project[], projectIds?: string[]) {
  if (projectIds !== undefined) {
    return projectIds;
  }

  return projects
    .filter((project) => isForceStopCandidateStatus(project.status))
    .map((project) => project.id);
}

function resolveForceStopTargetIds(projects: Project[], forceStopProjectIds: string[], projectIds?: string[]) {
  if (projectIds !== undefined) {
    return projectIds;
  }

  if (forceStopProjectIds.length) {
    return forceStopProjectIds;
  }

  return projects
    .filter((project) => isForceStopCandidateStatus(project.status))
    .map((project) => project.id);
}

function resolveForceStartTargetIds(projects: Project[], forceStartProjectIds: string[], projectIds?: string[]) {
  if (projectIds !== undefined) {
    return projectIds;
  }

  if (forceStartProjectIds.length) {
    return forceStartProjectIds;
  }

  return projects
    .filter((project) => isForceStartCandidateStatus(project.status))
    .map((project) => project.id);
}

function messageIndicatesPortConflict(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("port") && (
    normalized.includes("already taken") ||
    normalized.includes("conflict") ||
    normalized.includes("busy")
  );
}

function resolvePortConflictProjectIds(projects: Project[], targetIds: string[], message: string) {
  if (!messageIndicatesPortConflict(message)) {
    return [];
  }

  const allowed = new Set(targetIds);
  return projects
    .filter((project) => allowed.has(project.id) && project.port != null && message.includes(String(project.port)))
    .map((project) => project.id);
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") {
      return serialized;
    }
  } catch {
    // ignore serialization issues
  }

  return fallback;
}

function resolveSelectedPresetId(presets: Preset[], currentPresetId?: string | null) {
  return presets.find((preset) => preset.id === currentPresetId)?.id ?? presets[0]?.id ?? "all-enabled";
}

function ensureRuntimeSubscriptions(getStore: () => AppStore) {
  if (runtimeEventsUnlisten) {
    return Promise.resolve();
  }

  if (!runtimeEventsPromise) {
    runtimeEventsPromise = listenRuntimeEvents(
      (payload) => {
        getStore().applyRuntimeStatus(payload);
      },
      (payload) => queueLogPayload(payload),
    )
      .then((unlisten) => {
        runtimeEventsUnlisten = unlisten;
      })
      .catch((error) => {
        runtimeEventsPromise = null;
        throw error;
      });
  }

  return runtimeEventsPromise;
}

export const useAppStore = create<AppStore>((set, get) => ({
  settings: defaultSettings,
  projects: [],
  presets: [],
  diagnostics: null,
  detectedProjects: [],
  logs: {},
  combinedLogs: [],
  runtimeMessages: {},
  forceStopProjectIds: [],
  forceStartProjectIds: [],
  selectedPresetId: "all-enabled",
  selectedProjectId: null,
  isLoading: false,
  isBusy: false,
  isScanOpen: false,
  error: null,
  subscriptionsReady: false,
  bootstrap: async () => {
    flushQueuedLogs = () => {
      if (!queuedLogPayloads.length) {
        return;
      }

      const batch = queuedLogPayloads;
      queuedLogPayloads = [];

      set((state) => {
        const groupedLogs = new Map<string, LogPayload[]>();
        for (const payload of batch) {
          const current = groupedLogs.get(payload.projectId) ?? [];
          current.push(payload);
          groupedLogs.set(payload.projectId, current);
        }

        const nextLogs = { ...state.logs };
        for (const [projectId, payloads] of groupedLogs.entries()) {
          nextLogs[projectId] = capLogs([...(nextLogs[projectId] ?? []), ...payloads]);
        }

        return {
          logs: nextLogs,
          combinedLogs: capLogs([...state.combinedLogs, ...batch]),
        };
      });
    };

    set({ isLoading: true, error: null });
    try {
      if (!get().subscriptionsReady) {
        await ensureRuntimeSubscriptions(get);
        if (!get().subscriptionsReady) {
          set({ subscriptionsReady: true });
        }
      }

      const [snapshot, diagnostics] = await Promise.all([
        getSnapshot(),
        getRuntimeDiagnostics().catch(() => null),
      ]);
      const selectedPresetId = resolveSelectedPresetId(snapshot.presets, get().selectedPresetId);
      const selectedProjectId =
        snapshot.projects.find((project) => project.id === get().selectedProjectId)?.id ??
        snapshot.projects[0]?.id ??
        null;
      set((state) => ({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        diagnostics,
        selectedPresetId,
        selectedProjectId,
        forceStopProjectIds: state.forceStopProjectIds.filter((projectId) =>
          snapshot.projects.some(
            (project) => project.id === projectId && isForceStopCandidateStatus(project.status),
          ),
        ),
        forceStartProjectIds: state.forceStartProjectIds.filter((projectId) =>
          snapshot.projects.some(
            (project) => project.id === projectId && isForceStartCandidateStatus(project.status),
          ),
        ),
      }));
    } catch (error) {
      set({
        error: errorMessage(error, "No fue posible cargar el snapshot."),
      });
    } finally {
      set({ isLoading: false });
    }
  },
  refreshDiagnostics: async () => {
    try {
      const diagnostics = await getRuntimeDiagnostics();
      set({ diagnostics });
    } catch {
      // keep the latest successful diagnostics visible in the UI
    }
  },
  selectPreset: (presetId) => set({ selectedPresetId: presetId }),
  selectProject: (projectId) => set({ selectedProjectId: projectId }),
  setScanOpen: (open) => set({ isScanOpen: open }),
  scan: async (rootPath, recursive = false) => {
    const targetRoot = rootPath ?? get().settings.defaultRoots[0] ?? getDefaultRoot();
    set({ isBusy: true, error: null });
    try {
      const detectedProjects = await scanRoot(targetRoot, recursive);
      set({ detectedProjects, isScanOpen: true });
    } catch (error) {
      set({
        error: errorMessage(error, "No fue posible escanear la carpeta."),
      });
    } finally {
      set({ isBusy: false });
    }
  },
  importDetected: async (rootPath, recursive, selectedRootPaths) => {
    set({ isBusy: true, error: null });
    try {
      const snapshot = await importDetectedProjects(rootPath, recursive, selectedRootPaths);
      set({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
        detectedProjects: [],
        isScanOpen: false,
        selectedProjectId: get().selectedProjectId ?? snapshot.projects[0]?.id ?? null,
      });
    } catch (error) {
      set({
        error: errorMessage(error, "No fue posible importar los proyectos detectados."),
      });
    } finally {
      set({ isBusy: false });
    }
  },
  importProjectPath: async (rootPath, preferredEnvFile) => {
    set({ isBusy: true, error: null });
    try {
      const snapshot = await importSingleProject(rootPath, preferredEnvFile);
      const importedProject = snapshot.projects.find((project) => project.rootPath === rootPath);
      set({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
        isScanOpen: false,
        selectedProjectId: importedProject?.id ?? get().selectedProjectId ?? snapshot.projects[0]?.id ?? null,
      });
    } catch (error) {
      set({
        error: errorMessage(error, "No fue posible importar el proyecto seleccionado."),
      });
      throw error;
    } finally {
      set({ isBusy: false });
    }
  },
  persistProject: async (project, options) => {
    if (options?.quiet) {
      set({ error: null });
    } else {
      set({ isBusy: true, error: null });
    }

    try {
      const snapshot = await saveProject(project);
      set({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
        selectedProjectId: project.id,
      });
    } catch (error) {
      set({
        error: errorMessage(error, "No fue posible guardar el proyecto."),
      });
      throw error;
    } finally {
      if (!options?.quiet) {
        set({ isBusy: false });
      }
    }
  },
  persistPreset: async (preset) => {
    set({ isBusy: true, error: null });
    try {
      const snapshot = await savePreset(preset);
      set({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, preset.id),
      });
    } catch (error) {
      set({
        error: errorMessage(error, "No fue posible guardar el workspace."),
      });
      throw error;
    } finally {
      set({ isBusy: false });
    }
  },
  removePreset: async (presetId) => {
    set({ isBusy: true, error: null });
    try {
      const snapshot = await deletePreset(presetId);
      set({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId === presetId ? null : get().selectedPresetId),
      });
    } catch (error) {
      set({
        error: errorMessage(error, "No fue posible eliminar el workspace."),
      });
      throw error;
    } finally {
      set({ isBusy: false });
    }
  },
  reorderProjects: async (orderedProjectIds) => {
    const optimisticProjects = reorderProjectList(get().projects, orderedProjectIds);
    set({ projects: optimisticProjects, error: null });

    try {
      const snapshot = await reorderProjectsInBackend(
        optimisticProjects.map((project) => ({
          projectId: project.id,
          catalogOrder: project.catalogOrder,
        })),
      );
      set({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
      });
    } catch (error) {
      const message = errorMessage(error, "No fue posible guardar el nuevo orden del catalogo.");
      try {
        const snapshot = await getSnapshot();
        set({
          settings: snapshot.settings,
          projects: snapshot.projects,
          presets: snapshot.presets,
          selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
          error: message,
        });
      } catch {
        set({
          error: message,
        });
      }
      throw error;
    }
  },
  removeProject: async (projectId) => {
    set({ isBusy: true, error: null });
    try {
      const snapshot = await deleteProject(projectId);
      set((state) => ({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
        selectedProjectId:
          get().selectedProjectId === projectId
            ? snapshot.projects[0]?.id ?? null
            : get().selectedProjectId,
        forceStopProjectIds: state.forceStopProjectIds.filter((id) => id !== projectId),
        forceStartProjectIds: state.forceStartProjectIds.filter((id) => id !== projectId),
      }));
    } catch (error) {
      set({
        error: errorMessage(error, "No fue posible remover el proyecto."),
      });
    } finally {
      set({ isBusy: false });
      void get().refreshDiagnostics();
    }
  },
  start: async (projectIds) => {
    const targetIds = projectIds !== undefined
      ? projectIds
      : get().projects.filter((project) => project.enabled).map((project) => project.id);

    if (!targetIds.length) {
      return;
    }

    set({ isBusy: true, error: null });
    try {
      const snapshot = await startProjects(targetIds);
      set((state) => ({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
        forceStopProjectIds: excludeIds(state.forceStopProjectIds, targetIds),
        forceStartProjectIds: excludeIds(state.forceStartProjectIds, targetIds),
      }));
    } catch (error) {
      const message = errorMessage(error, "No fue posible iniciar los procesos.");
      get().appendProjectMessage(targetIds, message, "stderr");

      try {
        const snapshot = await getSnapshot();
        const forceStartIds = resolvePortConflictProjectIds(snapshot.projects, targetIds, message);

        if (forceStartIds.length) {
          get().appendProjectMessage(
            forceStartIds,
            "El puerto configurado esta ocupado. Usa Forzar e iniciar.",
            "stderr",
          );
        }

        set((state) => ({
          settings: snapshot.settings,
          projects: snapshot.projects,
          presets: snapshot.presets,
          selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
          error: message,
          forceStartProjectIds: mergeIds(
            excludeIds(state.forceStartProjectIds, targetIds),
            forceStartIds,
          ),
        }));
      } catch {
        const fallbackForceStartIds = resolvePortConflictProjectIds(get().projects, targetIds, message);
        set((state) => ({
          error: message,
          forceStartProjectIds: mergeIds(
            excludeIds(state.forceStartProjectIds, targetIds),
            fallbackForceStartIds,
          ),
        }));
      }
    } finally {
      set({ isBusy: false });
      void get().refreshDiagnostics();
    }
  },
  stop: async (projectIds) => {
    const targetIds = resolveStopTargetIds(get().projects, projectIds);

    if (!targetIds.length) {
      return;
    }

    set({ isBusy: true, error: null });
    try {
      const snapshot = await stopProjects(targetIds);
      set((state) => ({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
        forceStopProjectIds: excludeIds(state.forceStopProjectIds, targetIds),
        forceStartProjectIds: excludeIds(state.forceStartProjectIds, targetIds),
      }));
    } catch (error) {
      const message = errorMessage(error, "No fue posible detener los procesos.");

      try {
        const snapshot = await getSnapshot();
        const forceStopIds = snapshot.projects
          .filter((project) => targetIds.includes(project.id) && isForceStopCandidateStatus(project.status))
          .map((project) => project.id);

        if (forceStopIds.length) {
          get().appendProjectMessage(
            forceStopIds,
            "La detencion normal no fue suficiente. Usa Forzar detencion.",
            "stderr",
          );
        }

        set((state) => ({
          settings: snapshot.settings,
          projects: snapshot.projects,
          presets: snapshot.presets,
          selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
          error: message,
          forceStopProjectIds: mergeIds(excludeIds(state.forceStopProjectIds, targetIds), forceStopIds),
          forceStartProjectIds: excludeIds(state.forceStartProjectIds, targetIds),
        }));
      } catch {
        set((state) => ({
          error: message,
          forceStopProjectIds: mergeIds(excludeIds(state.forceStopProjectIds, targetIds), targetIds),
          forceStartProjectIds: excludeIds(state.forceStartProjectIds, targetIds),
        }));
      }
    } finally {
      set({ isBusy: false });
      void get().refreshDiagnostics();
    }
  },
  forceStop: async (projectIds) => {
    const targetIds = resolveForceStopTargetIds(
      get().projects,
      get().forceStopProjectIds,
      projectIds,
    );

    if (!targetIds.length) {
      return;
    }

    set({ isBusy: true, error: null });
    try {
      const snapshot = await forceStopProjects(targetIds);
      set((state) => ({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
        forceStopProjectIds: excludeIds(state.forceStopProjectIds, targetIds),
        forceStartProjectIds: excludeIds(state.forceStartProjectIds, targetIds),
      }));
    } catch (error) {
      const message = errorMessage(error, "No fue posible forzar la detencion de los procesos.");

      try {
        const snapshot = await getSnapshot();
        const remainingForceStopIds = snapshot.projects
          .filter((project) => targetIds.includes(project.id) && isForceStopCandidateStatus(project.status))
          .map((project) => project.id);

        if (remainingForceStopIds.length) {
          get().appendProjectMessage(
            remainingForceStopIds,
            "La detencion forzada no logro liberar el proceso.",
            "stderr",
          );
        }

        set((state) => ({
          settings: snapshot.settings,
          projects: snapshot.projects,
          presets: snapshot.presets,
          selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
          error: message,
          forceStopProjectIds: mergeIds(
            excludeIds(state.forceStopProjectIds, targetIds),
            remainingForceStopIds,
          ),
          forceStartProjectIds: excludeIds(state.forceStartProjectIds, targetIds),
        }));
      } catch {
        set((state) => ({
          error: message,
          forceStopProjectIds: mergeIds(excludeIds(state.forceStopProjectIds, targetIds), targetIds),
          forceStartProjectIds: excludeIds(state.forceStartProjectIds, targetIds),
        }));
      }
    } finally {
      set({ isBusy: false });
      void get().refreshDiagnostics();
    }
  },
  forceStart: async (projectIds) => {
    const targetIds = resolveForceStartTargetIds(
      get().projects,
      get().forceStartProjectIds,
      projectIds,
    );

    if (!targetIds.length) {
      return;
    }

    set({ isBusy: true, error: null });
    try {
      await forceStopProjects(targetIds);
      const snapshot = await startProjects(targetIds);
      set((state) => ({
        settings: snapshot.settings,
        projects: snapshot.projects,
        presets: snapshot.presets,
        selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
        forceStopProjectIds: excludeIds(state.forceStopProjectIds, targetIds),
        forceStartProjectIds: excludeIds(state.forceStartProjectIds, targetIds),
      }));
    } catch (error) {
      const message = errorMessage(error, "No fue posible forzar el cierre del puerto e iniciar los procesos.");

      try {
        const snapshot = await getSnapshot();
        const retryForceStartIds = resolvePortConflictProjectIds(snapshot.projects, targetIds, message);

        if (retryForceStartIds.length) {
          get().appendProjectMessage(
            retryForceStartIds,
            "El puerto sigue ocupado. Puedes volver a intentar Forzar e iniciar.",
            "stderr",
          );
        }

        set((state) => ({
          settings: snapshot.settings,
          projects: snapshot.projects,
          presets: snapshot.presets,
          selectedPresetId: resolveSelectedPresetId(snapshot.presets, get().selectedPresetId),
          error: message,
          forceStopProjectIds: excludeIds(state.forceStopProjectIds, targetIds),
          forceStartProjectIds: mergeIds(
            excludeIds(state.forceStartProjectIds, targetIds),
            retryForceStartIds,
          ),
        }));
      } catch {
        const fallbackForceStartIds = resolvePortConflictProjectIds(get().projects, targetIds, message);
        set((state) => ({
          error: message,
          forceStopProjectIds: excludeIds(state.forceStopProjectIds, targetIds),
          forceStartProjectIds: mergeIds(
            excludeIds(state.forceStartProjectIds, targetIds),
            fallbackForceStartIds,
          ),
        }));
      }
    } finally {
      set({ isBusy: false });
      void get().refreshDiagnostics();
    }
  },
  appendLog: (payload) =>
    set((state) => ({
      logs: {
        ...state.logs,
        [payload.projectId]: capLogs([...(state.logs[payload.projectId] ?? []), payload]),
      },
      combinedLogs: capLogs([...state.combinedLogs, payload]),
    })),
  appendProjectMessage: (projectIds, message, stream = "system") =>
    set((state) => {
      const timestamp = new Date().toISOString();
      const nextLogs = { ...state.logs };
      const nextMessages = { ...state.runtimeMessages };
      const newEntries: LogPayload[] = [];

      for (const projectId of projectIds) {
        const entry = { projectId, stream, line: message, timestamp } satisfies LogPayload;
        nextLogs[projectId] = capLogs([...(nextLogs[projectId] ?? []), entry]);
        nextMessages[projectId] = message;
        newEntries.push(entry);
      }

      return {
        logs: nextLogs,
        combinedLogs: capLogs([...state.combinedLogs, ...newEntries]),
        runtimeMessages: nextMessages,
      };
    }),
  applyRuntimeStatus: (payload) =>
    set((state) => {
      const project = state.projects.find((entry) => entry.id === payload.projectId);
      return {
        projects: state.projects.map((entry) =>
          entry.id === payload.projectId
            ? {
                ...entry,
                status: payload.status,
                lastExitCode: payload.exitCode,
              }
            : entry,
        ),
        runtimeMessages: {
          ...state.runtimeMessages,
          [payload.projectId]: payload.message ?? state.runtimeMessages[payload.projectId] ?? null,
        },
        forceStopProjectIds:
          payload.status === "failed"
            ? state.forceStopProjectIds
            : state.forceStopProjectIds.filter((projectId) => projectId !== payload.projectId),
        forceStartProjectIds:
          payload.status === "failed"
            ? state.forceStartProjectIds
            : state.forceStartProjectIds.filter((projectId) => projectId !== payload.projectId),
        error:
          payload.status === "failed" && payload.message
            ? `${project?.name ?? payload.projectId}: ${payload.message}`
            : state.error,
      };
    }),
  patchProjectMockSummary: (projectId, summary) =>
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              mockSummary: summary,
            }
          : project,
      ),
    })),
}));
