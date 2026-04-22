import { RefreshCw, TerminalSquare } from "lucide-react";
import { describeNodeProcess, formatMemory } from "../lib/app-shell";
import type { SystemDiagnostics } from "../lib/types";
import { useTranslation } from "../i18n";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { DialogShell } from "./ui/dialog-shell";
import { EmptyState } from "./ui/empty-state";
import { StatCard } from "./ui/stat-card";

export type UsageStat = {
  label: string;
  value: string;
  wide?: boolean;
  valueClassName?: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stats: UsageStat[];
  diagnostics: SystemDiagnostics | null;
  onRefresh: () => void;
};

export function UsageDrawer({ open, onOpenChange, stats, diagnostics, onRefresh }: Props) {
  const { t } = useTranslation();
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      variant="drawer"
      title={t("usage.drawerTitle")}
      description={t("usage.drawerDesc")}
      actions={
        <Button type="button" variant="secondary" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t("usage.refresh")}
        </Button>
      }
      bodyClassName="min-h-0 flex-1 overflow-auto"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {stats.map((stat) => (
          <StatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
            valueClassName={stat.valueClassName}
            className={stat.wide ? "sm:col-span-2" : ""}
          />
        ))}
      </div>

      <div className="mt-4 grid gap-3">
        <Card tone="muted" className="p-4">
          <p className="text-[9px] uppercase tracking-[0.18em] text-textSoft">{t("usage.diagnostics")}</p>
          <p className="mt-2 text-[12px] leading-6 text-textStrong">
            {diagnostics
              ? t("usage.diagnosticsValue", {
                  total: formatMemory(diagnostics.totalPhysicalMemoryMb),
                  free: formatMemory(diagnostics.freePhysicalMemoryMb),
                })
              : t("usage.noDiagnostics")}
          </p>
        </Card>

        {diagnostics?.topNodeProcesses.length ? (
          <Card tone="muted" className="p-4">
            <p className="text-[9px] uppercase tracking-[0.18em] text-textSoft">{t("usage.topNode")}</p>
            <div className="mt-3 grid gap-2">
              {diagnostics.topNodeProcesses.slice(0, 6).map((process) => (
                <div key={`${process.pid}-${process.command}`} className="ui-process-line">
                  {describeNodeProcess(process)}
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <EmptyState
            icon={<TerminalSquare className="h-4 w-4" />}
            title={t("usage.noProcesses")}
            description={t("usage.noProcessesDesc")}
          />
        )}
      </div>
    </DialogShell>
  );
}
