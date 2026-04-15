import type { ProjectStatus } from "../lib/types";
import { Badge } from "./ui/badge";

const variants: Record<ProjectStatus, Parameters<typeof Badge>[0]["variant"]> = {
  idle: "secondary",
  starting: "warning",
  running: "info",
  ready: "success",
  stopped: "secondary",
  failed: "danger",
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
    <Badge variant={variants[status]} className="gap-1.5 px-2 py-1 text-[9px]">
      <span className={["h-1.5 w-1.5 shrink-0 rounded-full", dotStyles[status]].join(" ")} />
      {labels[status]}
    </Badge>
  );
}
