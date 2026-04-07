use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! enum_codec {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }

        impl $name {
            pub fn as_str(&self) -> &'static str {
                match self { $(Self::$variant => $value),+ }
            }

            pub fn from_db(value: &str) -> Self {
                match value { $($value => Self::$variant),+, _ => Self::Unknown }
            }
        }
    };
}

enum_codec!(RuntimeKind {
    Node => "node",
    DockerCompose => "docker_compose",
    Unknown => "unknown"
});

enum_codec!(PackageManager {
    Npm => "npm",
    Pnpm => "pnpm",
    Yarn => "yarn",
    Cargo => "cargo",
    Unknown => "unknown"
});

enum_codec!(RunMode {
    Script => "script",
    Command => "command",
    Unknown => "unknown"
});

enum_codec!(ReadinessMode {
    None => "none",
    Delay => "delay",
    Port => "port",
    Unknown => "unknown"
});

enum_codec!(ProjectStatus {
    Idle => "idle",
    Starting => "starting",
    Running => "running",
    Ready => "ready",
    Stopped => "stopped",
    Failed => "failed",
    Unknown => "unknown"
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEnvOverride {
    pub id: String,
    pub key: String,
    pub value: String,
    pub is_secret: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDependency {
    pub id: String,
    pub depends_on_project_id: String,
    pub required_for_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOrderUpdate {
    pub project_id: String,
    pub catalog_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub runtime_kind: RuntimeKind,
    pub package_manager: PackageManager,
    pub run_mode: RunMode,
    pub run_target: String,
    pub shell: String,
    pub selected_env_file: Option<String>,
    pub available_env_files: Vec<String>,
    pub available_scripts: Vec<String>,
    pub port: Option<u16>,
    pub readiness_mode: ReadinessMode,
    pub readiness_value: Option<String>,
    pub startup_phase: i64,
    pub catalog_order: i64,
    pub wait_for_previous_ready: bool,
    pub enabled: bool,
    pub tags: Vec<String>,
    pub env_overrides: Vec<ProjectEnvOverride>,
    pub dependencies: Vec<ProjectDependency>,
    pub status: ProjectStatus,
    pub last_exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProject {
    pub name: String,
    pub root_path: String,
    pub runtime_kind: RuntimeKind,
    pub package_manager: PackageManager,
    pub env_files: Vec<String>,
    pub available_scripts: Vec<String>,
    pub suggested_run_mode: RunMode,
    pub suggested_run_target: String,
    pub suggested_env_file: Option<String>,
    pub suggested_port: Option<u16>,
    pub has_docker_compose: bool,
    pub already_imported: bool,
}

impl Project {
    pub fn from_detected(detected: &DetectedProject) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: detected.name.clone(),
            root_path: detected.root_path.clone(),
            runtime_kind: detected.runtime_kind.clone(),
            package_manager: detected.package_manager.clone(),
            run_mode: detected.suggested_run_mode.clone(),
            run_target: detected.suggested_run_target.clone(),
            shell: "cmd".to_string(),
            selected_env_file: detected.suggested_env_file.clone(),
            available_env_files: detected.env_files.clone(),
            available_scripts: detected.available_scripts.clone(),
            port: detected.suggested_port,
            readiness_mode: if detected.suggested_port.is_some() {
                ReadinessMode::Port
            } else {
                ReadinessMode::None
            },
            readiness_value: detected.suggested_port.map(|port| port.to_string()),
            startup_phase: 1,
            catalog_order: 0,
            wait_for_previous_ready: false,
            enabled: true,
            tags: Vec::new(),
            env_overrides: Vec::new(),
            dependencies: Vec::new(),
            status: ProjectStatus::Idle,
            last_exit_code: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub project_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub default_roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: Settings,
    pub projects: Vec<Project>,
    pub presets: Vec<Preset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDiagnostic {
    pub project_id: Option<String>,
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub command: String,
    pub working_set_mb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectResourceUsage {
    pub project_id: String,
    pub project_name: String,
    pub tracked_pid: Option<u32>,
    pub total_processes: u32,
    pub total_node_processes: u32,
    pub total_working_set_mb: f64,
    pub total_node_working_set_mb: f64,
    pub command_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiagnostics {
    pub collected_at: String,
    pub total_node_processes: u32,
    pub total_node_working_set_mb: f64,
    pub total_physical_memory_mb: f64,
    pub free_physical_memory_mb: f64,
    pub project_resources: Vec<ProjectResourceUsage>,
    pub top_node_processes: Vec<ProcessDiagnostic>,
    pub untracked_node_processes: Vec<ProcessDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusPayload {
    pub project_id: String,
    pub status: ProjectStatus,
    pub exit_code: Option<i32>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPayload {
    pub project_id: String,
    pub stream: String,
    pub line: String,
    pub timestamp: String,
}
