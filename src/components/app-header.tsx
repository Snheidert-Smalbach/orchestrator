import {
  Activity,
  Boxes,
  FolderPlus,
  FolderSearch,
  Play,
  Rocket,
  Square,
  Trash2,
  TriangleAlert,
  Waves,
} from "lucide-react";
import type { Preset } from "../lib/types";
import type { QuickProfile, ThemeDefinition, ThemeFamily, ThemeMode } from "../lib/app-shell";
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
  return (
    <header className="surface-panel shrink-0 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="info" className="px-2 py-1 tracking-[0.24em]">
              <Waves className="h-3 w-3" />
              Back Orchestrator
            </Badge>
            <h1 className="truncate text-[15px] font-semibold tracking-tight text-textStrong">
              Orquestador local de microservicios
            </h1>
          </div>
          <p className="mt-1 max-w-[900px] text-[11px] leading-5 text-textMuted">
            Catálogo, configuración, mocks y observabilidad sobre una capa de UI reusable inspirada en shadcn/studio.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {quickProfiles.length ? (
            <Button type="button" variant="secondary" size="icon" onClick={onOpenQuickActions} title="Abrir acciones rápidas">
              <Boxes className="h-4 w-4" />
              <span className="absolute -right-1 -top-1 min-w-[16px] border border-accent/35 bg-accent/10 px-1 text-[8px] font-semibold text-accent">
                {quickProfiles.length}
              </span>
            </Button>
          ) : null}
          <Button type="button" variant="secondary" size="icon" onClick={onOpenUsage} title="Abrir panel de uso y recursos">
            <Activity className="h-4 w-4" />
          </Button>
          <Button type="button" variant="secondary" size="icon" onClick={onOpenAlerts} title="Abrir avisos y errores">
            <TriangleAlert className={`h-4 w-4 ${alertCount ? "text-warn" : ""}`} />
            {alertCount ? (
              <span className="absolute -right-1 -top-1 min-w-[16px] border border-warn/35 bg-warn/12 px-1 text-[8px] font-semibold text-warn">
                {alertCount}
              </span>
            ) : null}
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
          <Button type="button" variant="default" size="sm" onClick={onCreateWorkspace} title="Crear un nuevo workspace">
            <FolderPlus className="h-3.5 w-3.5" />
            Nuevo workspace
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
          <Button type="button" variant="secondary" size="sm" onClick={onScan} disabled={uiBusy} title="Escanear root actual">
            <FolderSearch className="h-3.5 w-3.5" />
            Escanear
          </Button>
          <Button
            type="button"
            variant="success"
            size="sm"
            onClick={onStart}
            disabled={uiBusy}
            title={selectedPreset && !selectedPreset.readOnly ? `Iniciar ${selectedPreset.name}` : "Iniciar habilitados"}
          >
            <Play className="h-3.5 w-3.5" />
            Iniciar
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onStop}
            disabled={uiBusy}
            title={selectedPreset && !selectedPreset.readOnly ? `Detener ${selectedPreset.name}` : "Detener servicios"}
          >
            <Square className="h-3.5 w-3.5" />
            Detener
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onForceStop}
            disabled={uiBusy}
            title={selectedPreset && !selectedPreset.readOnly ? `Forzar ${selectedPreset.name}` : "Forzar detención"}
          >
            <TriangleAlert className="h-3.5 w-3.5" />
            Forzar
          </Button>
          {forceStartCount ? (
            <Button
              type="button"
              variant="warning"
              size="sm"
              onClick={onForceStart}
              disabled={uiBusy}
              title="Liberar puertos ocupados y volver a iniciar"
            >
              <Rocket className="h-3.5 w-3.5" />
              Reintentar ({forceStartCount})
            </Button>
          ) : null}
          {!selectedPreset?.readOnly ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRemovePreset}
              disabled={uiBusy}
              title="Eliminar workspace actual"
              className="text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Cerrar tab
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
