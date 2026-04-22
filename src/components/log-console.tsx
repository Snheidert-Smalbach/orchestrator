import { Pin, PinOff } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LogPayload, Project } from "../lib/types";
import { useAppStore } from "../store/useAppStore";
import { useTranslation } from "../i18n";
import { Button } from "./ui/button";
import { EmptyState } from "./ui/empty-state";
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface LogConsoleProps {
  projects: Project[];
  selectedProjectId: string | null;
}

const MATRIX_CHARSET = "ABCDEFGHIJKLMNÑOPQRSTUVWXYZ0123456789¿?¡!<>/=+-{}[]";

function createMatrixColumn(index: number) {
  const length = 18 + (index % 10);
  let text = "";
  for (let cursor = 0; cursor < length; cursor += 1) {
    const character = MATRIX_CHARSET[(index * 7 + cursor * 11) % MATRIX_CHARSET.length];
    text += cursor === length - 1 ? character : `${character}\n`;
  }

  return {
    id: `matrix-${index}`,
    text,
    left: 2 + (index * 4.7) % 94,
    duration: 9 + (index % 6) * 1.4,
    delay: -1 * ((index % 7) * 1.1),
    opacity: 0.14 + (index % 5) * 0.05,
    size: 8 + (index % 3),
  };
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
  const { t } = useTranslation();
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
  const matrixColumns = useMemo(
    () => Array.from({ length: 20 }, (_, index) => createMatrixColumn(index)),
    [],
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
      return (
        <EmptyState
          title={t("console.emptyTitle")}
          description={t("console.emptyDesc")}
          className="mt-4"
        />
      );
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
      <div className="surface-divider flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div>
          <p className="text-[9px] uppercase tracking-[0.22em] text-textSoft">{t("console.section")}</p>
          <h2 className="mt-0.5 text-[12px] font-semibold text-textStrong">{t("console.title")}</h2>
        </div>
        <Button
          type="button"
          variant={followOutput ? "default" : "secondary"}
          size="sm"
          onClick={() => setFollowOutput((current) => !current)}
          title={t("console.pinTitle")}
        >
          {followOutput ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
          {followOutput ? t("console.pinned") : t("console.pin")}
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabsList className="surface-divider overflow-auto bg-ink/30 px-2 py-1 scrollbar-thin">
          <TabsTrigger value="combined" className="font-mono text-[9px]">
            {t("console.combined")}
          </TabsTrigger>
          {projects.map((project) => (
            <TabsTrigger key={project.id} value={project.id} className="font-mono text-[9px]">
              {project.name}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={activeTab} className="min-h-0 flex-1">
          <div className="relative h-full overflow-hidden bg-ink/55">
            <div aria-hidden className="console-matrix">
              {matrixColumns.map((column) => (
                <span
                  key={column.id}
                  className="console-matrix-column"
                  style={{
                    left: `${column.left}%`,
                    opacity: column.opacity,
                    fontSize: `${column.size}px`,
                    ["--matrix-duration" as string]: `${column.duration}s`,
                    ["--matrix-delay" as string]: `${column.delay}s`,
                  }}
                >
                  {column.text}
                </span>
              ))}
            </div>

            <ScrollArea
              className="relative z-10 h-full bg-[linear-gradient(180deg,rgba(2,8,20,0.18),rgba(2,8,20,0.08))]"
              viewportClassName="px-3 py-2"
              viewportRef={(node) => setViewportRef(activeTab, node)}
              viewportProps={{
                onScroll: (event) => handleViewportScroll(activeTab, event.currentTarget),
              }}
            >
              {renderEntries(activeEntries, includeProjectName)}
            </ScrollArea>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
