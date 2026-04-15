import type { ProcessDiagnostic, Project, ProjectResourceUsage } from "./types";

export type ThemeMode = "dark" | "light";
export type ThemeFamily = "aurora" | "ember" | "harbor" | "terminal";
export type AlertTone = "warn" | "danger" | "info";

export type ThemeDefinition = {
  id: ThemeFamily;
  label: string;
  description: string;
  preview: [string, string, string];
};

export type QuickProfile = {
  id: string;
  label: string;
  description: string;
  projectIds: string[];
};

export type AlertEntry = {
  id: string;
  tone: AlertTone;
  title: string;
  description: string;
};

export const THEME_MODE_STORAGE_KEY = "back-orchestrator.theme-mode";
export const THEME_FAMILY_STORAGE_KEY = "back-orchestrator.theme-family";
export const LEGACY_THEME_STORAGE_KEY = "back-orchestrator.theme";
export const DEFAULT_THEME_FAMILY: ThemeFamily = "aurora";

export const THEME_DEFINITIONS: ThemeDefinition[] = [
  {
    id: "aurora",
    label: "Aurora",
    description: "neon frio y capas atmosfericas",
    preview: ["#23d5f6", "#8bff4d", "#0f172a"],
  },
  {
    id: "ember",
    label: "Brasa",
    description: "editorial calido sobre cobre y papel",
    preview: ["#ffb347", "#c2410c", "#4a1d12"],
  },
  {
    id: "harbor",
    label: "Puerto",
    description: "marino tecnico con acentos industriales",
    preview: ["#14b8a6", "#fb923c", "#082f49"],
  },
  {
    id: "terminal",
    label: "CRT",
    description: "retro terminal con fosforo y scanlines",
    preview: ["#4ade80", "#bef264", "#06110b"],
  },
];

export function isThemeFamily(value: string | null): value is ThemeFamily {
  return THEME_DEFINITIONS.some((theme) => theme.id === value);
}

export function resolveInitialThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "dark";
  }

  const saved = window.localStorage.getItem(THEME_MODE_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  if (saved === "dark" || saved === "light") {
    return saved;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveInitialThemeFamily(): ThemeFamily {
  if (typeof window === "undefined") {
    return DEFAULT_THEME_FAMILY;
  }

  const saved = window.localStorage.getItem(THEME_FAMILY_STORAGE_KEY);
  return isThemeFamily(saved) ? saved : DEFAULT_THEME_FAMILY;
}

export function createWorkspaceId() {
  return `workspace-${Math.random().toString(36).slice(2, 10)}`;
}

export function detectPortConflicts(projects: Project[]) {
  const grouped = new Map<number, string[]>();
  for (const project of projects) {
    if (!project.enabled || project.port == null) continue;
    const current = grouped.get(project.port) ?? [];
    grouped.set(project.port, [...current, project.id]);
  }

  const conflictedProjectIds = new Set<string>();
  for (const [, ids] of grouped.entries()) {
    if (ids.length > 1) {
      ids.forEach((id) => conflictedProjectIds.add(id));
    }
  }

  return conflictedProjectIds;
}

export function collectDependencyClosure(projects: Project[], projectId: string) {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const ordered: string[] = [];
  const seen = new Set<string>();
  const stack = [projectId];

  while (stack.length) {
    const currentId = stack.pop();
    if (!currentId || seen.has(currentId)) {
      continue;
    }

    const project = byId.get(currentId);
    if (!project) {
      continue;
    }

    seen.add(currentId);
    for (const dependency of [...project.dependencies].reverse()) {
      if (dependency.requiredForStart) {
        stack.push(dependency.dependsOnProjectId);
      }
    }
    ordered.push(currentId);
  }

  return ordered.reverse();
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").toLowerCase();
}

function pathHasDirectory(path: string, segment: string) {
  return normalizePath(path)
    .split("/")
    .filter(Boolean)
    .includes(segment.toLowerCase());
}

export function buildQuickProfiles(projects: Project[], selectedProjectId: string | null) {
  const enabledProjectIds = projects.filter((project) => project.enabled).map((project) => project.id);
  const backendProjectIds = projects
    .filter((project) => project.enabled && pathHasDirectory(project.rootPath, "BACK"))
    .map((project) => project.id);
  const frontendProjectIds = projects
    .filter((project) => project.enabled && pathHasDirectory(project.rootPath, "FRONT"))
    .map((project) => project.id);

  const profiles: QuickProfile[] = [];

  if (selectedProjectId) {
    const dependencyClosure = collectDependencyClosure(projects, selectedProjectId);
    if (dependencyClosure.length) {
      profiles.push({
        id: "selected-deps",
        label: "Seleccion + deps",
        description: "Arranca solo el proyecto seleccionado y sus dependencias requeridas.",
        projectIds: dependencyClosure,
      });
    }
  }

  if (backendProjectIds.length) {
    profiles.push({
      id: "backend",
      label: "Backend",
      description: "Arranca solo los servicios habilitados detectados como backend.",
      projectIds: backendProjectIds,
    });
  }

  if (frontendProjectIds.length) {
    profiles.push({
      id: "frontend",
      label: "Frontend",
      description: "Arranca solo los servicios habilitados detectados como frontend.",
      projectIds: frontendProjectIds,
    });
  }

  if (enabledProjectIds.length) {
    profiles.push({
      id: "all-enabled",
      label: "Habilitados",
      description: "Arranca todos los servicios habilitados.",
      projectIds: enabledProjectIds,
    });
  }

  return profiles;
}

export function toProjectResourceMap(entries: ProjectResourceUsage[] | undefined) {
  return Object.fromEntries((entries ?? []).map((entry) => [entry.projectId, entry])) as Record<string, ProjectResourceUsage>;
}

export function formatMemory(valueMb: number, precision = 1) {
  if (valueMb >= 1024) {
    return `${(valueMb / 1024).toFixed(precision)} GB`;
  }

  return `${valueMb.toFixed(precision)} MB`;
}

export function compactCommand(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 88 ? `${normalized.slice(0, 85)}...` : normalized;
}

export function describeNodeProcess(process: ProcessDiagnostic) {
  return `PID ${process.pid} · ${formatMemory(process.workingSetMb)} · ${compactCommand(process.command)}`;
}
