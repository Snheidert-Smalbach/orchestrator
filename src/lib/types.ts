export type RuntimeKind = "node" | "docker_compose" | "unknown";
export type PackageManager = "npm" | "pnpm" | "yarn" | "cargo" | "unknown";
export type RunMode = "script" | "command";
export type ReadinessMode = "none" | "delay" | "port";
export type ProjectStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "stopped"
  | "failed";

export interface ProjectEnvOverride {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
  enabled: boolean;
}

export interface ProjectDependency {
  id: string;
  dependsOnProjectId: string;
  requiredForStart: boolean;
}

export interface ProjectOrderUpdate {
  projectId: string;
  catalogOrder: number;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  runtimeKind: RuntimeKind;
  packageManager: PackageManager;
  runMode: RunMode;
  runTarget: string;
  shell: string;
  selectedEnvFile: string | null;
  availableEnvFiles: string[];
  availableScripts: string[];
  port: number | null;
  readinessMode: ReadinessMode;
  readinessValue: string | null;
  startupPhase: number;
  catalogOrder: number;
  waitForPreviousReady: boolean;
  enabled: boolean;
  tags: string[];
  envOverrides: ProjectEnvOverride[];
  dependencies: ProjectDependency[];
  status: ProjectStatus;
  lastExitCode: number | null;
}

export interface DetectedProject {
  name: string;
  rootPath: string;
  runtimeKind: RuntimeKind;
  packageManager: PackageManager;
  envFiles: string[];
  availableScripts: string[];
  suggestedRunMode: RunMode;
  suggestedRunTarget: string;
  suggestedEnvFile: string | null;
  suggestedPort: number | null;
  hasDockerCompose: boolean;
  alreadyImported: boolean;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  projectIds: string[];
}

export interface Settings {
  defaultRoots: string[];
}

export interface Snapshot {
  settings: Settings;
  projects: Project[];
  presets: Preset[];
}

export interface ProcessDiagnostic {
  projectId: string | null;
  pid: number;
  parentPid: number | null;
  name: string;
  command: string;
  workingSetMb: number;
}

export interface ProjectResourceUsage {
  projectId: string;
  projectName: string;
  trackedPid: number | null;
  totalProcesses: number;
  totalNodeProcesses: number;
  totalWorkingSetMb: number;
  totalNodeWorkingSetMb: number;
  commandPreview: string | null;
}

export interface SystemDiagnostics {
  collectedAt: string;
  totalNodeProcesses: number;
  totalNodeWorkingSetMb: number;
  totalPhysicalMemoryMb: number;
  freePhysicalMemoryMb: number;
  projectResources: ProjectResourceUsage[];
  topNodeProcesses: ProcessDiagnostic[];
  untrackedNodeProcesses: ProcessDiagnostic[];
}

export interface RuntimeStatusPayload {
  projectId: string;
  status: ProjectStatus;
  exitCode: number | null;
  message: string | null;
}

export interface LogPayload {
  projectId: string;
  stream: "stdout" | "stderr" | "system";
  line: string;
  timestamp: string;
}
