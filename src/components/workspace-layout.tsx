import { GripVertical, RotateCcw, TerminalSquare } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { Project, ProjectResourceUsage } from "../lib/types";
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
  onSaveProject: (project: Project, options?: { quiet?: boolean }) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
};

const LAYOUT_STORAGE_KEY = "back-orchestrator.workspace-layout.vscode";
const LEGACY_LAYOUT_STORAGE_KEY = "back-orchestrator.workspace-layout";
const PANEL_IDS: WorkspacePanelId[] = ["catalog", "detail", "console"];
const ZONE_IDS: WorkspaceZoneId[] = ["left", "main", "right", "bottom"];
const MIN_SIDE_WIDTH = 0.18;
const MAX_SIDE_WIDTH = 0.38;
const MIN_CENTER_WIDTH = 0.26;
const MIN_BOTTOM_HEIGHT = 0.2;
const MAX_BOTTOM_HEIGHT = 0.58;

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

const zoneShortLabels: Record<WorkspaceZoneId, string> = {
  left: "Izq",
  main: "Ctr",
  right: "Der",
  bottom: "Abj",
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
  onSaveProject,
  onDeleteProject,
}: Props) {
  const [layout, setLayout] = useState<LayoutState>(loadInitialLayout);
  const [dropZoneId, setDropZoneId] = useState<WorkspaceZoneId | null>(null);
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
    function handlePointerMove(event: PointerEvent) {
      const resizeState = resizeStateRef.current;
      if (!resizeState) {
        return;
      }

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
    }

    function handlePointerUp() {
      resizeStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
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
      onReorderProjects,
      onSaveProject,
      onSelectProject,
      onStartProject,
      onStopProject,
      onToggleWaitForPreviousReady,
      onToggleEnabled,
      projectResources,
      projects,
      selectedProject,
      selectedProjectId,
      selectedProjectMessage,
    ],
  );

  const hasLeftZone = layout.zones.left.length > 0;
  const hasRightZone = layout.zones.right.length > 0;
  const hasBottomZone = layout.zones.bottom.length > 0;

  function findPanelZone(panelId: WorkspacePanelId) {
    return ZONE_IDS.find((zoneId) => layout.zones[zoneId].includes(panelId)) ?? null;
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

  function resetLayout() {
    window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_LAYOUT_STORAGE_KEY);
    dragPanelRef.current = null;
    setDropZoneId(null);
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

  function handleDragStart(panelId: WorkspacePanelId, event: DragEvent<HTMLButtonElement>) {
    dragPanelRef.current = panelId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", panelId);
  }

  function handleZoneDrop(zoneId: WorkspaceZoneId) {
    const panelId = dragPanelRef.current;
    if (!panelId) {
      return;
    }

    movePanelToZone(panelId, zoneId);
    dragPanelRef.current = null;
    setDropZoneId(null);
  }

  function renderZone(zoneId: WorkspaceZoneId) {
    const panels = layout.zones[zoneId];
    const activePanelId = layout.active[zoneId];
    const resolvedPanelId = activePanelId && panels.includes(activePanelId) ? activePanelId : panels[0] ?? null;

    return (
        <section
          className={[
          "surface-panel-soft flex h-full min-h-0 flex-col overflow-hidden",
          dropZoneId === zoneId ? "bg-accent/10 shadow-[inset_0_0_0_1px_rgba(35,213,246,0.22)]" : "",
        ].join(" ")}
        onDragOver={(event) => {
          event.preventDefault();
          if (dragPanelRef.current) {
            setDropZoneId(zoneId);
          }
        }}
        onDragLeave={() => {
          if (dropZoneId === zoneId) {
            setDropZoneId(null);
          }
        }}
        onDrop={() => handleZoneDrop(zoneId)}
      >
        <div className="surface-divider flex items-center justify-between gap-2 bg-panelSoft/46 px-1.5 py-1">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-thin">
            {panels.length ? panels.map((panelId) => {
              const isActive = panelId === resolvedPanelId;
              return (
                <button
                  key={`${zoneId}-${panelId}`}
                  type="button"
                  draggable
                  onDragStart={(event) => handleDragStart(panelId, event)}
                  onDragEnd={() => {
                    dragPanelRef.current = null;
                    setDropZoneId(null);
                  }}
                  onClick={() => setActivePanel(zoneId, panelId)}
                  className={[
                    "inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] transition",
                    isActive
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-line bg-panel/55 text-textMuted hover:bg-panelSoft/75",
                  ].join(" ")}
                  title="Arrastra la pestana a otra zona"
                >
                  <GripVertical className="h-2.5 w-2.5" />
                  {panelLabels[panelId]}
                </button>
              );
            }) : <span className="px-1 text-[9px] uppercase tracking-[0.16em] text-textSoft">Zona libre</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {ZONE_IDS.map((targetZoneId) => (
              <button
                key={`${zoneId}-${targetZoneId}`}
                type="button"
                disabled={!resolvedPanelId || targetZoneId === zoneId}
                className={[
                  "border px-1 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] transition",
                  targetZoneId === zoneId
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-line bg-panelSoft/70 text-textMuted hover:bg-panelSoft",
                  !resolvedPanelId || targetZoneId === zoneId ? "opacity-60" : "",
                ].join(" ")}
                title={resolvedPanelId ? `Mover ${panelLabels[resolvedPanelId]} a ${zoneLabels[targetZoneId]}` : zoneLabels[targetZoneId]}
                onClick={() => {
                  if (resolvedPanelId) {
                    movePanelToZone(resolvedPanelId, targetZoneId);
                  }
                }}
              >
                {zoneShortLabels[targetZoneId]}
              </button>
            ))}
          </div>
        </div>
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
      <div className="surface-divider flex shrink-0 items-center justify-between gap-2 bg-panel/80 px-2 py-1">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {PANEL_IDS.map((panelId) => {
            const zoneId = findPanelZone(panelId);
            const isActive = zoneId ? layout.active[zoneId] === panelId : false;

            return (
              <button
                key={panelId}
                type="button"
                className={[
                  "inline-flex items-center gap-1 border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] transition",
                  isActive
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-line bg-panelSoft/70 text-textMuted hover:bg-panelSoft",
                ].join(" ")}
                onClick={() => focusPanel(panelId)}
                title={zoneId ? `Mostrar ${panelLabels[panelId]} en ${zoneLabels[zoneId].toLowerCase()}` : `Mostrar ${panelLabels[panelId]}`}
              >
                {panelLabels[panelId]}
                <span className="text-[8px] text-textSoft">{zoneId ? zoneShortLabels[zoneId] : "--"}</span>
              </button>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="inline-flex items-center gap-1 border border-line bg-panelSoft/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-textMuted transition hover:bg-panelSoft"
            onClick={showConsole}
            title="Traer la consola a la zona inferior"
          >
            <TerminalSquare className="h-3 w-3" />
            Consola abajo
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 border border-line bg-panelSoft/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-textMuted transition hover:bg-panelSoft"
            onClick={resetLayout}
            title="Restablecer la distribucion por defecto"
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-1">
        <div ref={topRowRef} className="flex min-h-0 flex-1 overflow-hidden gap-1">
          {hasLeftZone ? (
            <div className="min-h-0 shrink-0 overflow-hidden" style={{ width: zoneSize(layout.leftWidth) }}>
              {renderZone("left")}
            </div>
          ) : null}

          {hasLeftZone ? (
            <div
              className="flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-panelSoft/24 hover:bg-accent/18"
              onPointerDown={(event) => startResize("left", event)}
              title="Redimensionar zona izquierda"
            >
              <div className="h-10 w-px bg-line/70" />
            </div>
          ) : null}

          <div className="min-w-0 min-h-0 flex-1 overflow-hidden">
            {renderZone("main")}
          </div>

          {hasRightZone ? (
            <div
              className="flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-panelSoft/24 hover:bg-accent/18"
              onPointerDown={(event) => startResize("right", event)}
              title="Redimensionar zona derecha"
            >
              <div className="h-10 w-px bg-line/70" />
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
            className="flex h-1.5 shrink-0 cursor-row-resize items-center justify-center bg-panelSoft/24 hover:bg-accent/18"
            onPointerDown={(event) => startResize("bottom", event)}
            title="Redimensionar zona inferior"
          >
            <div className="h-px w-12 bg-line/70" />
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





