export type RuntimeKind = "node" | "docker_compose" | "unknown";
export type PackageManager = "npm" | "pnpm" | "yarn" | "cargo" | "unknown";
export type RunMode = "script" | "command";
export type ReadinessMode = "none" | "delay" | "port";
export type LaunchMode = "service" | "record" | "mock" | "unknown";
export type MockMatchMode = "auto" | "strict" | "path" | "unknown";
export type MockSource = "captured" | "manual" | "unknown";
export type MockKind = "rest" | "graphql" | "http_other" | "unknown";
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

export interface MockHeader {
  name: string;
  value: string;
}

export interface ProjectMock {
  id: string;
  name: string;
  source: MockSource;
  kind: MockKind;
  recordedAt: string;
  notes: string | null;
  requestMethod: string;
  requestPath: string;
  requestQuery: string;
  requestHeaders: MockHeader[];
  requestContentType: string | null;
  requestBody: string;
  responseStatusCode: number;
  responseReasonPhrase: string;
  responseHeaders: MockHeader[];
  responseContentType: string | null;
  responseBody: string;
}

export interface ProjectMockSummary {
  totalCount: number;
  graphqlCount: number;
  restCount: number;
  manualCount: number;
  capturedCount: number;
  lastUpdatedAt: string | null;
  routes: string[];
}

export interface ProjectMockCollection {
  summary: ProjectMockSummary;
  mocks: ProjectMock[];
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
  launchMode: LaunchMode;
  mockMatchMode: MockMatchMode;
  mockUnmatchedStatus: number;
  startupPhase: number;
  catalogOrder: number;
  waitForPreviousReady: boolean;
  enabled: boolean;
  tags: string[];
  mockSummary: ProjectMockSummary;
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
  sortOrder: number;
  readOnly: boolean;
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
