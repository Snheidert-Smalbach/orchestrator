import { Boxes, FolderPlus, GitBranch, LoaderCircle, Monitor, Rocket, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AlertsDrawer } from "./components/alerts-drawer";
import { AppHeader } from "./components/app-header";
import { ScanDialog } from "./components/scan-dialog";
import { ServiceTopologyStandaloneWindow } from "./components/service-topology-modal";
import { UsageDrawer, type UsageStat } from "./components/usage-drawer";
import { WorkspaceLayout } from "./components/workspace-layout";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { DialogShell } from "./components/ui/dialog-shell";
import { EmptyState } from "./components/ui/empty-state";
import { FieldHint, FieldLabel, FieldLabelWrap } from "./components/ui/field";
import { Input } from "./components/ui/input";
import {
  buildQuickProfiles,
  createWorkspaceId,
  DEFAULT_THEME_FAMILY,
  describeNodeProcess,
  detectPortConflicts,
  formatMemory,
  LEGACY_THEME_STORAGE_KEY,
  resolveInitialThemeFamily,
  resolveInitialThemeMode,
  THEME_DEFINITIONS,
  THEME_FAMILY_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
  toProjectResourceMap,
  type AlertEntry,
  type QuickProfile,
  type ThemeMode,
} from "./lib/app-shell";
import { getDefaultRoot, pickRootFromDialog } from "./lib/tauri";
import type { Project } from "./lib/types";
import { useAppStore } from "./store/useAppStore";

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

export default function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(resolveInitialThemeMode);
  const [themeFamily, setThemeFamily] = useState(resolveInitialThemeFamily);
  const topologyWindowParams =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const isTopologyWindow = topologyWindowParams?.get("topology") === "1";
  const topologyFocusProjectId = topologyWindowParams?.get("focusProjectId");

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.dataset.themeMode = themeMode;
    document.documentElement.dataset.themeFamily = themeFamily;
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
    window.localStorage.setItem(THEME_FAMILY_STORAGE_KEY, themeFamily);
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, themeMode);
  }, [themeFamily, themeMode]);

  if (isTopologyWindow) {
    return <ServiceTopologyStandaloneWindow focusProjectId={topologyFocusProjectId} />;
  }

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

  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [isWorkspaceCreatorOpen, setIsWorkspaceCreatorOpen] = useState(false);
  const [isUsageDrawerOpen, setIsUsageDrawerOpen] = useState(false);
  const [isQuickActionsOpen, setIsQuickActionsOpen] = useState(false);
  const [isAlertsDrawerOpen, setIsAlertsDrawerOpen] = useState(false);
  const [isCatalogBatchRunning, setIsCatalogBatchRunning] = useState(false);

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

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId) ?? presets[0] ?? null;
  const scopedProjectIds = selectedPreset && !selectedPreset.readOnly ? selectedPreset.projectIds : null;
  const visibleProjects = scopedProjectIds ? projects.filter((project) => scopedProjectIds.includes(project.id)) : projects;

  useEffect(() => {
    const nextSelectedProjectId =
      visibleProjects.find((project) => project.id === selectedProjectId)?.id ?? visibleProjects[0]?.id ?? null;

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
  const activeTheme = THEME_DEFINITIONS.find((theme) => theme.id === themeFamily) ?? THEME_DEFINITIONS[0] ?? {
    id: DEFAULT_THEME_FAMILY,
    label: "Aurora",
    description: "",
    preview: ["#23d5f6", "#8bff4d", "#0f172a"] as [string, string, string],
  };
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
        description: `Hay ${conflictedProjectIds.size} proyectos visibles con puertos duplicados. Ajusta esos servicios antes de iniciar en lote.`,
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
        description: `Hay ${forceStopProjectIds.length} servicios que necesitan detención forzada para liberar PID o puerto.`,
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
        title: "Último error",
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

    const projectIds = enabled ? [...new Set([...preset.projectIds, projectId])] : preset.projectIds.filter((entry) => entry !== projectId);

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

  const stats: UsageStat[] = [
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
        <AppHeader
          presets={presets}
          selectedPresetId={selectedPresetId}
          selectedPreset={selectedPreset}
          quickProfiles={quickProfiles}
          alertCount={alertEntries.length}
          forceStartCount={forceStartProjectIds.length}
          uiBusy={uiBusy}
          activeTheme={activeTheme}
          themeMode={themeMode}
          themeFamily={themeFamily}
          themes={THEME_DEFINITIONS}
          onThemeModeChange={setThemeMode}
          onThemeFamilyChange={setThemeFamily}
          onOpenQuickActions={() => setIsQuickActionsOpen(true)}
          onOpenUsage={() => setIsUsageDrawerOpen(true)}
          onOpenAlerts={() => setIsAlertsDrawerOpen(true)}
          onCreateWorkspace={() => setIsWorkspaceCreatorOpen(true)}
          onSelectPreset={selectPreset}
          onScan={() => void scan(defaultRoot, false)}
          onStart={() => void start(scopedProjectIds ?? undefined)}
          onStop={() => void stop(scopedProjectIds ?? undefined)}
          onForceStop={() => void forceStop(scopedProjectIds ?? undefined)}
          onForceStart={() => void forceStart()}
          onRemovePreset={() => void (selectedPreset ? removePreset(selectedPreset.id) : Promise.resolve())}
        />

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
            onToggleWaitForPreviousReady={(project, enabled) => void persistProject({ ...project, waitForPreviousReady: enabled })}
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

      <DialogShell
        open={isWorkspaceCreatorOpen}
        onOpenChange={setIsWorkspaceCreatorOpen}
        title="Nuevo workspace"
        description="Crea una pestaña personalizada y, si hay un proyecto seleccionado, precárgalo para arrancar más rápido."
      >
        <div className="grid gap-4">
          <FieldLabelWrap>
            <FieldLabel>Nombre</FieldLabel>
            <Input
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
            <FieldHint>Usa un nombre corto para identificar la combinación de servicios que quieres agrupar.</FieldHint>
          </FieldLabelWrap>

          <Card tone="muted" className="p-4 text-[11px] text-textMuted">
            {selectedProject
              ? `Se va a crear con ${selectedProject.name} precargado para que puedas arrancar más rápido.`
              : "Se crea vacío y luego puedes agregar proyectos desde el detalle de cada servicio."}
          </Card>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setIsWorkspaceCreatorOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => void handleCreateWorkspace()}
              disabled={uiBusy || !workspaceNameDraft.trim()}
            >
              <FolderPlus className="h-3.5 w-3.5" />
              Crear workspace
            </Button>
          </div>
        </div>
      </DialogShell>

      <DialogShell
        open={isQuickActionsOpen}
        onOpenChange={setIsQuickActionsOpen}
        title="Acciones rápidas"
        description="Perfiles rápidos detectados para la vista actual del catálogo."
      >
        {quickProfiles.length ? (
          <div className="grid gap-2 md:grid-cols-2">
            {quickProfiles.map((profile: QuickProfile) => {
              const Icon = quickProfileIcon(profile.id);
              return (
                <Card key={profile.id} tone="accent" className="p-0">
                  <button
                    type="button"
                    className="flex w-full flex-col gap-3 px-4 py-4 text-left text-accent"
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
                      <span className="ui-badge ui-badge--secondary">{profile.projectIds.length}</span>
                    </div>
                    <p className="text-[11px] leading-5 text-accent/80">{profile.description}</p>
                  </button>
                </Card>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="Sin perfiles rápidos"
            description="No hay perfiles automáticos disponibles para el filtro o workspace que tienes activo."
          />
        )}
      </DialogShell>

      <UsageDrawer
        open={isUsageDrawerOpen}
        onOpenChange={setIsUsageDrawerOpen}
        stats={stats}
        diagnostics={diagnostics}
        onRefresh={() => void refreshDiagnostics()}
      />

      <AlertsDrawer open={isAlertsDrawerOpen} onOpenChange={setIsAlertsDrawerOpen} entries={alertEntries} />

      {isLoading ? (
        <div className="fixed inset-0 flex items-center justify-center bg-ink/58 backdrop-blur-sm">
          <div className="surface-panel inline-flex items-center gap-2 px-4 py-3 text-[11px] text-textStrong">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            Cargando snapshot local...
          </div>
        </div>
      ) : null}
    </div>
  );
}
