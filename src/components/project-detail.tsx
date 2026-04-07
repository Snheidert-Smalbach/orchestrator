import { useEffect, useRef, useState } from "react";
import { Play, RefreshCw, Rocket, Save, Square, Trash2, TriangleAlert } from "lucide-react";
import { inspectProject } from "../lib/tauri";
import type { DetectedProject, Project, ProjectEnvOverride, ProjectResourceUsage } from "../lib/types";
import { StatusPill } from "./status-pill";

type SaveOptions = {
  quiet?: boolean;
};

type Props = {
  project: Project | null;
  resourceUsage: ProjectResourceUsage | null;
  runtimeMessage: string | null;
  allProjects: Project[];
  canForceStop: boolean;
  canForceStart: boolean;
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
  const { status: _status, lastExitCode: _lastExitCode, ...config } = payload;
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
    (
      !project.runTarget ||
      (detected.availableScripts.length > 0 && !detected.availableScripts.includes(project.runTarget))
    );

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
  onSave,
  onStart,
  onStop,
  onForceStop,
  onForceStart,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<Project | null>(project);
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
      const detected = await inspectProject(
        baseProject.rootPath,
        options?.preferredEnvFile ?? baseProject.selectedEnvFile,
      );
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
      setMetadataError(
        error instanceof Error ? error.message : "No fue posible releer scripts y variables del proyecto.",
      );
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
      <div className="surface-panel p-5 text-sm text-textMuted">
        Selecciona un proyecto para editar su configuracion.
      </div>
    );
  }

  const otherProjects = allProjects.filter((entry) => entry.id !== draft.id);
  const scriptOptions = buildScriptOptions(draft);
  const fieldClassName = "surface-chip w-full px-3 py-2 text-[13px] text-textStrong";
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
    <div className="surface-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="surface-divider flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[10px] uppercase tracking-[0.24em] text-textSoft">Detalle</p>
            <StatusPill status={draft.status} />
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
          {canForceStop ? (
            <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-danger">
              <TriangleAlert className="h-3 w-3" />
              La detencion normal no libero el servicio. Puedes usar Forzar para matar el PID o liberar el puerto.
            </p>
          ) : null}
          {metadataError ? <p className="mt-1 text-[11px] text-danger">{metadataError}</p> : null}
          {saveState === "error" ? <p className="mt-1 text-[11px] text-danger">{saveHint}</p> : null}
          {isRefreshing ? <p className="mt-1 text-[11px] text-textMuted">Leyendo metadata del proyecto...</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            className="surface-chip inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-textStrong"
            onClick={() => void refreshMetadata(draft, { preferredEnvFile: draft.selectedEnvFile, preferDetectedPort: true })}
            disabled={isRefreshing}
          >
            <RefreshCw className={["h-3.5 w-3.5", isRefreshing ? "animate-spin" : ""].join(" ")} /> Recargar
          </button>
          <button className="inline-flex items-center gap-1.5 border border-ok/40 bg-ok/12 px-3 py-2 text-xs font-semibold text-ok" onClick={() => void handleStart()}><Play className="h-3.5 w-3.5" /> Iniciar</button>
          <button className="surface-chip inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-textStrong" onClick={() => void onStop(draft.id)}><Square className="h-3.5 w-3.5" /> Detener</button>
          {canForceStart ? (
            <button className="inline-flex items-center gap-1.5 border border-warn/40 bg-warn/12 px-3 py-2 text-xs font-semibold text-warn" onClick={() => void onForceStart(draft.id)}><Rocket className="h-3.5 w-3.5" /> Forzar e iniciar</button>
          ) : null}
          {!canForceStart && canForceStop ? (
            <button className="inline-flex items-center gap-1.5 border border-danger/40 bg-danger/12 px-3 py-2 text-xs font-semibold text-danger" onClick={() => void onForceStop(draft.id)}><TriangleAlert className="h-3.5 w-3.5" /> Forzar</button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto"><div className="grid gap-3 p-4 xl:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Nombre</span>
          <input className={fieldClassName} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>

        {draft.runMode === "script" && scriptOptions.length > 0 ? (
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Script</span>
            <select
              className={fieldClassName}
              value={draft.runTarget}
              onChange={(event) => setDraft({ ...draft, runTarget: event.target.value })}
            >
              {scriptOptions.map((script) => (
                <option key={script} value={script}>
                  {script}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Run target</span>
            <input className={fieldClassName} value={draft.runTarget} onChange={(event) => setDraft({ ...draft, runTarget: event.target.value })} />
          </label>
        )}

        <label className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Modo</span>
          <select
            className={fieldClassName}
            value={draft.runMode}
            onChange={(event) => {
              const nextRunMode = event.target.value as Project["runMode"];
              setDraft({
                ...draft,
                runMode: nextRunMode,
                runTarget:
                  nextRunMode === "script"
                    ? draft.runTarget || draft.availableScripts[0] || "start:dev"
                    : draft.runTarget,
              });
            }}
          >
            <option value="script">Script</option>
            <option value="command">Comando</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Package manager</span>
          <select className={fieldClassName} value={draft.packageManager} onChange={(event) => setDraft({ ...draft, packageManager: event.target.value as Project["packageManager"] })}>
            <option value="npm">npm</option>
            <option value="pnpm">pnpm</option>
            <option value="yarn">yarn</option>
            <option value="cargo">cargo</option>
            <option value="unknown">unknown</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">.env</span>
          <select
            className={fieldClassName}
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
            {draft.availableEnvFiles.map((envFile) => <option key={envFile} value={envFile}>{envFile}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-4 gap-2.5">
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Puerto</span>
            <input
              type="number"
              className={fieldClassName}
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
          </label>
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Fase</span>
            <input type="number" className={fieldClassName} value={draft.startupPhase} onChange={(event) => setDraft({ ...draft, startupPhase: Number(event.target.value || 1) })} />
          </label>
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Orden</span>
            <input type="number" className={fieldClassName} value={draft.catalogOrder} disabled />
          </label>
          <label className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Ready</span>
            <select
              className={fieldClassName}
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
            </select>
          </label>
        </div>
        <div className="space-y-2 xl:col-span-2">
          <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Proceso</span>
          <div className="surface-panel-soft grid gap-1.5 px-3 py-2 text-[12px] text-textStrong md:grid-cols-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">PID</p>
              <p>{resourceUsage?.trackedPid ?? "n/a"}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">Subprocesos</p>
              <p>{resourceUsage ? `${resourceUsage.totalProcesses} total / ${resourceUsage.totalNodeProcesses} node` : "Sin proceso"}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">RAM</p>
              <p>{resourceUsage ? `${resourceUsage.totalWorkingSetMb.toFixed(1)} MB` : "n/a"}</p>
            </div>
            <div className="min-w-0 md:col-span-3">
              <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">Comando activo</p>
              <p className="truncate text-textMuted" title={resourceUsage?.commandPreview ?? "Sin proceso"}>
                {resourceUsage?.commandPreview ?? "Sin proceso rastreado por el orchestrator"}
              </p>
            </div>
          </div>
        </div>
        <label className="space-y-1.5 xl:col-span-2">
          <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Overrides</span>
          <textarea rows={5} className="surface-chip w-full px-3 py-2 text-[13px] text-textStrong" value={overridesText} onChange={(event) => setOverridesText(event.target.value)} />
        </label>
        <div className="space-y-2 xl:col-span-2">
          <span className="text-[10px] uppercase tracking-[0.16em] text-textSoft">Dependencias</span>
          <div className="grid gap-1.5 md:grid-cols-2">
            {otherProjects.map((entry) => {
              const checked = draft.dependencies.some((dependency) => dependency.dependsOnProjectId === entry.id);
              return (
                <label key={entry.id} className="surface-panel-soft flex items-center justify-between gap-3 px-3 py-2 text-[13px] text-textStrong">
                  <span className="truncate">{entry.name}</span>
                  <input type="checkbox" checked={checked} onChange={(event) => {
                    const dependencies = event.target.checked
                      ? [...draft.dependencies, { id: `${draft.id}-dep-${entry.id}`, dependsOnProjectId: entry.id, requiredForStart: true }]
                      : draft.dependencies.filter((dependency) => dependency.dependsOnProjectId !== entry.id);
                    setDraft({ ...draft, dependencies });
                  }} />
                </label>
              );
            })}
          </div>
        </div>
        <label className="surface-panel-soft flex items-center gap-2.5 px-3 py-2 text-[13px] text-textStrong xl:col-span-2">
          <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
          Habilitado para acciones globales
        </label>
        <label className="surface-panel-soft flex items-center gap-2.5 px-3 py-2 text-[13px] text-textStrong xl:col-span-2">
          <input
            type="checkbox"
            checked={draft.waitForPreviousReady}
            onChange={(event) => setDraft({ ...draft, waitForPreviousReady: event.target.checked })}
          />
          Esperar a que el servicio anterior quede ready en arranques por lote
        </label>
      </div></div>

      <div className="surface-divider-top flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <p className={["text-[11px]", saveState === "error" ? "text-danger" : "text-textSoft"].join(" ")}>Ultimo exit code: {draft.lastExitCode ?? "n/a"} | {saveHint}</p>
        <div className="flex flex-wrap gap-1.5">
          <button className="inline-flex items-center gap-1.5 border border-danger/40 bg-danger/12 px-3 py-2 text-xs font-semibold text-danger" onClick={() => void onDelete(draft.id)}><Trash2 className="h-3.5 w-3.5" /> Eliminar</button>
          <button className="inline-flex items-center gap-1.5 border border-accent/40 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent" onClick={() => void handleSave()}><Save className="h-3.5 w-3.5" /> Guardar</button>
        </div>
      </div>
    </div>
  );
}
