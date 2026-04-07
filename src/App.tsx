import { useEffect, useState } from "react";
import {
  Boxes,
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
  TriangleAlert,
  Waves,
} from "lucide-react";
import { useRef } from "react";
import { ScanDialog } from "./components/scan-dialog";
import { WorkspaceLayout } from "./components/workspace-layout";
import { pickRootFromDialog } from "./lib/tauri";
import type { ProcessDiagnostic, Project, ProjectResourceUsage } from "./lib/types";
import { useAppStore } from "./store/useAppStore";

type ThemeMode = "dark" | "light";
type ThemeFamily = "aurora" | "ember" | "harbor" | "terminal";

type ThemeDefinition = {
  id: ThemeFamily;
  label: string;
  description: string;
  preview: [string, string, string];
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

type QuickProfile = {
  id: string;
  label: string;
  description: string;
  projectIds: string[];
};

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

function buildQuickProfiles(projects: Project[], selectedProjectId: string | null) {
  const enabledProjectIds = projects.filter((project) => project.enabled).map((project) => project.id);
  const backendProjectIds = projects
    .filter((project) => project.enabled && project.rootPath.includes("\\BACK\\"))
    .map((project) => project.id);
  const frontendProjectIds = projects
    .filter((project) => project.enabled && project.rootPath.includes("\\FRONT\\"))
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
  return `PID ${process.pid} · ${formatMemory(process.workingSetMb)} · ${compactCommand(process.command)}`;
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

export default function App() {
  const settings = useAppStore((state) => state.settings);
  const projects = useAppStore((state) => state.projects);
  const presets = useAppStore((state) => state.presets);
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
  const persistProject = useAppStore((state) => state.persistProject);
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

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const conflictedProjectIds = detectPortConflicts(projects);
  const projectResources = toProjectResourceMap(diagnostics?.projectResources);
  const runningCount = projects.filter((project) => project.status === "running" || project.status === "ready").length;
  const enabledCount = projects.filter((project) => project.enabled).length;
  const defaultRoot = settings.defaultRoots[0] ?? "C:\\workspace\\apps\\BACK";
  const activeTheme = THEME_DEFINITIONS.find((theme) => theme.id === themeFamily) ?? THEME_DEFINITIONS[0];
  const quickProfiles = buildQuickProfiles(projects, selectedProjectId);
  const freeMemoryTone = diagnostics && diagnostics.freePhysicalMemoryMb < 4096 ? "text-danger" : "text-textStrong";
  const topExternalNodes = diagnostics?.untrackedNodeProcesses.slice(0, 3) ?? [];
  const trackedWorkingSetMb = diagnostics?.projectResources.reduce((sum, entry) => sum + entry.totalNodeWorkingSetMb, 0) ?? 0;

  return (
    <div className="h-screen overflow-hidden px-2 py-2 text-textStrong">
      <div className="mx-auto flex h-full max-w-[1900px] flex-col gap-2 overflow-hidden">
        <header className="surface-panel shrink-0 px-3 py-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
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
              <p className="mt-1 text-[11px] text-textMuted">
                Workspace acoplable, paneles con scroll interno y consola fija abajo. Tema activo: {activeTheme.label} {themeMode === "dark" ? "oscuro" : "claro"}, {activeTheme.description}.
              </p>
            </div>

            <div className="flex flex-wrap items-start gap-1.5">
              <div className="flex flex-wrap gap-1.5">
                <div ref={themePickerRef} className="relative">
                  <button
                    type="button"
                    className="surface-chip inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold text-textStrong"
                    onClick={() => setIsThemePickerOpen((current) => !current)}
                    title={`Tema ${activeTheme.label} ${themeMode === "dark" ? "oscuro" : "claro"}`}
                  >
                    <Palette className="h-3.5 w-3.5" />
                    <span className="flex items-center gap-1">
                      {activeTheme.preview.map((color) => (
                        <span
                          key={`${activeTheme.id}-${color}`}
                          className="h-2 w-2 border border-ink/15"
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </span>
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

                <button
                  type="button"
                  className="surface-chip inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold text-textStrong"
                  onClick={() => void scan(defaultRoot, false)}
                >
                  {isBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <FolderSearch className="h-3 w-3" />}
                  Escanear
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 border border-ok/40 bg-ok/12 px-2 py-1.5 text-[11px] font-semibold text-ok"
                  onClick={() => void start()}
                >
                  <Play className="h-3 w-3" />
                  Iniciar habilitados
                </button>
                <button
                  type="button"
                  className="surface-chip inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold text-textStrong"
                  onClick={() => void stop()}
                >
                  <Square className="h-3 w-3" />
                  Detener todo
                </button>
                <button
                  type="button"
                  className="surface-chip inline-flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold text-textStrong"
                  onClick={() => void refreshDiagnostics()}
                >
                  <RefreshCw className="h-3 w-3" />
                  Recursos
                </button>
                {forceStartProjectIds.length ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 border border-warn/40 bg-warn/12 px-2 py-1.5 text-[11px] font-semibold text-warn"
                    onClick={() => void forceStart()}
                  >
                    <Rocket className="h-3 w-3" />
                    Forzar e iniciar ({forceStartProjectIds.length})
                  </button>
                ) : null}
                {forceStopProjectIds.length ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 border border-danger/40 bg-danger/12 px-2 py-1.5 text-[11px] font-semibold text-danger"
                    onClick={() => void forceStop()}
                  >
                    <TriangleAlert className="h-3 w-3" />
                    Forzar detencion ({forceStopProjectIds.length})
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
            <div className="surface-chip max-w-[320px] truncate px-1.5 py-0.5 text-textMuted" title={defaultRoot}>
              <span className="text-textSoft">Root</span> <span className="text-textStrong">{defaultRoot}</span>
            </div>
            <div className="surface-chip px-1.5 py-0.5 text-textMuted">
              <span className="text-textSoft">EN</span> <span className="text-textStrong">{enabledCount}</span>
            </div>
            <div className="surface-chip px-1.5 py-0.5 text-textMuted">
              <span className="text-textSoft">ON</span> <span className="text-textStrong">{runningCount}</span>
            </div>
            <div className="surface-chip px-1.5 py-0.5 text-textMuted">
              <span className="text-textSoft">PF</span> <span className="text-textStrong">{quickProfiles.length || presets.length}</span>
            </div>
            {diagnostics ? (
              <>
                <div className="surface-chip px-1.5 py-0.5 text-textMuted">
                  <span className="text-textSoft">ND</span> <span className="text-textStrong">{diagnostics.totalNodeProcesses}</span>
                </div>
                <div className="surface-chip px-1.5 py-0.5 text-textMuted">
                  <span className="text-textSoft">RAM</span> <span className="text-textStrong">{formatMemory(diagnostics.totalNodeWorkingSetMb)}</span>
                </div>
                <div className="surface-chip px-1.5 py-0.5 text-textMuted">
                  <span className="text-textSoft">TR</span> <span className="text-textStrong">{formatMemory(trackedWorkingSetMb)}</span>
                </div>
                <div className="surface-chip px-1.5 py-0.5 text-textMuted">
                  <span className="text-textSoft">FR</span> <span className={freeMemoryTone}>{formatMemory(diagnostics.freePhysicalMemoryMb)}</span>
                </div>
              </>
            ) : null}
          </div>

          {quickProfiles.length ? (
            <div className="surface-panel-soft mt-2 px-2 py-1">
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[9px] uppercase tracking-[0.2em] text-textSoft">Rapido</span>
                {quickProfiles.map((profile) => {
                  const Icon = quickProfileIcon(profile.id);
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      className="relative inline-flex h-7 w-7 items-center justify-center border border-accent/35 bg-accent/10 text-accent transition hover:bg-accent/16"
                      title={`${profile.label} (${profile.projectIds.length}) · ${profile.description}`}
                      onClick={() => void start(profile.projectIds)}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span className="surface-chip absolute -right-1 -top-1 min-w-[14px] px-1 text-[8px] leading-4 text-textStrong">
                        {profile.projectIds.length}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {conflictedProjectIds.size ? (
            <div className="surface-banner-warn mt-2 px-2 py-1 text-[11px] text-warn">
              Hay conflictos de puerto entre proyectos habilitados. Ajusta esos servicios antes de iniciar en lote.
            </div>
          ) : null}
          {forceStartProjectIds.length ? (
            <div className="surface-banner-warn mt-2 px-2 py-1 text-[11px] text-warn">
              Hay servicios que no arrancaron porque su puerto ya esta ocupado. Usa Forzar e iniciar para liberar ese puerto y volver a arrancarlos.
            </div>
          ) : null}
          {forceStopProjectIds.length ? (
            <div className="surface-banner-danger mt-2 px-2 py-1 text-[11px] text-danger">
              Hay procesos que no liberaron su PID o puerto. Usa Forzar detencion para ejecutar el cierre a nivel del sistema operativo.
            </div>
          ) : null}
          {topExternalNodes.length ? (
            <div className="surface-banner-warn mt-2 px-2 py-1 text-[11px] text-warn">
              Node externos pesados: {topExternalNodes.map(describeNodeProcess).join(" | ")}
            </div>
          ) : null}
          {error ? (
            <div className="surface-banner-danger mt-2 whitespace-pre-wrap px-2 py-1 text-[11px] text-danger">
              {error}
            </div>
          ) : null}
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          <WorkspaceLayout
            projects={projects}
            selectedProjectId={selectedProjectId}
            conflictedProjectIds={conflictedProjectIds}
            forceStopProjectIds={forceStopProjectIds}
            forceStartProjectIds={forceStartProjectIds}
            projectResources={projectResources}
            selectedProject={selectedProject}
            selectedProjectMessage={selectedProjectMessage}
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
            onSaveProject={persistProject}
            onDeleteProject={removeProject}
          />
        </div>
      </div>

      <ScanDialog
        open={isScanOpen}
        busy={isBusy}
        defaultRoot={defaultRoot}
        detectedProjects={detectedProjects}
        onOpenChange={setScanOpen}
        onPickRoot={pickRootFromDialog}
        onScan={scan}
        onImport={importDetected}
      />

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
