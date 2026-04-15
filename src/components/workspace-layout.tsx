import { GripVertical, RotateCcw, TerminalSquare } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { Preset, Project, ProjectResourceUsage } from "../lib/types";
import { LogConsole } from "./log-console";
import { ProjectDetail } from "./project-detail";
import { ProjectList } from "./project-list";

type WorkspacePanelId = "catalog" | "detail" | "console";
type WorkspaceZoneId = "left" | "main" | "right" | "bottom";
type ResizeTarget = "left" | "right" | "bottom";

type LayoutState = {
  zones: Record<WorkspaceZoneId, WorkspacePanelId[]>;
  active: Record<WorkspaceZoneId, WorkspacePanelId | null>;
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
};

type Props = {
  projects: Project[];
  selectedProjectId: string | null;
  conflictedProjectIds: Set<string>;
  forceStopProjectIds: string[];
  forceStartProjectIds: string[];
  projectResources: Record<string, ProjectResourceUsage>;
  selectedProject: Project | null;
  selectedProjectMessage: string | null;
  onSelectProject: (projectId: string) => void;
  onToggleEnabled: (project: Project, enabled: boolean) => void;
  onToggleWaitForPreviousReady: (project: Project, enabled: boolean) => void;
  onReorderProjects: (orderedProjectIds: string[]) => void;
  onStartProject: (projectId: string) => void;
  onStopProject: (projectId: string) => void;
  onForceStopProject: (projectId: string) => void;
  onForceStartProject: (projectId: string) => void;
  onImportProject: () => Promise<void>;
  onOpenScanDialog: () => void;
  onBulkStartVisible: () => void;
  onBulkStartVisibleAsMode: (launchMode: Project["launchMode"]) => void;
  onBulkStopVisible: () => void;
  onBulkForceStopVisible: () => void;
  onSaveProject: (project: Project, options?: { quiet?: boolean }) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onDeleteProjectFromList: (projectId: string) => void;
  presets: Preset[];
  onToggleProjectPreset: (presetId: string, projectId: string, enabled: boolean) => void;
  isBusy: boolean;
};

const LAYOUT_STORAGE_KEY = "back-orchestrator.workspace-layout.vscode";
const LEGACY_LAYOUT_STORAGE_KEY = "back-orchestrator.workspace-layout";
const PANEL_IDS: WorkspacePanelId[] = ["catalog", "detail", "console"];
const ZONE_IDS: WorkspaceZoneId[] = ["left", "main", "right", "bottom"];
const MIN_SIDE_WIDTH = 0.08;
const MAX_SIDE_WIDTH = 0.68;
const MIN_CENTER_WIDTH = 0.12;
const MIN_BOTTOM_HEIGHT = 0.12;
const MAX_BOTTOM_HEIGHT = 0.82;

const panelLabels: Record<WorkspacePanelId, string> = {
  catalog: "Catalogo",
  detail: "Detalle",
  console: "Consola",
};

const zoneLabels: Record<WorkspaceZoneId, string> = {
  left: "Izquierda",
  main: "Centro",
  right: "Derecha",
  bottom: "Abajo",
};


const preferredZoneByPanel: Record<WorkspacePanelId, WorkspaceZoneId> = {
  catalog: "left",
  detail: "main",
  console: "bottom",
};

const defaultLayout: LayoutState = {
  zones: {
    left: ["catalog"],
    main: ["detail"],
    right: [],
    bottom: ["console"],
  },
  active: {
    left: "catalog",
    main: "detail",
    right: null,
    bottom: "console",
  },
  leftWidth: 0.25,
  rightWidth: 0.22,
  bottomHeight: 0.3,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isPanelId(value: unknown): value is WorkspacePanelId {
  return value === "catalog" || value === "detail" || value === "console";
}


function normalizeLayout(input?: Partial<LayoutState> | null): LayoutState {
  const zones: Record<WorkspaceZoneId, WorkspacePanelId[]> = {
    left: [],
    main: [],
    right: [],
    bottom: [],
  };

  if (input && "zones" in input && input.zones) {
    const seen = new Set<WorkspacePanelId>();
    for (const zoneId of ZONE_IDS) {
      const nextPanels = Array.isArray(input.zones[zoneId]) ? input.zones[zoneId] : [];
      zones[zoneId] = nextPanels.filter((panelId): panelId is WorkspacePanelId => {
        if (!isPanelId(panelId) || seen.has(panelId)) {
          return false;
        }
        seen.add(panelId);
        return true;
      });
    }
  } else if (input && "slots" in input && input.slots) {
    const legacySlots = input.slots as Partial<Record<string, unknown>>;
    const legacyMapping: Record<string, WorkspaceZoneId> = {
      primary: "left",
      secondary: "main",
      bottom: "bottom",
    };
    const seen = new Set<WorkspacePanelId>();
    for (const [legacySlotId, zoneId] of Object.entries(legacyMapping)) {
      const panelId = legacySlots[legacySlotId];
      if (isPanelId(panelId) && !seen.has(panelId)) {
        zones[zoneId].push(panelId);
        seen.add(panelId);
      }
    }
  }

  const assignedPanels = new Set(Object.values(zones).flat());
  for (const panelId of PANEL_IDS) {
    if (!assignedPanels.has(panelId)) {
      zones[preferredZoneByPanel[panelId]].push(panelId);
    }
  }

  const active: Record<WorkspaceZoneId, WorkspacePanelId | null> = {
    left: null,
    main: null,
    right: null,
    bottom: null,
  };

  for (const zoneId of ZONE_IDS) {
    const preferred = input?.active?.[zoneId];
    active[zoneId] = preferred && zones[zoneId].includes(preferred) ? preferred : zones[zoneId][0] ?? null;
  }

  return {
    zones,
    active,
    leftWidth: clamp(input?.leftWidth ?? defaultLayout.leftWidth, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH),
    rightWidth: clamp(input?.rightWidth ?? defaultLayout.rightWidth, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH),
    bottomHeight: clamp(input?.bottomHeight ?? defaultLayout.bottomHeight, MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT),
  };
}

function loadInitialLayout(): LayoutState {
  if (typeof window === "undefined") {
    return defaultLayout;
  }

  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return defaultLayout;
    }
    return normalizeLayout(JSON.parse(raw) as Partial<LayoutState>);
  } catch {
    return defaultLayout;
  }
}

function zoneSize(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function movePanel(current: LayoutState, panelId: WorkspacePanelId, targetZoneId: WorkspaceZoneId): LayoutState {
  const nextZones: Record<WorkspaceZoneId, WorkspacePanelId[]> = {
    left: [...current.zones.left],
    main: [...current.zones.main],
    right: [...current.zones.right],
    bottom: [...current.zones.bottom],
  };
  const nextActive = { ...current.active };

  for (const zoneId of ZONE_IDS) {
    if (!nextZones[zoneId].includes(panelId)) {
      continue;
    }
    nextZones[zoneId] = nextZones[zoneId].filter((currentPanelId) => currentPanelId !== panelId);
    if (nextActive[zoneId] === panelId) {
      nextActive[zoneId] = nextZones[zoneId][0] ?? null;
    }
  }

  nextZones[targetZoneId] = [...nextZones[targetZoneId], panelId];
  nextActive[targetZoneId] = panelId;

  return {
    ...current,
    zones: nextZones,
    active: nextActive,
  };
}

export function WorkspaceLayout({
  projects,
  selectedProjectId,
  conflictedProjectIds,
  forceStopProjectIds,
  forceStartProjectIds,
  projectResources,
  selectedProject,
  selectedProjectMessage,
  onSelectProject,
  onToggleEnabled,
  onToggleWaitForPreviousReady,
  onReorderProjects,
  onStartProject,
  onStopProject,
  onForceStopProject,
  onForceStartProject,
  onImportProject,
  onOpenScanDialog,
  onBulkStartVisible,
  onBulkStartVisibleAsMode,
  onBulkStopVisible,
  onBulkForceStopVisible,
  onSaveProject,
  onDeleteProject,
  onDeleteProjectFromList,
  presets,
  onToggleProjectPreset,
  isBusy,
}: Props) {
  const [layout, setLayout] = useState<LayoutState>(loadInitialLayout);
  const [dropZoneId, setDropZoneId] = useState<WorkspaceZoneId | null>(null);
  const [dragPanelId, setDragPanelId] = useState<WorkspacePanelId | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const topRowRef = useRef<HTMLDivElement | null>(null);
  const dragPanelRef = useRef<WorkspacePanelId | null>(null);
  const resizeStateRef = useRef<{
    target: ResizeTarget;
    startValue: number;
    startPointer: number;
    containerSize: number;
  } | null>(null);

  useEffect(() => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  }, [layout]);

  useEffect(() => {
    function resetPointerUi() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    function handlePointerMove(event: PointerEvent) {
      const resizeState = resizeStateRef.current;
      if (resizeState) {
        const delta = (event[resizeState.target === "bottom" ? "clientY" : "clientX"] - resizeState.startPointer) / resizeState.containerSize;
        setLayout((current) => {
          if (resizeState.target === "bottom") {
            return {
              ...current,
              bottomHeight: clamp(resizeState.startValue - delta, MIN_BOTTOM_HEIGHT, MAX_BOTTOM_HEIGHT),
            };
          }

          if (resizeState.target === "left") {
            const maxLeftWidth = current.zones.right.length > 0 ? 1 - MIN_CENTER_WIDTH - current.rightWidth : 1 - MIN_CENTER_WIDTH;
            return {
              ...current,
              leftWidth: clamp(resizeState.startValue + delta, MIN_SIDE_WIDTH, Math.min(MAX_SIDE_WIDTH, maxLeftWidth)),
            };
          }

          const maxRightWidth = current.zones.left.length > 0 ? 1 - MIN_CENTER_WIDTH - current.leftWidth : 1 - MIN_CENTER_WIDTH;
          return {
            ...current,
            rightWidth: clamp(resizeState.startValue - delta, MIN_SIDE_WIDTH, Math.min(MAX_SIDE_WIDTH, maxRightWidth)),
          };
        });
        return;
      }

      if (!dragPanelRef.current) {
        return;
      }

      setDropZoneId(resolveZoneIdFromPoint(event.clientX, event.clientY));
    }

    function handlePointerUp(event: PointerEvent) {
      if (resizeStateRef.current) {
        resizeStateRef.current = null;
        resetPointerUi();
        return;
      }

      const panelId = dragPanelRef.current;
      if (panelId) {
        const zoneId = resolveZoneIdFromPoint(event.clientX, event.clientY);
        if (zoneId) {
          setLayout((current) => movePanel(current, panelId, zoneId));
        }
        clearDragState();
      }

      resetPointerUi();
    }

    function handlePointerCancel() {
      resizeStateRef.current = null;
      clearDragState();
      resetPointerUi();
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, []);

  const panelRegistry = useMemo<Record<WorkspacePanelId, ReactNode>>(
    () => ({
      catalog: (
        <ProjectList
          projects={projects}
          selectedProjectId={selectedProjectId}
          conflictedProjectIds={conflictedProjectIds}
          forceStopProjectIds={forceStopProjectIds}
          forceStartProjectIds={forceStartProjectIds}
          projectResources={projectResources}
          onSelect={onSelectProject}
          onToggleEnabled={onToggleEnabled}
          onToggleWaitForPreviousReady={onToggleWaitForPreviousReady}
          onReorderProjects={onReorderProjects}
          onStartProject={onStartProject}
          onStopProject={onStopProject}
          onForceStopProject={onForceStopProject}
          onForceStartProject={onForceStartProject}
          onDeleteProject={onDeleteProjectFromList}
          onImportProject={onImportProject}
          onOpenScanDialog={onOpenScanDialog}
          onBulkStartVisible={onBulkStartVisible}
          onBulkStartVisibleAsMode={onBulkStartVisibleAsMode}
          onBulkStopVisible={onBulkStopVisible}
          onBulkForceStopVisible={onBulkForceStopVisible}
          isBusy={isBusy}
        />
      ),
      detail: (
        <ProjectDetail
          project={selectedProject}
          resourceUsage={selectedProject ? projectResources[selectedProject.id] ?? null : null}
          runtimeMessage={selectedProjectMessage}
          allProjects={projects}
          canForceStop={selectedProject ? forceStopProjectIds.includes(selectedProject.id) : false}
          canForceStart={selectedProject ? forceStartProjectIds.includes(selectedProject.id) : false}
          presets={presets}
          onToggleProjectPreset={onToggleProjectPreset}
          onSave={onSaveProject}
          onStart={(projectId) => Promise.resolve(onStartProject(projectId))}
          onStop={(projectId) => Promise.resolve(onStopProject(projectId))}
          onForceStop={(projectId) => Promise.resolve(onForceStopProject(projectId))}
          onForceStart={(projectId) => Promise.resolve(onForceStartProject(projectId))}
          onDelete={onDeleteProject}
        />
      ),
      console: <LogConsole projects={projects} selectedProjectId={selectedProjectId} />,
    }),
    [
      conflictedProjectIds,
      forceStopProjectIds,
      forceStartProjectIds,
      onDeleteProject,
      onForceStopProject,
      onForceStartProject,
      onImportProject,
      onOpenScanDialog,
      onBulkStartVisible,
      onBulkStartVisibleAsMode,
      onBulkStopVisible,
      onBulkForceStopVisible,
      onDeleteProjectFromList,
      onReorderProjects,
      onSaveProject,
      isBusy,
      onSelectProject,
      onStartProject,
      onStopProject,
      onToggleWaitForPreviousReady,
      onToggleEnabled,
      projectResources,
      projects,
      presets,
      selectedProject,
      selectedProjectId,
      selectedProjectMessage,
      onToggleProjectPreset,
    ],
  );

  const hasLeftZone = layout.zones.left.length > 0;
  const hasRightZone = layout.zones.right.length > 0;
  const hasBottomZone = layout.zones.bottom.length > 0;

  function findPanelZone(panelId: WorkspacePanelId) {
    return ZONE_IDS.find((zoneId) => layout.zones[zoneId].includes(panelId)) ?? null;
  }

  function resolveZoneIdFromPoint(clientX: number, clientY: number) {
    const element = document.elementFromPoint(clientX, clientY);
    const zoneElement = element instanceof HTMLElement ? element.closest<HTMLElement>("[data-workspace-zone]") : null;
    const zoneId = zoneElement?.dataset.workspaceZone;
    return ZONE_IDS.includes(zoneId as WorkspaceZoneId) ? (zoneId as WorkspaceZoneId) : null;
  }

  function setActivePanel(zoneId: WorkspaceZoneId, panelId: WorkspacePanelId) {
    setLayout((current) => ({
      ...current,
      active: {
        ...current.active,
        [zoneId]: panelId,
      },
    }));
  }

  function focusPanel(panelId: WorkspacePanelId) {
    if (panelId === "console") {
      showConsole();
      return;
    }

    const zoneId = findPanelZone(panelId);
    if (!zoneId) {
      setLayout((current) => movePanel(current, panelId, preferredZoneByPanel[panelId]));
      return;
    }

    setLayout((current) => ({
      ...current,
      active: {
        ...current.active,
        [zoneId]: panelId,
      },
    }));
  }

  function movePanelToZone(panelId: WorkspacePanelId, targetZoneId: WorkspaceZoneId) {
    setLayout((current) => movePanel(current, panelId, targetZoneId));
  }

  function clearDragState() {
    dragPanelRef.current = null;
    setDragPanelId(null);
    setDropZoneId(null);
  }

  function resetLayout() {
    window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_LAYOUT_STORAGE_KEY);
    clearDragState();
    setLayout(defaultLayout);
  }

  function showConsole() {
    setLayout((current) => ({
      ...movePanel(current, "console", "bottom"),
      bottomHeight: Math.max(current.bottomHeight, 0.34),
    }));
  }

  function startResize(target: ResizeTarget, event: ReactPointerEvent<HTMLDivElement>) {
    const container = target === "bottom" ? workspaceRef.current : topRowRef.current;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    resizeStateRef.current = {
      target,
      startValue: target === "left" ? layout.leftWidth : target === "right" ? layout.rightWidth : layout.bottomHeight,
      startPointer: target === "bottom" ? event.clientY : event.clientX,
      containerSize: target === "bottom" ? rect.height : rect.width,
    };

    document.body.style.cursor = target === "bottom" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    event.preventDefault();
  }

  function startPanelDrag(panelId: WorkspacePanelId, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }

    dragPanelRef.current = panelId;
    setDragPanelId(panelId);
    setDropZoneId(findPanelZone(panelId));
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  }

  function renderZone(zoneId: WorkspaceZoneId) {
    const panels = layout.zones[zoneId];
    const activePanelId = layout.active[zoneId];
    const resolvedPanelId = activePanelId && panels.includes(activePanelId) ? activePanelId : panels[0] ?? null;
    const isDropTarget = dropZoneId === zoneId && dragPanelId != null;

    return (
      <section
        data-workspace-zone={zoneId}
        className={[
          "surface-panel-soft relative flex h-full min-h-0 flex-col overflow-hidden transition-[background,box-shadow,border-color] duration-150",
          dragPanelId ? "border border-dashed border-line/70" : "",
          isDropTarget ? "bg-accent/10 shadow-[inset_0_0_0_1px_rgba(35,213,246,0.32),0_0_0_1px_rgba(35,213,246,0.18)]" : "",
        ].join(" ")}
      >
        <div className="surface-divider flex items-center justify-between gap-2 bg-panelSoft/46 px-2 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-thin">
            {panels.length ? panels.map((panelId) => {
              const isActive = panelId === resolvedPanelId;
              return (
                <button
                  key={`${zoneId}-${panelId}`}
                  type="button"
                  onPointerDown={(event) => startPanelDrag(panelId, event)}
                  onClick={() => setActivePanel(zoneId, panelId)}
                  className={[
                    "inline-flex shrink-0 cursor-grab items-center gap-1 border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] transition active:cursor-grabbing",
                    isActive
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-line bg-panel/55 text-textMuted hover:bg-panelSoft/75",
                    dragPanelId === panelId ? "opacity-70" : "",
                  ].join(" ")}
                  title={`Arrastra ${panelLabels[panelId]} a otra zona`}
                >
                  <GripVertical className="h-2.5 w-2.5" />
                  {panelLabels[panelId]}
                </button>
              );
            }) : <span className="px-1 text-[9px] uppercase tracking-[0.16em] text-textSoft">Zona libre</span>}
          </div>
          <div className="hidden shrink-0 items-center gap-2 md:flex">
            {dragPanelId ? (
              <span className={[
                "text-[9px] font-semibold uppercase tracking-[0.14em]",
                isDropTarget ? "text-accent" : "text-textSoft",
              ].join(" ")}>
                {isDropTarget ? `Suelta ${panelLabels[dragPanelId]} aqui` : zoneLabels[zoneId]}
              </span>
            ) : (
              <span className="text-[9px] uppercase tracking-[0.14em] text-textSoft">
                Arrastra y suelta
              </span>
            )}
          </div>
        </div>
        {dragPanelId ? (
          <div className="pointer-events-none absolute inset-x-3 top-10 z-10 flex justify-end">
            <span className={[
              "rounded-full border px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em] shadow-[0_12px_28px_-18px_rgba(2,8,20,0.9)] backdrop-blur",
              isDropTarget
                ? "border-accent/45 bg-accent/14 text-accent"
                : "border-line/80 bg-panel/82 text-textMuted",
            ].join(" ")}>
              {isDropTarget
                ? `Mover ${panelLabels[dragPanelId]} a ${zoneLabels[zoneId].toLowerCase()}`
                : `Suelta en ${zoneLabels[zoneId].toLowerCase()}`}
            </span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">
          {resolvedPanelId ? panelRegistry[resolvedPanelId] : (
            <div className="flex h-full min-h-0 items-center justify-center bg-panel/45 px-4 text-[11px] text-textSoft">
              Arrastra un panel aqui para fijarlo en {zoneLabels[zoneId].toLowerCase()}.
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <div ref={workspaceRef} className="surface-panel-soft flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-1">
        <div ref={topRowRef} className="flex min-h-0 flex-1 overflow-hidden gap-1">
          {hasLeftZone ? (
            <div className="min-h-0 shrink-0 overflow-hidden" style={{ width: zoneSize(layout.leftWidth) }}>
              {renderZone("left")}
            </div>
          ) : null}

          {hasLeftZone ? (
            <div
              className="group flex w-2.5 shrink-0 cursor-col-resize items-center justify-center rounded-full bg-panelSoft/30 transition hover:bg-accent/20 active:bg-accent/28"
              onPointerDown={(event) => startResize("left", event)}
              title="Redimensionar zona izquierda"
            >
              <div className="h-12 w-0.5 rounded-full bg-line/70 transition group-hover:h-16 group-hover:bg-accent/55" />
            </div>
          ) : null}

          <div className="min-w-0 min-h-0 flex-1 overflow-hidden">
            {renderZone("main")}
          </div>

          {hasRightZone ? (
            <div
              className="group flex w-2.5 shrink-0 cursor-col-resize items-center justify-center rounded-full bg-panelSoft/30 transition hover:bg-accent/20 active:bg-accent/28"
              onPointerDown={(event) => startResize("right", event)}
              title="Redimensionar zona derecha"
            >
              <div className="h-12 w-0.5 rounded-full bg-line/70 transition group-hover:h-16 group-hover:bg-accent/55" />
            </div>
          ) : null}

          {hasRightZone ? (
            <div className="min-h-0 shrink-0 overflow-hidden" style={{ width: zoneSize(layout.rightWidth) }}>
              {renderZone("right")}
            </div>
          ) : null}
        </div>

        {hasBottomZone ? (
          <div
            className="group flex h-2.5 shrink-0 cursor-row-resize items-center justify-center rounded-full bg-panelSoft/30 transition hover:bg-accent/20 active:bg-accent/28"
            onPointerDown={(event) => startResize("bottom", event)}
            title="Redimensionar zona inferior"
          >
            <div className="h-0.5 w-14 rounded-full bg-line/70 transition group-hover:w-20 group-hover:bg-accent/55" />
          </div>
        ) : null}

        {hasBottomZone ? (
          <div className="min-h-0 shrink-0 overflow-hidden" style={{ height: zoneSize(layout.bottomHeight) }}>
            {renderZone("bottom")}
          </div>
        ) : null}
      </div>
    </div>
  );
}





