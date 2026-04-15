import {
  Boxes,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  FolderSearch,
  GripVertical,
  LoaderCircle,
  Play,
  Rocket,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { Project, ProjectResourceUsage } from "../lib/types";
import { StatusPill } from "./status-pill";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DialogShell } from "./ui/dialog-shell";
import { EmptyState } from "./ui/empty-state";
import { Checkbox } from "./ui/checkbox";

interface ProjectListProps {
  projects: Project[];
  selectedProjectId: string | null;
  conflictedProjectIds: Set<string>;
  forceStopProjectIds: string[];
  forceStartProjectIds: string[];
  projectResources: Record<string, ProjectResourceUsage>;
  onSelect: (projectId: string) => void;
  onToggleEnabled: (project: Project, enabled: boolean) => void;
  onToggleWaitForPreviousReady: (project: Project, enabled: boolean) => void;
  onReorderProjects: (orderedProjectIds: string[]) => void;
  onStartProject: (projectId: string) => void;
  onStopProject: (projectId: string) => void;
  onForceStopProject: (projectId: string) => void;
  onForceStartProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onImportProject: () => Promise<void>;
  onOpenScanDialog: () => void;
  onBulkStartVisible: () => void;
  onBulkStartVisibleAsMode: (launchMode: Project["launchMode"]) => void;
  onBulkStopVisible: () => void;
  onBulkForceStopVisible: () => void;
  isBusy: boolean;
}

const rowToneByStatus: Record<Project["status"], string> = {
  idle: "bg-white/[0.015] hover:bg-white/[0.045]",
  starting: "bg-warn/14 hover:bg-warn/22",
  running: "bg-info/14 hover:bg-info/22",
  ready: "bg-ok/14 hover:bg-ok/22",
  stopped: "bg-white/[0.03] hover:bg-white/[0.06]",
  failed: "bg-danger/16 hover:bg-danger/24",
};

const markerToneByStatus: Record<Project["status"], string> = {
  idle: "bg-line/45",
  starting: "bg-warn shadow-[0_0_14px_rgba(250,204,21,0.4)]",
  running: "bg-info shadow-[0_0_14px_rgba(35,213,246,0.4)]",
  ready: "bg-ok shadow-[0_0_14px_rgba(34,197,94,0.4)]",
  stopped: "bg-line/55",
  failed: "bg-danger shadow-[0_0_16px_rgba(248,113,113,0.42)]",
};

const launchModeLabel: Record<Project["launchMode"], string> = {
  service: "service",
  record: "record",
  mock: "mock",
  unknown: "unknown",
};

function buildRowStyle(options: {
  status: Project["status"];
  isSelected: boolean;
  hasConflict: boolean;
  canForceStop: boolean;
  canForceStart: boolean;
  isDropBefore: boolean;
  isDropAfter: boolean;
}) {
  const shadows: string[] = [];

  if (options.canForceStart || options.hasConflict) {
    shadows.push("inset 4px 0 0 0 rgba(250, 204, 21, 0.88)");
  } else if (options.canForceStop || options.status === "failed") {
    shadows.push("inset 4px 0 0 0 rgba(248, 113, 113, 0.88)");
  } else if (options.status === "ready") {
    shadows.push("inset 4px 0 0 0 rgba(34, 197, 94, 0.82)");
  } else if (options.status === "running" || options.status === "starting") {
    shadows.push("inset 4px 0 0 0 rgba(35, 213, 246, 0.82)");
  }

  if (options.isSelected) {
    shadows.push(
      "inset 0 0 0 1px rgba(35, 213, 246, 0.55)",
      "0 22px 38px -30px rgba(35, 213, 246, 0.6)",
    );
  }

  if (options.isDropBefore) {
    shadows.push("inset 0 2px 0 0 rgba(35, 213, 246, 0.8)");
  }

  if (options.isDropAfter) {
    shadows.push("inset 0 -2px 0 0 rgba(35, 213, 246, 0.8)");
  }

  return {
    boxShadow: shadows.length ? shadows.join(", ") : undefined,
  };
}

const bulkActions: Array<{
  id: string;
  label: string;
  description: string;
  variant: "success" | "default" | "warning" | "secondary" | "destructive";
  onRun: (
    props: Pick<ProjectListProps, "onBulkStartVisible" | "onBulkStartVisibleAsMode" | "onBulkStopVisible" | "onBulkForceStopVisible">,
  ) => void;
}> = [
  {
    id: "start-visible",
    label: "Iniciar visibles",
    description: "Arranca los proyectos visibles con el modo que ya tenga cada uno.",
    variant: "success",
    onRun: ({ onBulkStartVisible }) => onBulkStartVisible(),
  },
  {
    id: "start-service",
    label: "Iniciar como service",
    description: "Guarda service para los visibles y luego los arranca en lote.",
    variant: "default",
    onRun: ({ onBulkStartVisibleAsMode }) => onBulkStartVisibleAsMode("service"),
  },
  {
    id: "start-record",
    label: "Iniciar como record",
    description: "Guarda record para los visibles y los levanta grabando tráfico.",
    variant: "warning",
    onRun: ({ onBulkStartVisibleAsMode }) => onBulkStartVisibleAsMode("record"),
  },
  {
    id: "start-mock",
    label: "Iniciar como mock",
    description: "Guarda mock para los visibles y los levanta respondiendo desde capturas.",
    variant: "default",
    onRun: ({ onBulkStartVisibleAsMode }) => onBulkStartVisibleAsMode("mock"),
  },
  {
    id: "stop-visible",
    label: "Detener visibles",
    description: "Solicita el stop normal para todos los proyectos visibles del catálogo.",
    variant: "secondary",
    onRun: ({ onBulkStopVisible }) => onBulkStopVisible(),
  },
  {
    id: "force-visible",
    label: "Forzar visibles",
    description: "Ejecuta detención forzada sobre los proyectos visibles cuando haga falta.",
    variant: "destructive",
    onRun: ({ onBulkForceStopVisible }) => onBulkForceStopVisible(),
  },
];

export function ProjectList({
  projects,
  selectedProjectId,
  conflictedProjectIds,
  forceStopProjectIds,
  forceStartProjectIds,
  projectResources,
  onSelect,
  onToggleEnabled,
  onToggleWaitForPreviousReady,
  onReorderProjects,
  onStartProject,
  onStopProject,
  onForceStopProject,
  onForceStartProject,
  onDeleteProject,
  onImportProject,
  onOpenScanDialog,
  onBulkStartVisible,
  onBulkStartVisibleAsMode,
  onBulkStopVisible,
  onBulkForceStopVisible,
  isBusy,
}: ProjectListProps) {
  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({});
  const [draggedProjectId, setDraggedProjectId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ projectId: string; position: "before" | "after" } | null>(null);
  const [isBulkDialogOpen, setIsBulkDialogOpen] = useState(false);
  const forceStopSet = useMemo(() => new Set(forceStopProjectIds), [forceStopProjectIds]);
  const forceStartSet = useMemo(() => new Set(forceStartProjectIds), [forceStartProjectIds]);

  function toggleExpanded(projectId: string) {
    setExpandedProjectIds((current) => ({
      ...current,
      [projectId]: !current[projectId],
    }));
  }

  function clearDragState() {
    setDraggedProjectId(null);
    setDropTarget(null);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  function buildReorderedIds(targetProjectId: string, position: "before" | "after") {
    if (!draggedProjectId || draggedProjectId === targetProjectId) {
      return projects.map((project) => project.id);
    }

    const orderedIds = projects.map((project) => project.id);
    const fromIndex = orderedIds.indexOf(draggedProjectId);
    const targetIndex = orderedIds.indexOf(targetProjectId);

    if (fromIndex < 0 || targetIndex < 0) {
      return orderedIds;
    }

    orderedIds.splice(fromIndex, 1);
    const nextTargetIndex = orderedIds.indexOf(targetProjectId);
    const insertAt = position === "before" ? nextTargetIndex : nextTargetIndex + 1;
    orderedIds.splice(insertAt, 0, draggedProjectId);

    return orderedIds;
  }

  function handleDrop(targetProjectId: string, position: "before" | "after") {
    const orderedIds = buildReorderedIds(targetProjectId, position);
    const currentIds = projects.map((project) => project.id);
    clearDragState();

    if (orderedIds.join("|") !== currentIds.join("|")) {
      onReorderProjects(orderedIds);
    }
  }

  useEffect(() => {
    if (!draggedProjectId) {
      return;
    }

    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    function updateDropTarget(clientX: number, clientY: number) {
      const element = document.elementFromPoint(clientX, clientY);
      const row = element instanceof HTMLElement ? element.closest<HTMLElement>("[data-project-row]") : null;
      if (!row) {
        setDropTarget(null);
        return;
      }

      const targetProjectId = row.dataset.projectRow ?? null;
      if (!targetProjectId || targetProjectId === draggedProjectId) {
        setDropTarget(null);
        return;
      }

      const bounds = row.getBoundingClientRect();
      const position = clientY < bounds.top + bounds.height / 2 ? "before" : "after";
      setDropTarget({ projectId: targetProjectId, position });
    }

    function handlePointerMove(event: PointerEvent) {
      updateDropTarget(event.clientX, event.clientY);
    }

    function finishDrag() {
      if (dropTarget) {
        handleDrop(dropTarget.projectId, dropTarget.position);
      } else {
        clearDragState();
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [draggedProjectId, dropTarget, projects]);

  return (
    <div className="surface-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="surface-divider flex flex-wrap items-center justify-between gap-2 px-3 py-3">
        <div>
          <p className="text-[9px] uppercase tracking-[0.22em] text-textSoft">Catálogo</p>
          <h2 className="mt-0.5 text-[13px] font-semibold text-textStrong">Servicios configurados</h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setIsBulkDialogOpen(true)}
            disabled={!projects.length || isBusy}
            title="Acciones masivas sobre los proyectos visibles del catálogo"
          >
            <Boxes className="h-3.5 w-3.5" />
            Lote
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onOpenScanDialog}
            disabled={isBusy}
            title="Escanear una carpeta base e importar varios servicios"
          >
            <FolderSearch className="h-3.5 w-3.5" />
            Escanear
          </Button>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => void onImportProject()}
            disabled={isBusy}
            title="Seleccionar una carpeta e importarla al catálogo"
          >
            {isBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
            Agregar carpeta
          </Button>
          <Badge variant="secondary" className="px-2 py-1 text-[10px]">
            {projects.length} visibles
          </Badge>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin px-2 pb-2">
        <table className="ui-data-table min-w-full border-separate border-spacing-y-0.5 text-[11px]">
          <thead className="sticky top-0 z-10 bg-panel/88 backdrop-blur-xl">
            <tr className="text-left text-[9px] uppercase tracking-[0.16em] text-textSoft shadow-[inset_0_-1px_0_rgb(var(--color-line)/0.14)]">
              <th className="w-[44px] px-2 ">Run</th>
              <th className="px-2 ">Servicio</th>
              <th className="w-[58px] px-2 ">Port</th>
              <th className="w-[72px] px-2 ">Mocks</th>
              <th className="w-[48px] px-2 ">Ord</th>
              <th className="w-[56px] px-2 ">Prev</th>
              <th className="w-[88px] px-2 ">Estado</th>
              <th className="w-[210px] px-2 ">Acc.</th>
            </tr>
          </thead>
          <tbody>
            {projects.length ? (
              projects.map((project) => {
                const isSelected = project.id === selectedProjectId;
                const hasConflict = conflictedProjectIds.has(project.id);
                const canForceStop = forceStopSet.has(project.id);
                const canForceStart = forceStartSet.has(project.id);
                const showForceStopAction = canForceStop || ["starting", "running", "ready", "failed"].includes(project.status);
                const showForceStopWarning = canForceStop;
                const isExpanded = expandedProjectIds[project.id] ?? false;
                const resourceUsage = projectResources[project.id];
                const isDropBefore = dropTarget?.projectId === project.id && dropTarget.position === "before";
                const isDropAfter = dropTarget?.projectId === project.id && dropTarget.position === "after";

                return (
                  <Fragment key={project.id}>
                    <tr
                      data-project-row={project.id}
                      className={[
                        "cursor-pointer transition-[background,opacity] duration-150",
                        rowToneByStatus[project.status],
                        draggedProjectId === project.id ? "opacity-55" : "",
                        project.enabled ? "" : "opacity-60",
                      ].join(" ")}
                      style={buildRowStyle({
                        status: project.status,
                        isSelected,
                        hasConflict,
                        canForceStop,
                        canForceStart,
                        isDropBefore,
                        isDropAfter,
                      })}
                      onClick={() => onSelect(project.id)}
                    >
                      <td className="px-2  align-middle">
                        <Checkbox
                          checked={project.enabled}
                          onChange={(event) => {
                            event.stopPropagation();
                            onToggleEnabled(project, event.currentTarget.checked);
                          }}
                          onClick={(event) => event.stopPropagation()}
                          title="Incluir en Iniciar habilitados"
                        />
                      </td>
                      <td className="px-2  align-middle">
                        <div className="flex min-w-0 items-center gap-1">
                          <button
                            type="button"
                            className="surface-chip cursor-grab p-0.5 text-textMuted transition hover:bg-panelSoft/70 active:cursor-grabbing"
                            onPointerDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setDraggedProjectId(project.id);
                            }}
                            onClick={(event) => event.stopPropagation()}
                            title="Arrastrar para cambiar el orden de arranque"
                          >
                            <GripVertical className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            className="surface-chip p-0.5 text-textMuted transition hover:bg-panelSoft/70"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleExpanded(project.id);
                            }}
                            title={isExpanded ? "Ocultar detalle" : "Mostrar detalle"}
                          >
                            {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          </button>
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-1">
                              <span className={["h-4 w-1.5 shrink-0 rounded-full", markerToneByStatus[project.status]].join(" ")} />
                              <p className="truncate text-[11px] font-semibold leading-4 text-textStrong">{project.name}</p>
                              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[8px]">
                                {launchModeLabel[project.launchMode]}
                              </Badge>
                              {hasConflict ? <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warn" /> : null}
                              {canForceStart ? <Rocket className="h-3.5 w-3.5 shrink-0 text-warn" /> : null}
                              {!canForceStart && showForceStopWarning ? <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-danger" /> : null}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-2  align-middle text-[11px] leading-4 text-textStrong">{project.port ?? "n/a"}</td>
                      <td className="px-2  align-middle">
                        <Badge variant={project.mockSummary.totalCount ? "info" : "secondary"} className="min-w-[40px] justify-center px-1.5 py-0 text-[9px]">
                          {project.mockSummary.totalCount}
                        </Badge>
                      </td>
                      <td className="px-2  align-middle text-[11px] leading-4 text-textStrong">{project.catalogOrder}</td>
                      <td className="px-2  align-middle">
                        <Checkbox
                          checked={project.waitForPreviousReady}
                          onChange={(event) => {
                            event.stopPropagation();
                            onToggleWaitForPreviousReady(project, event.currentTarget.checked);
                          }}
                          onClick={(event) => event.stopPropagation()}
                          title="Esperar a que el servicio anterior quede ready antes de iniciar este"
                        />
                      </td>
                      <td className="px-2  align-middle">
                        <StatusPill status={project.status} />
                      </td>
                      <td className="px-2  align-middle">
                        <div className="flex flex-wrap gap-1">
                          <Button
                            type="button"
                            variant="success"
                            size="sm"
                            className="!h-7 !min-h-7 !w-7 !min-w-7 !gap-0 !px-0 !py-0"
                            onClick={(event) => {
                              event.stopPropagation();
                              onStartProject(project.id);
                            }}
                            title="Iniciar proyecto"
                          >
                            <Play className="h-3 w-3" />
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="!h-7 !min-h-7 !w-7 !min-w-7 !gap-0 !px-0 !py-0"
                            onClick={(event) => {
                              event.stopPropagation();
                              onStopProject(project.id);
                            }}
                            title="Detener proyecto"
                          >
                            <Square className="h-3 w-3" />
                          </Button>
                          {canForceStart ? (
                            <Button
                              type="button"
                              variant="warning"
                              size="sm"
                              className="!h-7 !min-h-7 !gap-1 !px-2 !py-0 text-[10px]"
                              onClick={(event) => {
                                event.stopPropagation();
                                onForceStartProject(project.id);
                              }}
                              title="Liberar puerto y volver a iniciar el proyecto"
                            >
                              Forzar e iniciar
                            </Button>
                          ) : null}
                          {!canForceStart && showForceStopAction ? (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              className="!h-7 !min-h-7 !gap-1 !px-2 !py-0 text-[10px]"
                              onClick={(event) => {
                                event.stopPropagation();
                                onForceStopProject(project.id);
                              }}
                              title="Forzar detención del proyecto"
                            >
                              Forzar
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="!h-7 !min-h-7 !w-7 !min-w-7 !gap-0 !px-0 !py-0 text-danger"
                            onClick={(event) => {
                              event.stopPropagation();
                              onDeleteProject(project.id);
                            }}
                            title="Quitar servicio del catálogo importado"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </td>
                    </tr>

                    {isExpanded ? (
                      <tr className={project.enabled ? "" : "opacity-60"}>
                        <td colSpan={8} className="px-2 pb-1 pt-0">
                          <div className="surface-panel-soft grid gap-1 px-2 py-1 text-[10px] leading-4 text-textMuted md:grid-cols-[minmax(0,1.9fr)_minmax(0,1.15fr)_minmax(0,1fr)]">
                            <div className="min-w-0">
                              <p className="text-[9px] uppercase tracking-[0.14em] text-textSoft">Ruta</p>
                              <p className="truncate text-textMuted" title={project.rootPath}>
                                {project.rootPath}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[9px] uppercase tracking-[0.14em] text-textSoft">Run target</p>
                              <p className="truncate text-textMuted" title={project.runTarget}>
                                {project.packageManager} / {project.runMode === "script" ? "script" : "command"} / {project.runTarget}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[9px] uppercase tracking-[0.14em] text-textSoft">.env</p>
                              <p className="truncate text-textMuted" title={project.selectedEnvFile ?? "Sin .env"}>
                                {project.selectedEnvFile ?? "Sin .env"}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[9px] uppercase tracking-[0.14em] text-textSoft">Arranque</p>
                              <p className="truncate text-textMuted" title={`Orden ${project.catalogOrder} · fase ${project.startupPhase}`}>
                                #{project.catalogOrder} / fase {project.startupPhase} / {project.launchMode} / {project.waitForPreviousReady ? "espera ready del anterior" : "sin espera"}
                              </p>
                            </div>
                            <div className="min-w-0">
                              <p className="text-[9px] uppercase tracking-[0.14em] text-textSoft">Recursos</p>
                              {resourceUsage ? (
                                <p className="truncate text-textMuted" title={resourceUsage.commandPreview ?? "Sin comando"}>
                                  PID {resourceUsage.trackedPid ?? "n/a"} / {resourceUsage.totalProcesses} proc / {resourceUsage.totalWorkingSetMb.toFixed(1)} MB
                                </p>
                              ) : (
                                <p className="truncate text-textMuted">Sin proceso rastreado</p>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            ) : (
              <tr>
                <td colSpan={8} className="px-2 py-6">
                  <EmptyState
                    title="No hay proyectos visibles"
                    description="Importa una carpeta o ejecuta un escaneo para poblar el catálogo."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <DialogShell
        open={isBulkDialogOpen}
        onOpenChange={setIsBulkDialogOpen}
        title="Acciones del catálogo"
        description={`Ejecuta cambios masivos sobre los ${projects.length} proyectos visibles sin ir uno por uno.`}
      >
        <div className="grid gap-2 md:grid-cols-2">
          {bulkActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`ui-bulk-action-card ui-bulk-action-card--${action.variant}`}
              onClick={() => {
                setIsBulkDialogOpen(false);
                action.onRun({
                  onBulkStartVisible,
                  onBulkStartVisibleAsMode,
                  onBulkStopVisible,
                  onBulkForceStopVisible,
                });
              }}
              disabled={!projects.length || isBusy}
            >
              <span className="block text-[11px] font-semibold uppercase tracking-[0.12em]">{action.label}</span>
              <span className="mt-1 block text-[11px] leading-5 text-current/80">{action.description}</span>
            </button>
          ))}
        </div>
      </DialogShell>
    </div>
  );
}
