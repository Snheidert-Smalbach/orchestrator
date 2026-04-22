import {
  Activity,
  Boxes,
  FolderPlus,
  FolderSearch,
  Globe,
  Play,
  Rocket,
  Square,
  Trash2,
  TriangleAlert,
  Waves,
} from "lucide-react";
import type { Preset } from "../lib/types";
import type { QuickProfile, ThemeDefinition, ThemeFamily, ThemeMode } from "../lib/app-shell";
import { useTranslation } from "../i18n";
import { AppThemePicker } from "./app-theme-picker";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type Props = {
  presets: Preset[];
  selectedPresetId: string;
  selectedPreset: Preset | null;
  quickProfiles: QuickProfile[];
  alertCount: number;
  forceStartCount: number;
  uiBusy: boolean;
  activeTheme: ThemeDefinition;
  themeMode: ThemeMode;
  themeFamily: ThemeFamily;
  themes: ThemeDefinition[];
  onThemeModeChange: (mode: ThemeMode) => void;
  onThemeFamilyChange: (family: ThemeFamily) => void;
  onOpenQuickActions: () => void;
  onOpenUsage: () => void;
  onOpenAlerts: () => void;
  onCreateWorkspace: () => void;
  onSelectPreset: (presetId: string) => void;
  onScan: () => void;
  onStart: () => void;
  onStop: () => void;
  onForceStop: () => void;
  onForceStart: () => void;
  onRemovePreset: () => void;
};

export function AppHeader({
  presets,
  selectedPresetId,
  selectedPreset,
  quickProfiles,
  alertCount,
  forceStartCount,
  uiBusy,
  activeTheme,
  themeMode,
  themeFamily,
  themes,
  onThemeModeChange,
  onThemeFamilyChange,
  onOpenQuickActions,
  onOpenUsage,
  onOpenAlerts,
  onCreateWorkspace,
  onSelectPreset,
  onScan,
  onStart,
  onStop,
  onForceStop,
  onForceStart,
  onRemovePreset,
}: Props) {
  const { t, language, setLanguage } = useTranslation();

  return (
    <header className="surface-panel shrink-0 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info" className="px-2 py-1 tracking-[0.24em]">
              <Waves className="h-3 w-3" />
              {t("header.appName")}
            </Badge>
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-textStrong">
              {t("header.title")}
            </h1>
          </div>
          <p className="mt-1 max-w-[900px] text-[11px] leading-5 text-textMuted">
            {t("header.subtitle")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {quickProfiles.length ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={onOpenQuickActions}
              title={t("header.openQuickActions")}
            >
              <Boxes className="h-4 w-4" />
              <span className="absolute -right-1 -top-1 min-w-[16px] border border-accent/35 bg-accent/10 px-1 text-[8px] font-semibold text-accent">
                {quickProfiles.length}
              </span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={onOpenUsage}
            title={t("header.openUsage")}
          >
            <Activity className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={onOpenAlerts}
            title={t("header.openAlerts")}
          >
            <TriangleAlert className={`h-4 w-4 ${alertCount ? "text-warn" : ""}`} />
            {alertCount ? (
              <span className="absolute -right-1 -top-1 min-w-[16px] border border-warn/35 bg-warn/12 px-1 text-[8px] font-semibold text-warn">
                {alertCount}
              </span>
            ) : null}
          </Button>

          {/* ── Language selector ──────────────────────────────────── */}
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={() => setLanguage(language === "en" ? "es" : "en")}
            title={t("lang.switchTo")}
            className="relative gap-0 font-mono text-[9px] font-semibold tracking-[0.08em]"
          >
            <Globe className="h-3 w-3" />
            <span className="ml-0.5">{language.toUpperCase()}</span>
          </Button>

          <AppThemePicker
            activeTheme={activeTheme}
            themeMode={themeMode}
            themeFamily={themeFamily}
            themes={themes}
            onThemeModeChange={onThemeModeChange}
            onThemeFamilyChange={onThemeFamilyChange}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-thin pb-0.5">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onCreateWorkspace}
            title={t("header.newWorkspaceTitle")}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            {t("header.newWorkspace")}
          </Button>

          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={[
                "ui-workspace-tab",
                preset.id === selectedPresetId ? "ui-workspace-tab--active" : "",
              ].join(" ")}
              onClick={() => onSelectPreset(preset.id)}
              title={`${preset.name} (${preset.projectIds.length})`}
            >
              <span>{preset.name}</span>
              <span className="text-[9px] text-textSoft">{preset.projectIds.length}</span>
            </button>
          ))}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onScan}
            disabled={uiBusy}
            title={t("header.scanTitle")}
          >
            <FolderSearch className="h-3.5 w-3.5" />
            {t("header.scan")}
          </Button>
          <Button
            type="button"
            variant="success"
            size="sm"
            onClick={onStart}
            disabled={uiBusy}
            title={
              selectedPreset && !selectedPreset.readOnly
                ? t("header.startPreset", { name: selectedPreset.name })
                : t("header.startAll")
            }
          >
            <Play className="h-3.5 w-3.5" />
            {t("header.start")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onStop}
            disabled={uiBusy}
            title={
              selectedPreset && !selectedPreset.readOnly
                ? t("header.stopPreset", { name: selectedPreset.name })
                : t("header.stopAll")
            }
          >
            <Square className="h-3.5 w-3.5" />
            {t("header.stop")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onForceStop}
            disabled={uiBusy}
            title={
              selectedPreset && !selectedPreset.readOnly
                ? t("header.forcePreset", { name: selectedPreset.name })
                : t("header.forceAll")
            }
          >
            <TriangleAlert className="h-3.5 w-3.5" />
            {t("header.force")}
          </Button>
          {forceStartCount ? (
            <Button
              type="button"
              variant="warning"
              size="sm"
              onClick={onForceStart}
              disabled={uiBusy}
              title={t("header.retryTitle")}
            >
              <Rocket className="h-3.5 w-3.5" />
              {t("header.retry", { count: forceStartCount })}
            </Button>
          ) : null}
          {!selectedPreset?.readOnly ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemovePreset}
              disabled={uiBusy}
              title={t("header.closeTabTitle")}
              className="text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("header.closeTab")}
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
