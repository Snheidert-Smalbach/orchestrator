import * as ScrollArea from "@radix-ui/react-scroll-area";
import * as Tabs from "@radix-ui/react-tabs";
import { Pin, PinOff } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LogPayload, Project } from "../lib/types";
import { useAppStore } from "../store/useAppStore";

interface LogConsoleProps {
  projects: Project[];
  selectedProjectId: string | null;
}

function parseTimestamp(timestamp: string) {
  if (/^\d+$/.test(timestamp)) {
    return new Date(Number(timestamp));
  }
  return new Date(timestamp);
}

function streamClass(stream: LogPayload["stream"]) {
  if (stream === "stderr") {
    return "text-danger";
  }
  if (stream === "system") {
    return "text-accent";
  }
  return "text-textMuted";
}

function streamLabel(stream: LogPayload["stream"]) {
  if (stream === "stderr") {
    return "ERR";
  }
  if (stream === "system") {
    return "SYS";
  }
  return "OUT";
}

function isNearBottom(element: HTMLDivElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
}

export function LogConsole({ projects, selectedProjectId }: LogConsoleProps) {
  const logs = useAppStore((state) => state.logs);
  const combinedLogs = useAppStore((state) => state.combinedLogs);
  const [activeTab, setActiveTab] = useState<string>(selectedProjectId ?? "combined");
  const [followOutput, setFollowOutput] = useState(false);
  const viewportRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const stickToBottomRef = useRef<Record<string, boolean>>({ combined: true });

  useEffect(() => {
    setActiveTab(selectedProjectId ?? "combined");
  }, [selectedProjectId]);

  useEffect(() => {
    if (activeTab === "combined") {
      return;
    }

    if (!projects.some((project) => project.id === activeTab)) {
      setActiveTab("combined");
    }
  }, [activeTab, projects]);

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const activeEntries = activeTab === "combined" ? combinedLogs : logs[activeTab] ?? [];
  const includeProjectName = activeTab === "combined";

  useLayoutEffect(() => {
    const viewport = viewportRefs.current[activeTab];
    if (!viewport) {
      return;
    }

    if (followOutput || (stickToBottomRef.current[activeTab] ?? true)) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [activeEntries.length, activeTab, followOutput]);

  useEffect(() => {
    if (!followOutput) {
      return;
    }

    const viewport = viewportRefs.current[activeTab];
    if (!viewport) {
      return;
    }

    stickToBottomRef.current[activeTab] = true;
    viewport.scrollTop = viewport.scrollHeight;
  }, [activeTab, followOutput]);

  function setViewportRef(tabId: string, node: HTMLDivElement | null) {
    viewportRefs.current[tabId] = node;
    if (node && (followOutput || (stickToBottomRef.current[tabId] ?? true))) {
      node.scrollTop = node.scrollHeight;
    }
  }

  function handleViewportScroll(tabId: string, element: HTMLDivElement) {
    if (followOutput) {
      stickToBottomRef.current[tabId] = true;
      return;
    }

    stickToBottomRef.current[tabId] = isNearBottom(element);
  }

  function renderEntries(entries: LogPayload[], includeProjectName: boolean) {
    if (!entries.length) {
      return <p className="font-mono text-[10px] text-textSoft">sin salida todavia</p>;
    }

    return (
      <div className="font-mono text-[10px] leading-[1.3]">
        {entries.map((entry, index) => {
          const timestamp = parseTimestamp(entry.timestamp).toLocaleTimeString("es-CO", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });

          return (
            <div
              key={`${entry.projectId}-${entry.timestamp}-${index}`}
              className="grid items-start gap-x-2 py-px md:grid-cols-[auto_auto_1fr]"
            >
              <span className="text-[9px] text-textSoft/90">[{timestamp}]</span>
              <span className={["text-[9px] uppercase tracking-[0.18em]", streamClass(entry.stream)].join(" ")}>
                {streamLabel(entry.stream)}
              </span>
              <span className="break-words text-textStrong">
                {includeProjectName ? (
                  <span className="mr-2 text-[9px] uppercase tracking-[0.12em] text-accent/95">
                    {projectNames.get(entry.projectId) ?? entry.projectId}
                  </span>
                ) : null}
                {entry.line}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="surface-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="surface-divider flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
        <div>
          <p className="text-[9px] uppercase tracking-[0.22em] text-textSoft">Observabilidad</p>
          <h2 className="mt-0.5 text-[11px] font-semibold text-textStrong">Consola de salida</h2>
        </div>
        <button
          type="button"
          className={[
            "inline-flex items-center gap-1 border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] transition",
            followOutput
              ? "border-accent/40 bg-accent/10 text-accent"
              : "border-line bg-panelSoft/75 text-textMuted hover:bg-panelSoft",
          ].join(" ")}
          onClick={() => setFollowOutput((current) => !current)}
          title="Mantener la consola pegada al final"
        >
          {followOutput ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
          {followOutput ? "Pegada abajo" : "Fijar abajo"}
        </button>
      </div>

      <Tabs.Root value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Tabs.List className="surface-divider flex flex-wrap gap-1 overflow-auto bg-ink/30 px-2 py-1 scrollbar-thin">
          <Tabs.Trigger
            value="combined"
            className="border border-transparent px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-textSoft transition data-[state=active]:border-accent/30 data-[state=active]:bg-accent/10 data-[state=active]:text-accent"
          >
            Combinado
          </Tabs.Trigger>
          {projects.map((project) => (
            <Tabs.Trigger
              key={project.id}
              value={project.id}
              className="border border-transparent px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-textSoft transition data-[state=active]:border-accent/30 data-[state=active]:bg-accent/10 data-[state=active]:text-accent"
            >
              {project.name}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value={activeTab} className="min-h-0 flex-1">
          <ScrollArea.Root className="h-full bg-ink/55">
            <ScrollArea.Viewport
              ref={(node) => setViewportRef(activeTab, node)}
              className="h-full px-2 py-1.5"
              onScroll={(event) => handleViewportScroll(activeTab, event.currentTarget)}
            >
              {renderEntries(activeEntries, includeProjectName)}
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar orientation="vertical" className="w-1.5 bg-transparent">
              <ScrollArea.Thumb className="bg-line/55" />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
