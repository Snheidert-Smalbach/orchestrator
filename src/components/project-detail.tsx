import { useEffect, useRef, useState } from "react";
import { Play, RefreshCw, Rocket, Save, Square, Trash2, TriangleAlert } from "lucide-react";
import { inspectProject } from "../lib/tauri";
import type { DetectedProject, Preset, Project, ProjectEnvOverride, ProjectResourceUsage } from "../lib/types";
import { ProjectMocksEditor } from "./project-mocks-editor";
import { StatusPill } from "./status-pill";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { EmptyState } from "./ui/empty-state";
import { FieldGroup, FieldHint, FieldLabel, FieldLabelWrap, FieldRow } from "./ui/field";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

type SaveOptions = {
  quiet?: boolean;
};

type DetailTabId = "config" | "mocks";

type Props = {
  project: Project | null;
  resourceUsage: ProjectResourceUsage | null;
  runtimeMessage: string | null;
  allProjects: Project[];
  canForceStop: boolean;
  canForceStart: boolean;
  presets: Preset[];
  onToggleProjectPreset: (presetId: string, projectId: string, enabled: boolean) => void;
  onSave: (project: Project, options?: SaveOptions) => Promise<void>;
  onStart: (projectId: string) => Promise<void>;
  onStop: (projectId: string) => Promise<void>;
  onForceStop: (projectId: string) => Promise<void>;
  onForceStart: (projectId: string) => Promise<void>;
  onDelete: (projectId: string) => Promise<void>;
};

function buildScriptOptions(project: Project) {
  const options = new Set<string>();
  if (project.runTarget.trim()) {
    options.add(project.runTarget);
  }
  for (const script of project.availableScripts) {
    if (script.trim()) {
      options.add(script);
    }
  }
  return [...options];
}

function formatOverrides(envOverrides: ProjectEnvOverride[]) {
  return envOverrides
    .filter((entry) => entry.enabled)
    .map((entry) => `${entry.key}=${entry.value}`)
    .join("\n");
}

function buildEnvOverrides(projectId: string, overridesText: string) {
  return overridesText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, ...rest] = line.split("=");
      return {
        id: `${projectId}-override-${key}`,
        key,
        value: rest.join("="),
        isSecret: /(secret|token|password|key)/i.test(key),
        enabled: true,
      } satisfies ProjectEnvOverride;
    });
}

function buildProjectPayload(project: Project, overridesText: string) {
  return {
    ...project,
    envOverrides: buildEnvOverrides(project.id, overridesText),
  } satisfies Project;
}

function serializeProjectConfig(project: Project, overridesText: string) {
  const payload = buildProjectPayload(project, overridesText);
  const { status: _status, lastExitCode: _lastExitCode, mockSummary: _mockSummary, ...config } = payload;
  return JSON.stringify(config);
}

function mergeProjectWithMetadata(
  project: Project,
  detected: DetectedProject,
  options?: {
    selectedEnvFile?: string | null;
    preferDetectedPort?: boolean;
  },
) {
  const shouldReplaceScript =
    project.runMode === "script" &&
    (!project.runTarget || (detected.availableScripts.length > 0 && !detected.availableScripts.includes(project.runTarget)));

  const selectedEnvFile =
    options?.selectedEnvFile !== undefined
      ? options.selectedEnvFile
      : project.selectedEnvFile && detected.envFiles.includes(project.selectedEnvFile)
        ? project.selectedEnvFile
        : detected.suggestedEnvFile;

  const runTarget = shouldReplaceScript
    ? detected.suggestedRunTarget || detected.availableScripts[0] || project.runTarget
    : project.runTarget;

  const detectedPort = detected.suggestedPort ?? null;
  const port = options?.preferDetectedPort ? detectedPort : project.port ?? detectedPort;

  return {
    ...project,
    runtimeKind: detected.runtimeKind,
    packageManager: detected.packageManager,
    availableEnvFiles: detected.envFiles,
    availableScripts: detected.availableScripts,
    selectedEnvFile,
    runTarget,
    port,
    readinessValue:
      project.readinessMode === "port"
        ? port != null
          ? String(port)
          : null
        : project.readinessValue,
  } satisfies Project;
}

export function ProjectDetail({
  project,
  resourceUsage,
  runtimeMessage,
  allProjects,
  canForceStop,
  canForceStart,
  presets,
  onToggleProjectPreset,
  onSave,
  onStart,
  onStop,
  onForceStop,
  onForceStart,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<Project | null>(project);
  const [activeTab, setActiveTab] = useState<DetailTabId>("config");
  const [overridesText, setOverridesText] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const hydratedProjectIdRef = useRef<string | null>(null);
  const savedSignatureRef = useRef<string | null>(null);
  const isPersistingRef = useRef(false);
  const queuedPersistRef = useRef<{ project: Project; overridesText: string; quiet: boolean } | null>(null);

  useEffect(() => {
    if (!project) {
      setDraft(null);
      setActiveTab("config");
      setOverridesText("");
      setMetadataError(null);
      setSaveError(null);
      setSaveState("idle");
      hydratedProjectIdRef.current = null;
      savedSignatureRef.current = null;
      return;
    }

    const nextOverridesText = formatOverrides(project.envOverrides);
    const nextSignature = serializeProjectConfig(project, nextOverridesText);
    const isNewProject = hydratedProjectIdRef.current !== project.id;
    const currentSignature = draft ? serializeProjectConfig(draft, overridesText) : null;
    const hasLocalChanges = currentSignature != null && currentSignature !== savedSignatureRef.current;

    savedSignatureRef.current = nextSignature;
    setSaveError(null);

    if (isNewProject) {
      hydratedProjectIdRef.current = project.id;
      setDraft(project);
      setOverridesText(nextOverridesText);
      setMetadataError(null);
      setSaveState("saved");
      void refreshMetadata(project, {
        preferredEnvFile: project.selectedEnvFile,
        preferDetectedPort: project.port == null,
      });
      return;
    }

    if (!hasLocalChanges) {
      setDraft(project);
      setOverridesText(nextOverridesText);
      setSaveState("saved");
      return;
    }

    setDraft((current) => {
      if (!current || current.id !== project.id) {
        return current;
      }
      if (current.status === project.status && current.lastExitCode === project.lastExitCode) {
        return current;
      }
      return {
        ...current,
        status: project.status,
        lastExitCode: project.lastExitCode,
      };
    });
  }, [draft, overridesText, project]);

  async function refreshMetadata(
    baseProject: Project,
    options?: {
      preferredEnvFile?: string | null;
      selectedEnvFile?: string | null;
      preferDetectedPort?: boolean;
    },
  ) {
    setIsRefreshing(true);
    setMetadataError(null);

    try {
      const detected = await inspectProject(baseProject.rootPath, options?.preferredEnvFile ?? baseProject.selectedEnvFile);
      setDraft((current) => {
        if (!current || current.id !== baseProject.id) {
          return current;
        }

        return mergeProjectWithMetadata(current, detected, {
          selectedEnvFile: options?.selectedEnvFile,
          preferDetectedPort: options?.preferDetectedPort,
        });
      });
    } catch (error) {
      setMetadataError(error instanceof Error ? error.message : "No fue posible releer scripts y variables del proyecto.");
    } finally {
      setIsRefreshing(false);
    }
  }

  async function persistDraft(projectDraft: Project, nextOverridesText: string, options?: SaveOptions) {
    const signature = serializeProjectConfig(projectDraft, nextOverridesText);
    if (signature === savedSignatureRef.current && options?.quiet) {
      setSaveState("saved");
      setSaveError(null);
      return;
    }

    if (isPersistingRef.current) {
      queuedPersistRef.current = {
        project: projectDraft,
        overridesText: nextOverridesText,
        quiet: options?.quiet ?? false,
      };
      setSaveState("pending");
      return;
    }

    isPersistingRef.current = true;
    setSaveState("saving");
    setSaveError(null);

    try {
      await onSave(buildProjectPayload(projectDraft, nextOverridesText), options);
      savedSignatureRef.current = signature;
      setSaveState("saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No fue posible guardar el proyecto.";
      setSaveState("error");
      setSaveError(message);
      throw error;
    } finally {
      isPersistingRef.current = false;
      const queuedPersist = queuedPersistRef.current;
      queuedPersistRef.current = null;
      if (queuedPersist) {
        void persistDraft(queuedPersist.project, queuedPersist.overridesText, { quiet: queuedPersist.quiet });
      }
    }
  }

  useEffect(() => {
    if (!draft) {
      return;
    }

    const signature = serializeProjectConfig(draft, overridesText);
    if (signature === savedSignatureRef.current) {
      return;
    }

    setSaveState("pending");
    const timer = window.setTimeout(() => {
      void persistDraft(draft, overridesText, { quiet: true });
    }, 700);

    return () => {
      window.clearTimeout(timer);
    };
  }, [draft, overridesText]);

  if (!draft) {
    return (
      <div className="surface-panel flex h-full items-center justify-center p-5">
        <EmptyState
          title="Selecciona un proyecto"
          description="El detalle de configuración, dependencias, workspaces y mocks aparece cuando eliges un servicio del catálogo."
        />
      </div>
    );
  }

  const otherProjects = allProjects.filter((entry) => entry.id !== draft.id);
  const editablePresets = presets.filter((preset) => !preset.readOnly);
  const scriptOptions = buildScriptOptions(draft);
  const showForceStopAction = canForceStop || ["starting", "running", "ready", "failed"].includes(draft.status);
  const showForceStopWarning = canForceStop;
  const saveHint =
    saveState === "saving"
      ? "Guardando..."
      : saveState === "pending"
        ? "Autosave pendiente..."
        : saveState === "error"
          ? saveError ?? "No fue posible guardar."
          : "Autosave activo";

  async function handleSave() {
    const projectDraft = draft;
    if (!projectDraft) {
      return;
    }

    await persistDraft(projectDraft, overridesText);
  }

  async function handleStart() {
    const projectDraft = draft;
    if (!projectDraft) {
      return;
    }

    await persistDraft(projectDraft, overridesText);
    await onStart(projectDraft.id);
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as DetailTabId)}
      className="surface-panel flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="surface-divider flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[10px] uppercase tracking-[0.24em] text-textSoft">Detalle</p>
            <StatusPill status={draft.status} />
            <Badge variant="secondary">{draft.runtimeKind}</Badge>
          </div>
          <h2 className="mt-1 truncate text-base font-semibold text-textStrong">{draft.name}</h2>
          <p className="mt-0.5 truncate text-[11px] text-textMuted">{draft.rootPath}</p>
          <p className="mt-1 text-[11px] text-textSoft">
            {draft.availableScripts.length} scripts / {draft.availableEnvFiles.length} archivos .env
          </p>
          {runtimeMessage ? <p className="mt-1 text-[11px] text-info">{runtimeMessage}</p> : null}
          {canForceStart ? (
            <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-warn">
              <Rocket className="h-3 w-3" />
              El puerto configurado parece ocupado. Puedes usar Forzar e iniciar para liberar ese puerto y arrancar el servicio.
            </p>
          ) : null}
          {showForceStopWarning ? (
            <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-danger">
              <TriangleAlert className="h-3 w-3" />
              La detención normal no liberó el servicio. Puedes usar Forzar para matar el PID o liberar el puerto.
            </p>
          ) : null}
          {metadataError ? <p className="mt-1 text-[11px] text-danger">{metadataError}</p> : null}
          {saveState === "error" ? <p className="mt-1 text-[11px] text-danger">{saveHint}</p> : null}
          {isRefreshing ? <p className="mt-1 text-[11px] text-textMuted">Leyendo metadata del proyecto...</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void refreshMetadata(draft, { preferredEnvFile: draft.selectedEnvFile, preferDetectedPort: true })}
            disabled={isRefreshing}
          >
            <RefreshCw className={["h-3.5 w-3.5", isRefreshing ? "animate-spin" : ""].join(" ")} />
            Recargar
          </Button>
          <Button type="button" variant="success" size="sm" onClick={() => void handleStart()}>
            <Play className="h-3.5 w-3.5" />
            Iniciar
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void onStop(draft.id)}>
            <Square className="h-3.5 w-3.5" />
            Detener
          </Button>
          {canForceStart ? (
            <Button type="button" variant="warning" size="sm" onClick={() => void onForceStart(draft.id)}>
              <Rocket className="h-3.5 w-3.5" />
              Forzar e iniciar
            </Button>
          ) : null}
          {!canForceStart && showForceStopAction ? (
            <Button type="button" variant="destructive" size="sm" onClick={() => void onForceStop(draft.id)}>
              <TriangleAlert className="h-3.5 w-3.5" />
              Forzar
            </Button>
          ) : null}
        </div>
      </div>

      <div className="surface-divider flex shrink-0 items-center gap-2 px-4 py-2">
        <TabsList>
          <TabsTrigger value="config">Configuración</TabsTrigger>
          <TabsTrigger value="mocks">
            Mocks
            <Badge variant="secondary" className="px-1.5 py-0.5 text-[9px]">
              {draft.mockSummary.totalCount}
            </Badge>
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="config" className="min-h-0 flex-1 overflow-auto">
        <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          <FieldLabelWrap>
            <FieldLabel>Nombre</FieldLabel>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </FieldLabelWrap>

          {draft.runMode === "script" && scriptOptions.length > 0 ? (
            <FieldLabelWrap>
              <FieldLabel>Script</FieldLabel>
              <Select value={draft.runTarget} onChange={(event) => setDraft({ ...draft, runTarget: event.target.value })}>
                {scriptOptions.map((script) => (
                  <option key={script} value={script}>
                    {script}
                  </option>
                ))}
              </Select>
            </FieldLabelWrap>
          ) : (
            <FieldLabelWrap>
              <FieldLabel>Run target</FieldLabel>
              <Input value={draft.runTarget} onChange={(event) => setDraft({ ...draft, runTarget: event.target.value })} />
            </FieldLabelWrap>
          )}

          <FieldLabelWrap>
            <FieldLabel>Modo</FieldLabel>
            <Select
              value={draft.runMode}
              onChange={(event) => {
                const nextRunMode = event.target.value as Project["runMode"];
                setDraft({
                  ...draft,
                  runMode: nextRunMode,
                  runTarget: nextRunMode === "script" ? draft.runTarget || draft.availableScripts[0] || "start:dev" : draft.runTarget,
                });
              }}
            >
              <option value="script">Script</option>
              <option value="command">Comando</option>
            </Select>
          </FieldLabelWrap>

          <FieldLabelWrap>
            <FieldLabel>Package manager</FieldLabel>
            <Select
              value={draft.packageManager}
              onChange={(event) => setDraft({ ...draft, packageManager: event.target.value as Project["packageManager"] })}
            >
              <option value="npm">npm</option>
              <option value="pnpm">pnpm</option>
              <option value="yarn">yarn</option>
              <option value="cargo">cargo</option>
              <option value="unknown">unknown</option>
            </Select>
          </FieldLabelWrap>

          <FieldLabelWrap>
            <FieldLabel>.env</FieldLabel>
            <Select
              value={draft.selectedEnvFile ?? ""}
              onChange={(event) => {
                const nextSelectedEnvFile = event.target.value || null;
                if (!nextSelectedEnvFile) {
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          selectedEnvFile: null,
                          port: null,
                          readinessValue: current.readinessMode === "port" ? null : current.readinessValue,
                        }
                      : current,
                  );
                  return;
                }

                const nextDraft = { ...draft, selectedEnvFile: nextSelectedEnvFile };
                setDraft(nextDraft);
                void refreshMetadata(nextDraft, {
                  preferredEnvFile: nextSelectedEnvFile,
                  selectedEnvFile: nextSelectedEnvFile,
                  preferDetectedPort: true,
                });
              }}
            >
              <option value="">Sin archivo</option>
              {draft.availableEnvFiles.map((envFile) => (
                <option key={envFile} value={envFile}>
                  {envFile}
                </option>
              ))}
            </Select>
          </FieldLabelWrap>

          <Card tone="muted" className="[grid-column:1/-1] p-4">
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
              <FieldLabelWrap>
                <FieldLabel>Puerto</FieldLabel>
                <Input
                  type="number"
                  value={draft.port ?? ""}
                  onChange={(event) => {
                    const nextPort = event.target.value ? Number(event.target.value) : null;
                    setDraft({
                      ...draft,
                      port: nextPort,
                      readinessValue:
                        draft.readinessMode === "port"
                          ? nextPort != null
                            ? String(nextPort)
                            : null
                          : draft.readinessValue,
                    });
                  }}
                />
              </FieldLabelWrap>

              <FieldLabelWrap>
                <FieldLabel>Fase</FieldLabel>
                <Input
                  type="number"
                  value={draft.startupPhase}
                  onChange={(event) => setDraft({ ...draft, startupPhase: Number(event.target.value || 1) })}
                />
              </FieldLabelWrap>

              <FieldLabelWrap>
                <FieldLabel>Orden</FieldLabel>
                <Input type="number" value={draft.catalogOrder} disabled />
              </FieldLabelWrap>

              <FieldLabelWrap>
                <FieldLabel>Ready</FieldLabel>
                <Select
                  value={draft.readinessMode}
                  onChange={(event) => {
                    const readinessMode = event.target.value as Project["readinessMode"];
                    setDraft({
                      ...draft,
                      readinessMode,
                      readinessValue:
                        readinessMode === "port"
                          ? draft.port != null
                            ? String(draft.port)
                            : draft.readinessValue
                          : draft.readinessValue,
                    });
                  }}
                >
                  <option value="none">none</option>
                  <option value="delay">delay</option>
                  <option value="port">port</option>
                </Select>
              </FieldLabelWrap>
            </div>
          </Card>

          <div className="grid gap-3 [grid-column:1/-1] [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
            <FieldLabelWrap>
              <FieldLabel>Arranque</FieldLabel>
              <Select
                value={draft.launchMode}
                onChange={(event) => setDraft({ ...draft, launchMode: event.target.value as Project["launchMode"] })}
              >
                <option value="service">service</option>
                <option value="record">record</option>
                <option value="mock">mock</option>
              </Select>
            </FieldLabelWrap>

            <FieldLabelWrap>
              <FieldLabel>Mock match</FieldLabel>
              <Select
                value={draft.mockMatchMode}
                onChange={(event) => setDraft({ ...draft, mockMatchMode: event.target.value as Project["mockMatchMode"] })}
              >
                <option value="auto">auto</option>
                <option value="strict">strict</option>
                <option value="path">path</option>
              </Select>
            </FieldLabelWrap>

            <FieldLabelWrap>
              <FieldLabel>Miss status</FieldLabel>
              <Input
                type="number"
                value={draft.mockUnmatchedStatus}
                onChange={(event) => setDraft({ ...draft, mockUnmatchedStatus: Number(event.target.value || 404) })}
              />
            </FieldLabelWrap>
          </div>

          <Card tone="accent" className="[grid-column:1/-1] p-4 text-[12px] text-textMuted">
            {draft.launchMode === "service"
              ? "service: arranca el microservicio tal cual está configurado."
              : draft.launchMode === "record"
                ? "record: publica un proxy grabador en el puerto del servicio, mueve el proceso real a un puerto interno y guarda request/response para futuros mocks."
                : "mock: levanta un mock HTTP liviano desde las capturas guardadas en el puerto configurado."}
          </Card>

          <Card tone="muted" className="[grid-column:1/-1] p-4">
            <FieldGroup>
              <FieldLabel>Proceso</FieldLabel>
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">PID</p>
                  <p className="mt-1 text-[12px] text-textStrong">{resourceUsage?.trackedPid ?? "n/a"}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">Subprocesos</p>
                  <p className="mt-1 text-[12px] text-textStrong">
                    {resourceUsage ? `${resourceUsage.totalProcesses} total / ${resourceUsage.totalNodeProcesses} node` : "Sin proceso"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">RAM</p>
                  <p className="mt-1 text-[12px] text-textStrong">
                    {resourceUsage ? `${resourceUsage.totalWorkingSetMb.toFixed(1)} MB` : "n/a"}
                  </p>
                </div>
                <div className="[grid-column:1/-1] min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">Comando activo</p>
                  <p className="mt-1 truncate text-[12px] text-textMuted" title={resourceUsage?.commandPreview ?? "Sin proceso"}>
                    {resourceUsage?.commandPreview ?? "Sin proceso rastreado por el orchestrator"}
                  </p>
                </div>
              </div>
            </FieldGroup>
          </Card>

          <FieldLabelWrap className="[grid-column:1/-1]">
            <FieldLabel>Overrides</FieldLabel>
            <Textarea rows={6} value={overridesText} onChange={(event) => setOverridesText(event.target.value)} />
            <FieldHint>Usa formato `KEY=value` por línea. Se guardan como overrides activos del proyecto.</FieldHint>
          </FieldLabelWrap>

          <Card tone="muted" className="[grid-column:1/-1] p-4">
            <FieldGroup>
              <FieldLabel>Dependencias</FieldLabel>
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
                {otherProjects.length ? (
                  otherProjects.map((entry) => {
                    const checked = draft.dependencies.some((dependency) => dependency.dependsOnProjectId === entry.id);
                    return (
                      <label key={entry.id} className="ui-inline-option ui-inline-option--block">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-textStrong">{entry.name}</span>
                          <span className="block truncate text-[11px] text-textMuted">{entry.rootPath}</span>
                        </span>
                        <Checkbox
                          checked={checked}
                          onChange={(event) => {
                            const dependencies = event.currentTarget.checked
                              ? [...draft.dependencies, { id: `${draft.id}-dep-${entry.id}`, dependsOnProjectId: entry.id, requiredForStart: true }]
                              : draft.dependencies.filter((dependency) => dependency.dependsOnProjectId !== entry.id);
                            setDraft({ ...draft, dependencies });
                          }}
                        />
                      </label>
                    );
                  })
                ) : (
                  <EmptyState
                    title="Sin dependencias disponibles"
                    description="No hay otros proyectos en el catálogo para enlazar como dependencias de arranque."
                  />
                )}
              </div>
            </FieldGroup>
          </Card>

          <Card tone="muted" className="[grid-column:1/-1] p-4">
            <FieldGroup>
              <FieldLabel>Workspaces</FieldLabel>
              {editablePresets.length ? (
                <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
                  {editablePresets.map((preset) => {
                    const checked = preset.projectIds.includes(draft.id);
                    return (
                      <label key={preset.id} className="ui-inline-option ui-inline-option--block">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-textStrong">{preset.name}</span>
                          {preset.description ? <span className="block truncate text-[11px] text-textMuted">{preset.description}</span> : null}
                        </span>
                        <Checkbox
                          checked={checked}
                          onChange={(event) => onToggleProjectPreset(preset.id, draft.id, event.currentTarget.checked)}
                        />
                      </label>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  title="Todavía no hay workspaces"
                  description="Crea un workspace para agrupar y ejecutar microservicios por pestañas."
                />
              )}
            </FieldGroup>
          </Card>

          <Card tone="muted" className="[grid-column:1/-1] p-4">
            <FieldRow>
              <Checkbox checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })} />
              <div>
                <p className="text-[13px] font-medium text-textStrong">Habilitado para acciones globales</p>
                <p className="text-[11px] text-textMuted">Participa en arranques, stops y perfiles rápidos del catálogo.</p>
              </div>
            </FieldRow>
          </Card>

          <Card tone="muted" className="[grid-column:1/-1] p-4">
            <FieldRow>
              <Checkbox
                checked={draft.waitForPreviousReady}
                onChange={(event) => setDraft({ ...draft, waitForPreviousReady: event.currentTarget.checked })}
              />
              <div>
                <p className="text-[13px] font-medium text-textStrong">Esperar ready del anterior</p>
                <p className="text-[11px] text-textMuted">Aplica a arranques por lote para controlar la secuencia de dependencias.</p>
              </div>
            </FieldRow>
          </Card>
        </div>
      </TabsContent>

      <TabsContent value="mocks" className="min-h-0 flex-1 overflow-hidden p-4">
        <ProjectMocksEditor project={draft} />
      </TabsContent>

      <div className="surface-divider-top flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <p className={["text-[11px]", saveState === "error" ? "text-danger" : "text-textSoft"].join(" ")}>
          Último exit code: {draft.lastExitCode ?? "n/a"} | {saveHint}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" variant="destructive" size="sm" onClick={() => void onDelete(draft.id)}>
            <Trash2 className="h-3.5 w-3.5" />
            Eliminar
          </Button>
          <Button type="button" variant="default" size="sm" onClick={() => void handleSave()}>
            <Save className="h-3.5 w-3.5" />
            Guardar
          </Button>
        </div>
      </div>
    </Tabs>
  );
}
