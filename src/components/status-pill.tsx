import clsx from "clsx";
import type { ProjectStatus } from "../lib/types";

const styles: Record<ProjectStatus, string> = {
  idle: "bg-panelSoft/70 text-textMuted",
  starting: "bg-warn/16 text-warn shadow-[inset_0_0_0_1px_rgba(250,204,21,0.18)]",
  running: "bg-info/16 text-info shadow-[inset_0_0_0_1px_rgba(35,213,246,0.18)]",
  ready: "bg-ok/16 text-ok shadow-[inset_0_0_0_1px_rgba(34,197,94,0.18)]",
  stopped: "bg-panelSoft/70 text-textMuted",
  failed: "bg-danger/16 text-danger shadow-[inset_0_0_0_1px_rgba(248,113,113,0.2)]",
};

const dotStyles: Record<ProjectStatus, string> = {
  idle: "bg-textSoft/55",
  starting: "bg-warn",
  running: "bg-info",
  ready: "bg-ok",
  stopped: "bg-textSoft/55",
  failed: "bg-danger",
};

const labels: Record<ProjectStatus, string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Running",
  ready: "Ready",
  stopped: "Stopped",
  failed: "Failed",
};

export function StatusPill({ status }: { status: ProjectStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.14em]",
        styles[status],
      )}
    >
      <span className={clsx("h-1.5 w-1.5 shrink-0", dotStyles[status])} />
      {labels[status]}
    </span>
  );
}
