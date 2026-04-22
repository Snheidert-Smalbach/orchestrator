import { BellRing } from "lucide-react";
import type { AlertEntry } from "../lib/app-shell";
import { useTranslation } from "../i18n";
import { Card } from "./ui/card";
import { DialogShell } from "./ui/dialog-shell";
import { EmptyState } from "./ui/empty-state";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: AlertEntry[];
};

function toneClassName(tone: AlertEntry["tone"]) {
  switch (tone) {
    case "danger":
      return "ui-alert-card ui-alert-card--danger";
    case "warn":
      return "ui-alert-card ui-alert-card--warning";
    default:
      return "ui-alert-card ui-alert-card--info";
  }
}

export function AlertsDrawer({ open, onOpenChange, entries }: Props) {
  const { t } = useTranslation();
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      variant="drawer"
      title={t("alerts.drawerTitle")}
      description={t("alerts.drawerDesc")}
      bodyClassName="min-h-0 flex-1 overflow-auto"
    >
      {entries.length ? (
        <div className="grid gap-2">
          {entries.map((entry) => (
            <Card key={entry.id} className={toneClassName(entry.tone)}>
              <div className="p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em]">{entry.title}</p>
                <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-current/80">{entry.description}</p>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<BellRing className="h-4 w-4" />}
          title={t("alerts.emptyTitle")}
          description={t("alerts.emptyDesc")}
        />
      )}
    </DialogShell>
  );
}
