import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Boxes,
  FolderPlus,
  FolderSearch,
  GitBranch,
  LoaderCircle,
  Monitor,
  MoonStar,
  Palette,
  Play,
  RefreshCw,
  Rocket,
  Server,
  Square,
  SunMedium,
  Trash2,
  TriangleAlert,
  Waves,
  X,
} from "lucide-react";
import { ScanDialog } from "./components/scan-dialog";
import { WorkspaceLayout } from "./components/workspace-layout";
import { getDefaultRoot, pickRootFromDialog } from "./lib/tauri";
import type { ProcessDiagnostic, Project, ProjectResourceUsage } from "./lib/types";
import { useAppStore } from "./store/useAppStore";

type ThemeMode = "dark" | "light";
type ThemeFamily = "aurora" | "ember" | "harbor" | "terminal";
type AlertTone = "warn" | "danger" | "info";

type ThemeDefinition = {
  id: ThemeFamily;
  label: string;
  description: string;
  preview: [string, string, string];
};

type QuickProfile = {
  id: string;
  label: string;
  description: string;
  projectIds: string[];
};

type AlertEntry = {
  id: string;
  tone: AlertTone;
  title: string;
  description: string;
};

type OverlayProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  actions?: ReactNode;
};

const THEME_MODE_STORAGE_KEY = "back-orchestrator.theme-mode";
const THEME_FAMILY_STORAGE_KEY = "back-orchestrator.theme-family";
const LEGACY_THEME_STORAGE_KEY = "back-orchestrator.theme";
const DEFAULT_THEME_FAMILY: ThemeFamily = "aurora";
const THEME_DEFINITIONS: ThemeDefinition[] = [
  {
    id: "aurora",
    label: "Aurora",
    description: "neon frio y capas atmosfericas",
    preview: ["#23d5f6", "#8bff4d", "#0f172a"],
  },
  {
    id: "ember",
    label: "Brasa",
    description: "editorial calido sobre cobre y papel",
    preview: ["#ffb347", "#c2410c", "#4a1d12"],
  },
  {
    id: "harbor",
    label: "Puerto",
    description: "marino tecnico con acentos industriales",
    preview: ["#14b8a6", "#fb923c", "#082f49"],
  },
  {
    id: "terminal",
    label: "CRT",
    description: "retro terminal con fosforo y scanlines",
    preview: ["#4ade80", "#bef264", "#06110b"],
  },
];

function DrawerPanel({ open, onOpenChange, title, description, children, actions }: OverlayProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/62 backdrop-blur-sm" />
        <Dialog.Content className="surface-panel fixed right-0 top-0 z-50 flex h-screen w-[min(430px,92vw)] flex-col overflow-hidden">
          <div className="surface-divider flex items-start justify-between gap-3 px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold text-textStrong">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-[11px] text-textMuted">{description}</Dialog.Description>
            </div>
            <div className="flex items-center gap-2">
              {actions}
              <Dialog.Close className="surface-chip p-2 text-textStrong transition hover:bg-panelSoft">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto scrollbar-thin p-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CenterModal({ open, onOpenChange, title, description, children, actions }: OverlayProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/62 backdrop-blur-sm" />
        <Dialog.Content className="surface-panel fixed left-1/2 top-1/2 z-50 max-h-[84vh] w-[min(720px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden">
          <div className="surface-divider flex items-start justify-between gap-3 px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold text-textStrong">{title}</Dialog.Title>
              <Dialog.Description className="mt-1 text-[11px] text-textMuted">{description}</Dialog.Description>
            </div>
            <div className="flex items-center gap-2">
              {actions}
              <Dialog.Close className="surface-chip p-2 text-textStrong transition hover:bg-panelSoft">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
          </div>
          <div className="max-h-[calc(84vh-84px)] overflow-auto scrollbar-thin p-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function isThemeFamily(value: string | null): value is ThemeFamily {
  return THEME_DEFINITIONS.some((theme) => theme.id === value);
}

function detectPortConflicts(projects: Project[]) {
  const grouped = new Map<number, string[]>();
  for (const project of projects) {
    if (!project.enabled || project.port == null) continue;
    const current = grouped.get(project.port) ?? [];
    grouped.set(project.port, [...current, project.id]);
  }
  const conflictedProjectIds = new Set<string>();
  for (const [, ids] of grouped.entries()) {
    if (ids.length > 1) ids.forEach((id) => conflictedProjectIds.add(id));
  }
  return conflictedProjectIds;
}

function collectDependencyClosure(projects: Project[], projectId: string) {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const ordered: string[] = [];
  const seen = new Set<string>();
  const stack = [projectId];

  while (stack.length) {
    const currentId = stack.pop();
    if (!currentId || seen.has(currentId)) {
      continue;
    }

    const project = byId.get(currentId);
    if (!project) {
      continue;
    }

    seen.add(currentId);
    for (const dependency of [...project.dependencies].reverse()) {
      if (dependency.requiredForStart) {
        stack.push(dependency.dependsOnProjectId);
      }
    }
    ordered.push(currentId);
  }

  return ordered.reverse();
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").toLowerCase();
}

function pathHasDirectory(path: string, segment: string) {
  return normalizePath(path)
    .split("/")
    .filter(Boolean)
    .includes(segment.toLowerCase());
}

function buildQuickProfiles(projects: Project[], selectedProjectId: string | null) {
  const enabledProjectIds = projects.filter((project) => project.enabled).map((project) => project.id);
  const backendProjectIds = projects
    .filter((project) => project.enabled && pathHasDirectory(project.rootPath, "BACK"))
    .map((project) => project.id);
  const frontendProjectIds = projects
    .filter((project) => project.enabled && pathHasDirectory(project.rootPath, "FRONT"))
    .map((project) => project.id);

  const profiles: QuickProfile[] = [];

  if (selectedProjectId) {
    const dependencyClosure = collectDependencyClosure(projects, selectedProjectId);
    if (dependencyClosure.length) {
      profiles.push({
        id: "selected-deps",
        label: "Seleccion + deps",
        description: "Arranca solo el proyecto seleccionado y sus dependencias requeridas.",
        projectIds: dependencyClosure,
      });
    }
  }

  if (backendProjectIds.length) {
    profiles.push({
      id: "backend",
      label: "Backend",
      description: "Arranca solo los servicios habilitados detectados como backend.",
      projectIds: backendProjectIds,
    });
  }

  if (frontendProjectIds.length) {
    profiles.push({
      id: "frontend",
      label: "Frontend",
      description: "Arranca solo los servicios habilitados detectados como frontend.",
      projectIds: frontendProjectIds,
    });
  }

  if (enabledProjectIds.length) {
    profiles.push({
      id: "all-enabled",
      label: "Habilitados",
      description: "Arranca todos los servicios habilitados.",
      projectIds: enabledProjectIds,
    });
  }

  return profiles;
}

function toProjectResourceMap(entries: ProjectResourceUsage[] | undefined) {
  return Object.fromEntries((entries ?? []).map((entry) => [entry.projectId, entry])) as Record<string, ProjectResourceUsage>;
}

function formatMemory(valueMb: number, precision = 1) {
  if (valueMb >= 1024) {
    return `${(valueMb / 1024).toFixed(precision)} GB`;
  }

  return `${valueMb.toFixed(precision)} MB`;
}

function compactCommand(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 88 ? `${normalized.slice(0, 85)}...` : normalized;
}

function describeNodeProcess(process: ProcessDiagnostic) {
  return `PID ${process.pid} � ${formatMemory(process.workingSetMb)} � ${compactCommand(process.command)}`;
}

function quickProfileIcon(profileId: string) {
  switch (profileId) {
    case "selected-deps":
      return GitBranch;
    case "backend":
      return Server;
    case "frontend":
      return Monitor;
    default:
      return Boxes;
  }
}
function resolveInitialThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }

  const saved = window.localStorage.getItem(THEME_MODE_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  if (saved === "dark" || saved === "light") {
    return saved;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveInitialThemeFamily(): ThemeFamily {
  if (typeof window === "undefined") {
    return DEFAULT_THEME_FAMILY;
  }

  const saved = window.localStorage.getItem(THEME_FAMILY_STORAGE_KEY);
  return isThemeFamily(saved) ? saved : DEFAULT_THEME_FAMILY;
}

function createWorkspaceId() {
  return `workspace-${Math.random().toString(36).slice(2, 10)}`;
}

function alertCardTone(tone: AlertTone) {
  switch (tone) {
    case "danger":
      return "border-danger/35 bg-danger/12 text-danger";
    case "warn":
      return "border-warn/35 bg-warn/12 text-warn";
    default:
      return "border-accent/35 bg-accent/10 text-accent";
  }
}

export default function App() {
  const settings = useAppStore((state) => state.settings);
  const projects = useAppStore((state) => state.projects);
  const presets = useAppStore((state) => state.presets);
  const selectedPresetId = useAppStore((state) => state.selectedPresetId);
  const diagnostics = useAppStore((state) => state.diagnostics);
  const detectedProjects = useAppStore((state) => state.detectedProjects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const forceStopProjectIds = useAppStore((state) => state.forceStopProjectIds);
  const forceStartProjectIds = useAppStore((state) => state.forceStartProjectIds);
  const isLoading = useAppStore((state) => state.isLoading);
  const isBusy = useAppStore((state) => state.isBusy);
  const isScanOpen = useAppStore((state) => state.isScanOpen);
  const error = useAppStore((state) => state.error);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const refreshDiagnostics = useAppStore((state) => state.refreshDiagnostics);
  const selectProject = useAppStore((state) => state.selectProject);
  const setScanOpen = useAppStore((state) => state.setScanOpen);
  const scan = useAppStore((state) => state.scan);
  const importDetected = useAppStore((state) => state.importDetected);
  const importProjectPath = useAppStore((state) => state.importProjectPath);
  const persistProject = useAppStore((state) => state.persistProject);
  const persistPreset = useAppStore((state) => state.persistPreset);
  const removePreset = useAppStore((state) => state.removePreset);
  const selectPreset = useAppStore((state) => state.selectPreset);
  const reorderProjects = useAppStore((state) => state.reorderProjects);
  const removeProject = useAppStore((state) => state.removeProject);
  const start = useAppStore((state) => state.start);
  const stop = useAppStore((state) => state.stop);
  const forceStop = useAppStore((state) => state.forceStop);
  const forceStart = useAppStore((state) => state.forceStart);
  const selectedProjectMessage = useAppStore((state) =>
    selectedProjectId ? state.runtimeMessages[selectedProjectId] ?? null : null,
  );
  const [themeMode, setThemeMode] = useState<ThemeMode>(resolveInitialThemeMode);
  const [themeFamily, setThemeFamily] = useState<ThemeFamily>(resolveInitialThemeFamily);
  const [isThemePickerOpen, setIsThemePickerOpen] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [isWorkspaceCreatorOpen, setIsWorkspaceCreatorOpen] = useState(false);
  const [isUsageDrawerOpen, setIsUsageDrawerOpen] = useState(false);
  const [isQuickActionsOpen, setIsQuickActionsOpen] = useState(false);
  const [isAlertsDrawerOpen, setIsAlertsDrawerOpen] = useState(false);
  const [isCatalogBatchRunning, setIsCatalogBatchRunning] = useState(false);
  const themePickerRef = useRef<HTMLDivElement | null>(null);
  const hasActiveRuntimeProjects = projects.some(
    (project) => project.status === "starting" || project.status === "running" || project.status === "ready",
  );

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    void refreshDiagnostics();
    const interval = window.setInterval(() => {
      void refreshDiagnostics();
    }, hasActiveRuntimeProjects ? 30000 : 120000);

    return () => {
      window.clearInterval(interval);
    };
  }, [hasActiveRuntimeProjects, refreshDiagnostics]);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.dataset.themeMode = themeMode;
    document.documentElement.dataset.themeFamily = themeFamily;
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
    window.localStorage.setItem(THEME_FAMILY_STORAGE_KEY, themeFamily);
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, themeMode);
  }, [themeFamily, themeMode]);

  useEffect(() => {
    if (!isThemePickerOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (themePickerRef.current && !themePickerRef.current.contains(event.target as Node)) {
        setIsThemePickerOpen(false);
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isThemePickerOpen]);

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? presets[0] ?? null;
  const scopedProjectIds = selectedPreset && !selectedPreset.readOnly ? selectedPreset.projectIds : null;
  const visibleProjects = scopedProjectIds
    ? projects.filter((project) => scopedProjectIds.includes(project.id))
    : projects;

  useEffect(() => {
    const nextSelectedProjectId =
      visibleProjects.find((project) => project.id === selectedProjectId)?.id ??
      visibleProjects[0]?.id ??
      null;

    if (nextSelectedProjectId !== selectedProjectId) {
      selectProject(nextSelectedProjectId);
    }
  }, [selectProject, selectedProjectId, visibleProjects]);

  const selectedProject = visibleProjects.find((project) => project.id === selectedProjectId) ?? null;
  const conflictedProjectIds = detectPortConflicts(visibleProjects);
  const projectResources = toProjectResourceMap(diagnostics?.projectResources);
  const runningCount = projects.filter((project) => project.status === "running" || project.status === "ready").length;
  const enabledCount = projects.filter((project) => project.enabled).length;
  const defaultRoot = settings.defaultRoots[0] ?? getDefaultRoot();
  const activeTheme = THEME_DEFINITIONS.find((theme) => theme.id === themeFamily) ?? THEME_DEFINITIONS[0];
  const quickProfiles = buildQuickProfiles(visibleProjects, selectedProject?.id ?? selectedProjectId);
  const freeMemoryTone = diagnostics && diagnostics.freePhysicalMemoryMb < 4096 ? "text-danger" : "text-textStrong";
  const topExternalNodes = diagnostics?.untrackedNodeProcesses.slice(0, 3) ?? [];
  const trackedWorkingSetMb = diagnostics?.projectResources.reduce((sum, entry) => sum + entry.totalNodeWorkingSetMb, 0) ?? 0;
  const visibleProjectIds = visibleProjects.map((project) => project.id);
  const uiBusy = isBusy || isCatalogBatchRunning;

  const alertEntries = useMemo<AlertEntry[]>(() => {
    const entries: AlertEntry[] = [];

    if (conflictedProjectIds.size) {
      entries.push({
        id: "port-conflicts",
        tone: "warn",
        title: "Conflictos de puerto",
        description: `Hay ${conflictedProjectIds.size} proyectos visibles con puertos duplicados. Ajustalos antes de iniciar en lote.`,
      });
    }

    if (forceStartProjectIds.length) {
      entries.push({
        id: "force-start",
        tone: "warn",
        title: "Puertos ocupados",
        description: `Hay ${forceStartProjectIds.length} servicios que no arrancaron porque su puerto ya estaba tomado.`,
      });
    }

    if (forceStopProjectIds.length) {
      entries.push({
        id: "force-stop",
        tone: "danger",
        title: "Procesos pendientes de cierre",
        description: `Hay ${forceStopProjectIds.length} servicios que necesitan detencion forzada para liberar PID o puerto.`,
      });
    }

    if (topExternalNodes.length) {
      entries.push({
        id: "external-node",
        tone: "info",
        title: "Node externos pesados",
        description: topExternalNodes.map(describeNodeProcess).join(" | "),
      });
    }

    if (error) {
      entries.push({
        id: "last-error",
        tone: "danger",
        title: "Ultimo error",
        description: error,
      });
    }

    return entries;
  }, [conflictedProjectIds, error, forceStartProjectIds.length, forceStopProjectIds.length, topExternalNodes]);
  async function handleCreateWorkspace() {
    const name = workspaceNameDraft.trim();
    if (!name) {
      return;
    }

    await persistPreset({
      id: createWorkspaceId(),
      name,
      description: selectedProject ? `Workspace para ${selectedProject.name}` : "",
      sortOrder: presets.filter((preset) => !preset.readOnly).length + 1,
      readOnly: false,
      projectIds: selectedProject ? [selectedProject.id] : [],
    });
    setWorkspaceNameDraft("");
    setIsWorkspaceCreatorOpen(false);
  }

  async function handleToggleProjectPreset(presetId: string, projectId: string, enabled: boolean) {
    const preset = presets.find((entry) => entry.id === presetId);
    if (!preset || preset.readOnly) {
      return;
    }

    const projectIds = enabled
      ? [...new Set([...preset.projectIds, projectId])]
      : preset.projectIds.filter((entry) => entry !== projectId);

    await persistPreset({
      ...preset,
      projectIds,
    });
  }

  function shouldFallbackToScan(errorValue: unknown) {
    const message = errorValue instanceof Error ? errorValue.message : String(errorValue ?? "");
    const normalized = message.toLowerCase();

    return normalized.includes("no supported project metadata found") || normalized.includes("no se encontro metadata");
  }

  async function handleImportOrScanPath(rootPath: string) {
    try {
      await importProjectPath(rootPath);
    } catch (errorValue) {
      if (shouldFallbackToScan(errorValue)) {
        await scan(rootPath, false);
        return;
      }

      throw errorValue;
    }
  }

  async function handleImportProjectFromCatalog() {
    const selectedPath = await pickRootFromDialog(defaultRoot);
    if (!selectedPath) {
      return;
    }

    await handleImportOrScanPath(selectedPath);
  }

  async function applyLaunchModeToVisibleAndStart(launchMode: Project["launchMode"]) {
    if (!visibleProjects.length) {
      return;
    }

    const targetProjects = [...visibleProjects];
    const preservedSelectedProjectId = selectedProjectId;
    setIsCatalogBatchRunning(true);

    try {
      for (const project of targetProjects) {
        if (project.launchMode !== launchMode) {
          await persistProject({ ...project, launchMode }, { quiet: true });
        }
      }

      selectProject(preservedSelectedProjectId ?? targetProjects[0]?.id ?? null);
      await start(targetProjects.map((project) => project.id));
    } finally {
      setIsCatalogBatchRunning(false);
    }
  }

  function handleStartVisible() {
    if (!visibleProjectIds.length) {
      return;
    }
    void start(visibleProjectIds);
  }

  function handleStopVisible() {
    if (!visibleProjectIds.length) {
      return;
    }
    void stop(visibleProjectIds);
  }

  function handleForceStopVisible() {
    if (!visibleProjectIds.length) {
      return;
    }
    void forceStop(visibleProjectIds);
  }

  const stats = [
    { label: "Root", value: defaultRoot, wide: true },
    { label: "EN", value: String(enabledCount) },
    { label: "ON", value: String(runningCount) },
    { label: "PF", value: String(quickProfiles.length || presets.length) },
    { label: "ND", value: diagnostics ? String(diagnostics.totalNodeProcesses) : "n/a" },
    { label: "RAM", value: diagnostics ? formatMemory(diagnostics.totalNodeWorkingSetMb) : "n/a" },
    { label: "TR", value: diagnostics ? formatMemory(trackedWorkingSetMb) : "n/a" },
    { label: "FR", value: diagnostics ? formatMemory(diagnostics.freePhysicalMemoryMb) : "n/a", valueClassName: freeMemoryTone },
  ];

  return (
    <div className="h-screen overflow-hidden px-2 py-2 text-textStrong">
      <div className="mx-auto flex h-full max-w-[1900px] flex-col gap-2 overflow-hidden">
        <header className="surface-panel shrink-0 px-3 py-2.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center gap-1.5 border border-accent/35 bg-accent/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.24em] text-accent">
                  <Waves className="h-3 w-3" />
                  Back Orchestrator
                </div>
                <h1 className="truncate text-[15px] font-semibold tracking-tight text-textStrong">
                  Orquestador local de microservicios
                </h1>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {quickProfiles.length ? (
                <button
                  type="button"
                  className="surface-chip relative inline-flex h-9 w-9 items-center justify-center text-textStrong"
                  onClick={() => setIsQuickActionsOpen(true)}
                  title="Abrir acciones rapidas"
                >
                  <Boxes className="h-4 w-4" />
                  <span className="absolute -right-1 -top-1 min-w-[16px] border border-accent/35 bg-accent/10 px-1 text-[8px] font-semibold text-accent">
                    {quickProfiles.length}
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                className="surface-chip inline-flex h-9 w-9 items-center justify-center text-textStrong"
                onClick={() => setIsUsageDrawerOpen(true)}
                title="Abrir panel de uso y recursos"
              >
                <Activity className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="surface-chip relative inline-flex h-9 w-9 items-center justify-center text-textStrong"
                onClick={() => setIsAlertsDrawerOpen(true)}
                title="Abrir avisos y errores"
              >
                <TriangleAlert className={`h-4 w-4 ${alertEntries.length ? "text-warn" : "text-textStrong"}`} />
                {alertEntries.length ? (
                  <span className="absolute -right-1 -top-1 min-w-[16px] border border-warn/35 bg-warn/12 px-1 text-[8px] font-semibold text-warn">
                    {alertEntries.length}
                  </span>
                ) : null}
              </button>

              <div ref={themePickerRef} className="relative">
                <button
                  type="button"
                  className="surface-chip inline-flex h-9 w-9 items-center justify-center text-textStrong"
                  onClick={() => setIsThemePickerOpen((current) => !current)}
                  title={`Tema ${activeTheme.label} ${themeMode === "dark" ? "oscuro" : "claro"}`}
                >
                  <Palette className="h-4 w-4" />
                </button>

                {isThemePickerOpen ? (
                  <div className="surface-panel absolute right-0 top-full z-20 mt-2 w-[260px] p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-[9px] uppercase tracking-[0.2em] text-textSoft">Tema</p>
                        <p className="text-[10px] text-textMuted">{activeTheme.label} {themeMode === "dark" ? "oscuro" : "claro"}</p>
                      </div>
                      <div className="surface-chip inline-flex">
                        <button
                          type="button"
                          className={[
                            "inline-flex items-center gap-1 border-r border-line px-2 py-1 text-[10px] font-semibold transition",
                            themeMode === "light" ? "bg-accent/12 text-accent" : "bg-transparent text-textMuted hover:bg-panelSoft/72",
                          ].join(" ")}
                          onClick={() => setThemeMode("light")}
                        >
                          <SunMedium className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          className={[
                            "inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold transition",
                            themeMode === "dark" ? "bg-accent/12 text-accent" : "bg-transparent text-textMuted hover:bg-panelSoft/72",
                          ].join(" ")}
                          onClick={() => setThemeMode("dark")}
                        >
                          <MoonStar className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    <div className="mt-2 grid grid-cols-2 gap-1">
                      {THEME_DEFINITIONS.map((theme) => {
                        const isSelected = theme.id === themeFamily;
                        return (
                          <button
                            key={theme.id}
                            type="button"
                            className={[
                              "border px-2 py-1.5 text-left transition",
                              isSelected
                                ? "border-accent/45 bg-accent/10 text-textStrong shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]"
                                : "surface-chip text-textMuted hover:bg-panelSoft/80",
                            ].join(" ")}
                            onClick={() => {
                              setThemeFamily(theme.id);
                              setIsThemePickerOpen(false);
                            }}
                          >
                            <span className="flex items-center gap-1">
                              {theme.preview.map((color) => (
                                <span
                                  key={`${theme.id}-${color}`}
                                  className="h-2.5 w-2.5 border border-ink/15"
                                  style={{ backgroundColor: color }}
                                />
                              ))}
                            </span>
                            <span className="mt-1 block text-[10px] font-semibold uppercase tracking-[0.14em] text-textStrong">
                              {theme.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-thin pb-0.5">
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1 border border-accent/35 bg-accent/10 px-2 py-1.5 text-[10px] font-semibold text-accent transition hover:bg-accent/16"
                onClick={() => setIsWorkspaceCreatorOpen(true)}
                title="Crear un nuevo workspace"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                Nuevo workspace
              </button>

              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={[
                    "shrink-0 border px-2 py-1.5 text-[10px] font-semibold transition",
                    preset.id === selectedPresetId
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "surface-chip text-textMuted hover:bg-panelSoft/80",
                  ].join(" ")}
                  onClick={() => selectPreset(preset.id)}
                  title={`${preset.name} (${preset.projectIds.length})`}
                >
                  {preset.name}
                  <span className="ml-1 text-[9px] text-textSoft">{preset.projectIds.length}</span>
                </button>
              ))}
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="surface-chip inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold text-textStrong"
                onClick={() => void scan(defaultRoot, false)}
                disabled={uiBusy}
                title="Escanear root actual"
              >
                {uiBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <FolderSearch className="h-3 w-3" />}
                Escanear
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 border border-ok/40 bg-ok/12 px-2 py-1.5 text-[11px] font-semibold text-ok disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void start(scopedProjectIds ?? undefined)}
                disabled={uiBusy}
                title={selectedPreset && !selectedPreset.readOnly ? `Iniciar ${selectedPreset.name}` : "Iniciar habilitados"}
              >
                <Play className="h-3 w-3" />
                Iniciar
              </button>
              <button
                type="button"
                className="surface-chip inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold text-textStrong disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void stop(scopedProjectIds ?? undefined)}
                disabled={uiBusy}
                title={selectedPreset && !selectedPreset.readOnly ? `Detener ${selectedPreset.name}` : "Detener servicios"}
              >
                <Square className="h-3 w-3" />
                Detener
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 border border-danger/40 bg-danger/12 px-2 py-1.5 text-[11px] font-semibold text-danger disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void forceStop(scopedProjectIds ?? undefined)}
                disabled={uiBusy}
                title={selectedPreset && !selectedPreset.readOnly ? `Forzar ${selectedPreset.name}` : "Forzar detencion"}
              >
                <TriangleAlert className="h-3 w-3" />
                Forzar
              </button>
              {forceStartProjectIds.length ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 border border-warn/40 bg-warn/12 px-2 py-1.5 text-[11px] font-semibold text-warn"
                  onClick={() => void forceStart()}
                  disabled={uiBusy}
                  title="Liberar puertos ocupados y volver a iniciar"
                >
                  <Rocket className="h-3 w-3" />
                  Reintentar ({forceStartProjectIds.length})
                </button>
              ) : null}
              {!selectedPreset?.readOnly ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 border border-danger/35 bg-danger/10 px-2 py-1.5 text-[10px] font-semibold text-danger"
                  onClick={() => void removePreset(selectedPreset.id)}
                  disabled={uiBusy}
                  title="Eliminar workspace actual"
                >
                  <Trash2 className="h-3 w-3" />
                  Cerrar tab
                </button>
              ) : null}
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          <WorkspaceLayout
            projects={visibleProjects}
            selectedProjectId={selectedProjectId}
            conflictedProjectIds={conflictedProjectIds}
            forceStopProjectIds={forceStopProjectIds}
            forceStartProjectIds={forceStartProjectIds}
            projectResources={projectResources}
            selectedProject={selectedProject}
            selectedProjectMessage={selectedProjectMessage}
            presets={presets}
            onSelectProject={selectProject}
            onToggleEnabled={(project, enabled) => void persistProject({ ...project, enabled })}
            onToggleWaitForPreviousReady={(project, enabled) =>
              void persistProject({ ...project, waitForPreviousReady: enabled })
            }
            onReorderProjects={(orderedProjectIds) => void reorderProjects(orderedProjectIds)}
            onStartProject={(projectId) => void start([projectId])}
            onStopProject={(projectId) => void stop([projectId])}
            onForceStopProject={(projectId) => void forceStop([projectId])}
            onForceStartProject={(projectId) => void forceStart([projectId])}
            onImportProject={handleImportProjectFromCatalog}
            onOpenScanDialog={() => setScanOpen(true)}
            onBulkStartVisible={handleStartVisible}
            onBulkStartVisibleAsMode={(launchMode) => void applyLaunchModeToVisibleAndStart(launchMode)}
            onBulkStopVisible={handleStopVisible}
            onBulkForceStopVisible={handleForceStopVisible}
            onSaveProject={persistProject}
            onDeleteProject={removeProject}
            onDeleteProjectFromList={(projectId) => void removeProject(projectId)}
            onToggleProjectPreset={(presetId, projectId, enabled) => void handleToggleProjectPreset(presetId, projectId, enabled)}
            isBusy={uiBusy}
          />
        </div>
      </div>

      <ScanDialog
        open={isScanOpen}
        busy={uiBusy}
        defaultRoot={defaultRoot}
        detectedProjects={detectedProjects}
        onOpenChange={setScanOpen}
        onPickRoot={(initialPath) => pickRootFromDialog(initialPath ?? defaultRoot)}
        onScan={scan}
        onImport={importDetected}
        onImportSingle={(rootPath) => handleImportOrScanPath(rootPath)}
      />
      <CenterModal
        open={isWorkspaceCreatorOpen}
        onOpenChange={setIsWorkspaceCreatorOpen}
        title="Nuevo workspace"
        description="La primera pestana ahora funciona como punto rapido para crear workspaces sin ocupar altura fija arriba."
      >
        <div className="grid gap-3">
          <label className="space-y-2">
            <span className="text-[10px] uppercase tracking-[0.18em] text-textSoft">Nombre</span>
            <input
              className="surface-chip w-full px-3 py-3 text-[12px] text-textStrong"
              placeholder="Nuevo workspace"
              value={workspaceNameDraft}
              onChange={(event) => setWorkspaceNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleCreateWorkspace();
                }
              }}
            />
          </label>
          <div className="surface-panel-soft px-3 py-3 text-[11px] text-textMuted">
            {selectedProject
              ? `Se va a crear con ${selectedProject.name} precargado para que puedas arrancar mas rapido.`
              : "Se crea vacio y luego puedes agregar proyectos desde el detalle de cada servicio."}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="surface-chip px-3 py-2 text-[11px] font-semibold text-textStrong"
              onClick={() => setIsWorkspaceCreatorOpen(false)}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 border border-accent/40 bg-accent/10 px-3 py-2 text-[11px] font-semibold text-accent"
              onClick={() => void handleCreateWorkspace()}
              disabled={uiBusy || !workspaceNameDraft.trim()}
            >
              <FolderPlus className="h-3.5 w-3.5" />
              Crear workspace
            </button>
          </div>
        </div>
      </CenterModal>

      <CenterModal
        open={isQuickActionsOpen}
        onOpenChange={setIsQuickActionsOpen}
        title="Acciones rapidas"
        description="El bloque de Rapido ahora vive aqui para liberar espacio del catalogo sin perder accesos directos."
      >
        {quickProfiles.length ? (
          <div className="grid gap-2 md:grid-cols-2">
            {quickProfiles.map((profile) => {
              const Icon = quickProfileIcon(profile.id);
              return (
                <button
                  key={profile.id}
                  type="button"
                  className="border border-accent/35 bg-accent/10 px-3 py-3 text-left text-accent transition hover:bg-accent/16"
                  onClick={() => {
                    setIsQuickActionsOpen(false);
                    void start(profile.projectIds);
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em]">
                      <Icon className="h-4 w-4" />
                      {profile.label}
                    </span>
                    <span className="surface-chip px-1.5 py-0.5 text-[9px] text-textStrong">{profile.projectIds.length}</span>
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-accent/80">{profile.description}</p>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="surface-panel-soft px-4 py-6 text-[11px] text-textMuted">
            No hay perfiles rapidos disponibles para la vista actual.
          </div>
        )}
      </CenterModal>

      <DrawerPanel
        open={isUsageDrawerOpen}
        onOpenChange={setIsUsageDrawerOpen}
        title="Uso y recursos"
        description="Resumen compacto del root, conteos y diagnosticos para que el catalogo tenga mas aire."
        actions={
          <button
            type="button"
            className="surface-chip inline-flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-textStrong"
            onClick={() => void refreshDiagnostics()}
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className={[
                "surface-panel-soft px-3 py-3",
                stat.wide ? "sm:col-span-2" : "",
              ].join(" ")}
            >
              <p className="text-[9px] uppercase tracking-[0.18em] text-textSoft">{stat.label}</p>
              <p className={["mt-1 text-[12px] font-semibold", stat.valueClassName ?? "text-textStrong"].join(" ")} title={stat.value}>
                {stat.value}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-4 grid gap-3">
          <div className="surface-panel-soft px-3 py-3 text-[11px] text-textMuted">
            <p className="text-[9px] uppercase tracking-[0.18em] text-textSoft">Diagnostico</p>
            <p className="mt-1 text-textStrong">
              {diagnostics
                ? `Memoria total ${formatMemory(diagnostics.totalPhysicalMemoryMb)} � libre ${formatMemory(diagnostics.freePhysicalMemoryMb)}.`
                : "Todavia no hay diagnostico disponible."}
            </p>
          </div>

          {diagnostics?.topNodeProcesses.length ? (
            <div className="surface-panel-soft px-3 py-3">
              <p className="text-[9px] uppercase tracking-[0.18em] text-textSoft">Top node</p>
              <div className="mt-2 grid gap-2">
                {diagnostics.topNodeProcesses.slice(0, 6).map((process) => (
                  <div key={`${process.pid}-${process.command}`} className="border border-line/60 px-2 py-2 text-[11px] text-textMuted">
                    {describeNodeProcess(process)}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </DrawerPanel>

      <DrawerPanel
        open={isAlertsDrawerOpen}
        onOpenChange={setIsAlertsDrawerOpen}
        title="Avisos y errores"
        description="Los warnings y errores suben aqui para dejar mas altura util al catalogo."
      >
        {alertEntries.length ? (
          <div className="grid gap-2">
            {alertEntries.map((entry) => (
              <article key={entry.id} className={["border px-3 py-3", alertCardTone(entry.tone)].join(" ")}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em]">{entry.title}</p>
                <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-current/80">{entry.description}</p>
              </article>
            ))}
          </div>
        ) : (
          <div className="surface-panel-soft px-4 py-6 text-[11px] text-textMuted">
            No hay avisos activos en este momento.
          </div>
        )}
      </DrawerPanel>

      {isLoading ? (
        <div className="fixed inset-0 flex items-center justify-center bg-ink/58 backdrop-blur-sm">
          <div className="surface-panel inline-flex items-center gap-2 px-3 py-2 text-[11px] text-textStrong">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Cargando snapshot local...
          </div>
        </div>
      ) : null}
    </div>
  );
}
