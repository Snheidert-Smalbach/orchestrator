import { useEffect, useRef, useState } from "react";
import { Folder, Info, Play, RefreshCw, Rocket, Save, Square, Trash2, TriangleAlert, type LucideIcon } from "lucide-react";
import { inspectProject } from "../lib/tauri";
import type { DetectedProject, Preset, Project, ProjectEnvOverride, ProjectResourceUsage } from "../lib/types";
import { useTranslation } from "../i18n";
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

type DetailMetaChipTone = "default" | "info" | "warn" | "danger";

const detailMetaChipToneClassName: Record<DetailMetaChipTone, string> = {
  default: "text-textMuted",
  info: "!border-info/24 !bg-info/10 !text-info",
  warn: "!border-warn/24 !bg-warn/12 !text-warn",
  danger: "!border-danger/24 !bg-danger/12 !text-danger",
};

function DetailMetaChip({
  icon: Icon,
  label,
  title,
  tone = "default",
  className = "",
  spin = false,
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  tone?: DetailMetaChipTone;
  className?: string;
  spin?: boolean;
}) {
  return (
    <span
      title={title ?? label}
      className={[
        "surface-chip inline-flex min-w-0 items-center gap-1.5 px-2 py-1 text-[10px] font-medium leading-none",
        detailMetaChipToneClassName[tone],
        className,
      ].join(" ")}
    >
      <Icon className={["h-3 w-3 shrink-0", spin ? "animate-spin" : ""].join(" ")} />
      <span className="truncate">{label}</span>
    </span>
  );
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
  const { t } = useTranslation();
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
      setMetadataError(error instanceof Error ? error.message : t("detail.errorLoadMetadata"));
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
      const message = error instanceof Error ? error.message : t("detail.errorSave");
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
          title={t("detail.emptyTitle")}
          description={t("detail.emptyDesc")}
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
      ? t("detail.saveSaving")
      : saveState === "pending"
        ? t("detail.savePending")
        : saveState === "error"
          ? saveError ?? t("detail.saveError")
          : t("detail.saveActive");

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
      <div className="surface-divider px-4 py-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[10px] uppercase tracking-[0.24em] text-textSoft">{t("detail.section")}</p>
              <StatusPill status={draft.status} />
              <Badge variant="secondary">{draft.runtimeKind}</Badge>
            </div>
            <h2 className="mt-1 truncate text-[15px] font-semibold text-textStrong">{draft.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <DetailMetaChip icon={Folder} label={draft.rootPath} className="max-w-full sm:max-w-[28rem]" />
              <DetailMetaChip
                icon={Info}
                label={t("detail.metaScripts", { scripts: String(draft.availableScripts.length), env: String(draft.availableEnvFiles.length) })}
                title={t("detail.metaScriptsTitle", { scripts: String(draft.availableScripts.length), env: String(draft.availableEnvFiles.length) })}
              />
              {runtimeMessage ? (
                <DetailMetaChip icon={Info} tone="info" label={runtimeMessage} className="max-w-full sm:max-w-[22rem]" />
              ) : null}
              {canForceStart ? (
                <DetailMetaChip
                  icon={Rocket}
                  tone="warn"
                  label={t("detail.portOccupied")}
                  title={t("detail.portOccupiedTitle")}
                />
              ) : null}
              {showForceStopWarning ? (
                <DetailMetaChip
                  icon={TriangleAlert}
                  tone="danger"
                  label={t("detail.forceSuggested")}
                  title={t("detail.forceSuggestedTitle")}
                />
              ) : null}
              {metadataError ? <DetailMetaChip icon={TriangleAlert} tone="danger" label={t("detail.metadataError")} title={metadataError} /> : null}
              {saveState === "error" ? <DetailMetaChip icon={Save} tone="danger" label={t("detail.saveErrorChip")} title={saveHint} /> : null}
              {isRefreshing ? (
                <DetailMetaChip icon={RefreshCw} tone="info" label={t("detail.readingMetadata")} spin title={t("detail.readingMetadataTitle")} />
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void refreshMetadata(draft, { preferredEnvFile: draft.selectedEnvFile, preferDetectedPort: true })}
              disabled={isRefreshing}
            >
              <RefreshCw className={["h-3.5 w-3.5", isRefreshing ? "animate-spin" : ""].join(" ")} />
              {t("detail.reloadBtn")}
            </Button>
            <Button type="button" variant="success" size="sm" onClick={() => void handleStart()}>
              <Play className="h-3.5 w-3.5" />
              {t("detail.startBtn")}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => void onStop(draft.id)}>
              <Square className="h-3.5 w-3.5" />
              {t("detail.stopBtn")}
            </Button>
            {canForceStart ? (
              <Button type="button" variant="warning" size="sm" onClick={() => void onForceStart(draft.id)}>
                <Rocket className="h-3.5 w-3.5" />
                {t("detail.forceStartBtn")}
              </Button>
            ) : null}
            {!canForceStart && showForceStopAction ? (
              <Button type="button" variant="destructive" size="sm" onClick={() => void onForceStop(draft.id)}>
                <TriangleAlert className="h-3.5 w-3.5" />
                {t("detail.forceStopBtn")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="surface-divider flex shrink-0 items-center gap-2 px-4 py-1.5">
        <TabsList>
          <TabsTrigger value="config">{t("detail.configTab")}</TabsTrigger>
          <TabsTrigger value="mocks">
            {t("detail.mocksTab")}
            <Badge variant="secondary" className="px-1.5 py-0.5 text-[9px]">
              {draft.mockSummary.totalCount}
            </Badge>
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="config" className="min-h-0 flex-1 overflow-auto">
        <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          <FieldLabelWrap>
            <FieldLabel>{t("detail.nameLabel")}</FieldLabel>
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </FieldLabelWrap>

          {draft.runMode === "script" && scriptOptions.length > 0 ? (
            <FieldLabelWrap>
              <FieldLabel>{t("detail.scriptLabel")}</FieldLabel>
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
              <FieldLabel>{t("detail.runTargetLabel")}</FieldLabel>
              <Input value={draft.runTarget} onChange={(event) => setDraft({ ...draft, runTarget: event.target.value })} />
            </FieldLabelWrap>
          )}

          <FieldLabelWrap>
            <FieldLabel>{t("detail.modeLabel")}</FieldLabel>
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
              <option value="script">{t("detail.modeScript")}</option>
              <option value="command">{t("detail.modeCommand")}</option>
            </Select>
          </FieldLabelWrap>

          <FieldLabelWrap>
            <FieldLabel>{t("detail.pkgManagerLabel")}</FieldLabel>
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
            <FieldLabel>{t("detail.envLabel")}</FieldLabel>
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
              <option value="">{t("detail.envNoFile")}</option>
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
                <FieldLabel>{t("detail.portLabel")}</FieldLabel>
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
                <FieldLabel>{t("detail.phaseLabel")}</FieldLabel>
                <Input
                  type="number"
                  value={draft.startupPhase}
                  onChange={(event) => setDraft({ ...draft, startupPhase: Number(event.target.value || 1) })}
                />
              </FieldLabelWrap>

              <FieldLabelWrap>
                <FieldLabel>{t("detail.orderLabel")}</FieldLabel>
                <Input type="number" value={draft.catalogOrder} disabled />
              </FieldLabelWrap>

              <FieldLabelWrap>
                <FieldLabel>{t("detail.readyLabel")}</FieldLabel>
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
              <FieldLabel>{t("detail.launchLabel")}</FieldLabel>
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
              <FieldLabel>{t("detail.mockMatchLabel")}</FieldLabel>
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
              <FieldLabel>{t("detail.missStatusLabel")}</FieldLabel>
              <Input
                type="number"
                value={draft.mockUnmatchedStatus}
                onChange={(event) => setDraft({ ...draft, mockUnmatchedStatus: Number(event.target.value || 404) })}
              />
            </FieldLabelWrap>
          </div>

          <Card tone="accent" className="[grid-column:1/-1] p-4 text-[12px] text-textMuted">
            {draft.launchMode === "service"
              ? t("detail.launchServiceDesc")
              : draft.launchMode === "record"
                ? t("detail.launchRecordDesc")
                : t("detail.launchMockDesc")}
          </Card>

          <Card tone="muted" className="[grid-column:1/-1] p-4">
            <FieldGroup>
              <FieldLabel>{t("detail.processLabel")}</FieldLabel>
              <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">{t("detail.pidLabel")}</p>
                  <p className="mt-1 text-[12px] text-textStrong">{resourceUsage?.trackedPid ?? "n/a"}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">{t("detail.subprocessesLabel")}</p>
                  <p className="mt-1 text-[12px] text-textStrong">
                    {resourceUsage
                      ? t("detail.subprocessesValue", { total: String(resourceUsage.totalProcesses), node: String(resourceUsage.totalNodeProcesses) })
                      : t("detail.subprocessesNone")}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">{t("detail.ramLabel")}</p>
                  <p className="mt-1 text-[12px] text-textStrong">
                    {resourceUsage ? `${resourceUsage.totalWorkingSetMb.toFixed(1)} MB` : "n/a"}
                  </p>
                </div>
                <div className="[grid-column:1/-1] min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.14em] text-textSoft">{t("detail.activeCommandLabel")}</p>
                  <p className="mt-1 truncate text-[12px] text-textMuted" title={resourceUsage?.commandPreview ?? t("detail.subprocessesNone")}>
                    {resourceUsage?.commandPreview ?? t("detail.noProcess")}
                  </p>
                </div>
              </div>
            </FieldGroup>
          </Card>

          <FieldLabelWrap className="[grid-column:1/-1]">
            <FieldLabel>{t("detail.overridesLabel")}</FieldLabel>
            <Textarea rows={6} value={overridesText} onChange={(event) => setOverridesText(event.target.value)} />
            <FieldHint>{t("detail.overridesHint")}</FieldHint>
          </FieldLabelWrap>

          <Card tone="muted" className="[grid-column:1/-1] p-4">
            <FieldGroup>
              <FieldLabel>{t("detail.dependenciesLabel")}</FieldLabel>
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
                    title={t("detail.depsEmptyTitle")}
                    description={t("detail.depsEmptyDesc")}
                  />
                )}
              </div>
            </FieldGroup>
          </Card>

          <Card tone="muted" className="[grid-column:1/-1] p-4">
            <FieldGroup>
              <FieldLabel>{t("detail.workspacesLabel")}</FieldLabel>
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
                  title={t("detail.workspacesEmptyTitle")}
                  description={t("detail.workspacesEmptyDesc")}
                />
              )}
            </FieldGroup>
          </Card>

          <Card tone="muted" className="[grid-column:1/-1] p-4">
            <FieldRow>
              <Checkbox checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })} />
              <div>
                <p className="text-[13px] font-medium text-textStrong">{t("detail.enabledLabel")}</p>
                <p className="text-[11px] text-textMuted">{t("detail.enabledDesc")}</p>
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
                <p className="text-[13px] font-medium text-textStrong">{t("detail.waitReadyLabel")}</p>
                <p className="text-[11px] text-textMuted">{t("detail.waitReadyDesc")}</p>
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
          {t("detail.exitCode", { code: String(draft.lastExitCode ?? "n/a") })} | {saveHint}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" variant="destructive" size="sm" onClick={() => void onDelete(draft.id)}>
            <Trash2 className="h-3.5 w-3.5" />
            {t("detail.deleteBtn")}
          </Button>
          <Button type="button" variant="default" size="sm" onClick={() => void handleSave()}>
            <Save className="h-3.5 w-3.5" />
            {t("detail.saveBtn")}
          </Button>
        </div>
      </div>
    </Tabs>
  );
}
