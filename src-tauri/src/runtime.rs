use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    net::TcpListener,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Result};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpStream,
    process::Command,
    time::sleep,
};

use crate::{
    db, diagnostics, mocking,
    models::{
        LaunchMode, LogPayload, PackageManager, Project, ProjectStatus, ReadinessMode, RunMode,
        RuntimeStatusPayload,
    },
    process_control::JobHandle,
    service_graph, AppState,
};

#[derive(Debug, Clone)]
pub struct RunningProcess {
    pub pid: Option<u32>,
    pub job: Option<JobHandle>,
    pub managed_server: Option<mocking::ManagedServerHandle>,
    pub internal_port: Option<u16>,
    pub public_port: Option<u16>,
    pub command_preview: Option<String>,
    /// Milliseconds since epoch of the last stdout/stderr line received.
    /// Used by the readiness check to detect processes that went completely
    /// silent without exiting (stuck during initialisation).
    pub last_output_ms: Arc<AtomicU64>,
}

#[derive(Debug, Default)]
pub struct RuntimeManager {
    pub running: HashMap<String, RunningProcess>,
    pub stopping: HashSet<String>,
}

#[derive(Debug, Clone)]
struct CommandPlan {
    executable: String,
    args: Vec<String>,
    display: String,
}

fn timestamp_now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn emit_status(
    app: &AppHandle,
    project_id: &str,
    status: ProjectStatus,
    exit_code: Option<i32>,
    message: Option<String>,
) {
    let _ = app.emit(
        "project-status",
        RuntimeStatusPayload {
            project_id: project_id.to_string(),
            status,
            exit_code,
            message,
        },
    );
}

fn emit_log(app: &AppHandle, project_id: &str, stream: &str, line: impl Into<String>) {
    let _ = app.emit(
        "project-log",
        LogPayload {
            project_id: project_id.to_string(),
            stream: stream.to_string(),
            line: line.into(),
            timestamp: timestamp_now(),
        },
    );
}

fn resolve_script_target(project: &Project) -> String {
    if project.available_scripts.is_empty() {
        return project.run_target.clone();
    }

    if project
        .available_scripts
        .iter()
        .any(|script| script == &project.run_target)
    {
        return project.run_target.clone();
    }

    for candidate in ["start:local", "start:localenv", "start", "start:dev"] {
        if project
            .available_scripts
            .iter()
            .any(|script| script == candidate)
        {
            return candidate.to_string();
        }
    }

    project
        .available_scripts
        .first()
        .cloned()
        .unwrap_or_else(|| project.run_target.clone())
}

fn resolve_package_manager(project: &Project) -> PackageManager {
    let root = std::path::Path::new(&project.root_path);

    if root.join("package-lock.json").exists() {
        PackageManager::Npm
    } else if root.join("pnpm-lock.yaml").exists() {
        PackageManager::Pnpm
    } else if root.join("yarn.lock").exists() {
        PackageManager::Yarn
    } else {
        project.package_manager.clone()
    }
}

fn manager_command(package_manager: &PackageManager, run_target: &str) -> String {
    match package_manager {
        PackageManager::Npm => format!("npm run {}", run_target),
        PackageManager::Pnpm => format!("pnpm run {}", run_target),
        PackageManager::Yarn => format!("yarn {}", run_target),
        PackageManager::Cargo => format!("cargo {}", run_target),
        PackageManager::Unknown => run_target.to_string(),
    }
}

fn package_manager_executable(package_manager: &PackageManager) -> Option<&'static str> {
    match package_manager {
        PackageManager::Npm => Some(if cfg!(windows) { "npm.cmd" } else { "npm" }),
        PackageManager::Pnpm => Some(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" }),
        PackageManager::Yarn => Some(if cfg!(windows) { "yarn.cmd" } else { "yarn" }),
        PackageManager::Cargo | PackageManager::Unknown => None,
    }
}

fn build_shell_command_plan(project: &Project, command_line: String) -> CommandPlan {
    if cfg!(windows) {
        if project.shell.eq_ignore_ascii_case("powershell") {
            return CommandPlan {
                executable: "powershell.exe".to_string(),
                args: vec![
                    "-NoProfile".to_string(),
                    "-Command".to_string(),
                    command_line.clone(),
                ],
                display: command_line,
            };
        }

        return CommandPlan {
            executable: "cmd.exe".to_string(),
            args: vec!["/C".to_string(), command_line.clone()],
            display: command_line,
        };
    }

    let shell = if project.shell.eq_ignore_ascii_case("bash") {
        "bash"
    } else if project.shell.eq_ignore_ascii_case("zsh") {
        "zsh"
    } else {
        "sh"
    };

    CommandPlan {
        executable: shell.to_string(),
        args: vec!["-lc".to_string(), command_line.clone()],
        display: command_line,
    }
}

fn build_command_plan(project: &Project) -> CommandPlan {
    let resolved_package_manager = resolve_package_manager(project);
    let has_script_target = project
        .available_scripts
        .iter()
        .any(|script| script == &project.run_target);
    let should_run_script = matches!(project.run_mode, RunMode::Script)
        || matches!(project.run_mode, RunMode::Command | RunMode::Unknown) && has_script_target;

    if should_run_script {
        let run_target = resolve_script_target(project);

        if let Some(executable) = package_manager_executable(&resolved_package_manager) {
            let args = match resolved_package_manager {
                PackageManager::Npm | PackageManager::Pnpm => {
                    vec!["run".to_string(), run_target.clone()]
                }
                PackageManager::Yarn => vec![run_target.clone()],
                PackageManager::Cargo | PackageManager::Unknown => Vec::new(),
            };

            return CommandPlan {
                executable: executable.to_string(),
                args,
                display: manager_command(&resolved_package_manager, &run_target),
            };
        }

        return build_shell_command_plan(
            project,
            manager_command(&resolved_package_manager, &run_target),
        );
    }

    build_shell_command_plan(project, project.run_target.clone())
}

fn parse_env_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
        return None;
    }

    let normalized = trimmed.strip_prefix("export ").unwrap_or(trimmed);
    let (key, value) = normalized.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }

    Some((
        key.to_string(),
        value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_string(),
    ))
}

fn parse_env_file(path: &str) -> Result<Vec<(String, String)>> {
    let content = fs::read_to_string(path)?;
    Ok(content.lines().filter_map(parse_env_line).collect())
}

async fn load_environment(state: &AppState, project: &Project) -> Result<HashMap<String, String>> {
    let mut envs = std::env::vars().collect::<HashMap<_, _>>();
    let mut has_explicit_port = false;

    if let Some(env_file) = &project.selected_env_file {
        if std::path::Path::new(env_file).exists() {
            for (key, value) in parse_env_file(env_file)? {
                if key.eq_ignore_ascii_case("PORT") {
                    has_explicit_port = true;
                }
                envs.insert(key, value);
            }
        }
    }

    for env_override in &project.env_overrides {
        if env_override.enabled {
            if env_override.key.eq_ignore_ascii_case("PORT") {
                has_explicit_port = true;
            }
            envs.insert(env_override.key.clone(), env_override.value.clone());
        }
    }

    if let Some(port) = project.port {
        if !has_explicit_port {
            envs.insert("PORT".to_string(), port.to_string());
        }
    }

    let linked_projects = db::list_projects(&state.db_path)?;
    let runtime_public_ports = {
        let runtime = state.runtime.lock().await;
        runtime
            .running
            .iter()
            .map(|(project_id, entry)| {
                (
                    project_id.clone(),
                    entry.public_port.or(entry.internal_port),
                )
            })
            .collect::<HashMap<_, _>>()
    };
    let resolved_links = service_graph::resolve_service_links_for_project(
        &state.db_path,
        project,
        &linked_projects,
        &runtime_public_ports,
    )?;
    for (key, value) in resolved_links {
        envs.insert(key, value);
    }

    Ok(envs)
}

async fn load_environment_for_launch(
    state: &AppState,
    project: &Project,
    forced_port: Option<u16>,
    public_port: Option<u16>,
) -> Result<HashMap<String, String>> {
    let mut envs = load_environment(state, project).await?;

    if let Some(port) = forced_port {
        envs.insert("PORT".to_string(), port.to_string());
        envs.insert("ORCHESTRATOR_UPSTREAM_PORT".to_string(), port.to_string());
    }

    if let Some(port) = public_port {
        envs.insert("ORCHESTRATOR_PUBLIC_PORT".to_string(), port.to_string());
    }

    Ok(envs)
}

fn resolve_command_preview(project: &Project) -> String {
    match project.launch_mode {
        LaunchMode::Mock => format!("orchestrator mock {}", project.port.unwrap_or_default()),
        LaunchMode::Record => format!("orchestrator record {}", project.port.unwrap_or_default()),
        LaunchMode::Service | LaunchMode::Unknown => build_command_plan(project).display,
    }
}

fn request_managed_server_shutdown(entry: &RunningProcess) {
    if let Some(handle) = &entry.managed_server {
        handle.shutdown();
    }
}

async fn wait_for_managed_server_shutdown(entry: &RunningProcess, port: Option<u16>) -> bool {
    if let Some(handle) = &entry.managed_server {
        if !handle.wait_stopped(Duration::from_secs(8)).await {
            return false;
        }
    }

    wait_for_port_release(port).await
}

fn managed_server_stop_failure(project_name: &str, port: Option<u16>) -> String {
    match port {
        Some(port) => format!(
            "Failed to stop {}: managed mock/record server did not release port {}",
            project_name, port
        ),
        None => format!(
            "Failed to stop {}: managed mock/record server did not stop",
            project_name
        ),
    }
}

fn terminate_job_tree(app: &AppHandle, project_id: &str, entry: &RunningProcess) -> Result<bool> {
    let Some(job) = &entry.job else {
        return Ok(false);
    };

    emit_log(app, project_id, "system", "JOB terminate tree");
    job.terminate(1)?;
    Ok(true)
}

async fn runtime_entry(state: &AppState, project_id: &str) -> Option<RunningProcess> {
    state.runtime.lock().await.running.get(project_id).cloned()
}

fn port_is_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

async fn mark_stop_requested(state: &AppState, project_id: &str) {
    state
        .runtime
        .lock()
        .await
        .stopping
        .insert(project_id.to_string());
}

async fn clear_stop_requested(state: &AppState, project_id: &str) {
    state.runtime.lock().await.stopping.remove(project_id);
}

async fn remove_running_process(state: &AppState, project_id: &str) {
    state.runtime.lock().await.running.remove(project_id);
    diagnostics::invalidate_system_diagnostics(state).await;
}

async fn clear_runtime_tracking(state: &AppState, project_id: &str) {
    let mut runtime = state.runtime.lock().await;
    runtime.running.remove(project_id);
    runtime.stopping.remove(project_id);
    drop(runtime);
    diagnostics::invalidate_system_diagnostics(state).await;
}

async fn wait_for_port_release(port: Option<u16>) -> bool {
    let Some(port) = port else {
        return true;
    };

    // 40 × 250 ms = 10 s.  The OS needs time to actually release the socket after
    // the owning process exits; 5 s was occasionally too short on Windows when the
    // node process had keep-alive connections still draining.
    for _ in 0..40 {
        if port_is_available(port) {
            return true;
        }
        sleep(Duration::from_millis(250)).await;
    }

    false
}

fn parse_command_output(output: &std::process::Output) -> (String, String) {
    (
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    )
}

fn output_indicates_missing_process(output: &std::process::Output) -> bool {
    let (stdout, stderr) = parse_command_output(output);
    let combined = format!("{stdout}\n{stderr}").to_ascii_lowercase();

    combined.contains("not found")
        || combined.contains("no running instance")
        || combined.contains("no such process")
        || combined.contains("cannot find the process")
}

fn output_indicates_access_denied(output: &std::process::Output) -> bool {
    let (stdout, stderr) = parse_command_output(output);
    let combined = format!("{stdout}\n{stderr}").to_ascii_lowercase();

    combined.contains("access is denied")
        || combined.contains("access denied")
        || combined.contains("acceso denegado")
        || combined.contains("requested operation requires elevation")
}

fn command_failure_reason(output: &std::process::Output) -> String {
    let (stdout, stderr) = parse_command_output(output);
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "command finished without additional output".to_string()
    }
}

/// Only called from `if cfg!(windows)` branches; the attribute silences the
/// dead-code lint on Linux / macOS builds without removing the function (it
/// must stay visible for the type-checker on all platforms).
#[allow(dead_code)]
async fn is_windows_administrator() -> Result<bool> {
    let output = Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-Command")
        .arg("[bool](([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))")
        .output()
        .await?;

    if !output.status.success() {
        return Err(anyhow!(command_failure_reason(&output)));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim()
        .eq_ignore_ascii_case("true"))
}

#[allow(dead_code)]
async fn force_kill_pid_elevated_windows(
    app: &AppHandle,
    project_id: &str,
    pid: u32,
) -> Result<std::process::Output> {
    let taskkill_path = std::env::var("SystemRoot")
        .map(|root| format!(r"{root}\System32\taskkill.exe"))
        .unwrap_or_else(|_| "taskkill.exe".to_string());
    let powershell_script = format!(
        concat!(
            "$ErrorActionPreference = 'Stop'; ",
            "try {{ ",
            "$process = Start-Process -FilePath '{}' -ArgumentList @('/PID','{}','/T','/F') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; ",
            "exit $process.ExitCode; ",
            "}} catch {{ ",
            "Write-Error $_.Exception.Message; ",
            "exit 1223; ",
            "}}"
        ),
        escape_powershell_single_quotes(&taskkill_path),
        pid
    );

    emit_log(
        app,
        project_id,
        "system",
        format!("CMD powershell elevated-taskkill {pid}"),
    );

    Ok(Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(powershell_script)
        .output()
        .await?)
}

fn parse_pid_tokens(output: &str) -> Vec<u32> {
    let mut seen = HashSet::new();

    output
        .split_whitespace()
        .filter_map(|token| token.trim().parse::<u32>().ok())
        .filter(|pid| seen.insert(*pid))
        .collect()
}

fn filter_current_process_pid(pids: Vec<u32>) -> Vec<u32> {
    let current_pid = std::process::id();
    pids.into_iter().filter(|pid| *pid != current_pid).collect()
}

#[allow(dead_code)]
fn parse_windows_netstat_pids(output: &str, port: u16) -> Vec<u32> {
    let expected_suffix = format!(":{port}");
    let mut seen = HashSet::new();
    let mut pids = Vec::new();

    for line in output.lines() {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        let Some(local_address) = columns.get(1) else {
            continue;
        };
        let Some(pid) = columns.last().and_then(|entry| entry.parse::<u32>().ok()) else {
            continue;
        };

        if local_address.ends_with(&expected_suffix) && seen.insert(pid) {
            pids.push(pid);
        }
    }

    pids
}

#[cfg(any(target_os = "linux", test))]
fn parse_ss_pids(output: &str) -> Vec<u32> {
    let mut seen = HashSet::new();
    let mut pids = Vec::new();

    for fragment in output.split("pid=").skip(1) {
        let digits = fragment
            .chars()
            .take_while(|character| character.is_ascii_digit())
            .collect::<String>();
        let Some(pid) = digits.parse::<u32>().ok() else {
            continue;
        };

        if seen.insert(pid) {
            pids.push(pid);
        }
    }

    pids
}

fn parse_ps_command_pids(output: &str, pattern: &str) -> Vec<u32> {
    let normalized_pattern = pattern.to_ascii_lowercase();
    let mut seen = HashSet::new();
    let mut pids = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut parts = trimmed.splitn(2, char::is_whitespace);
        let Some(pid) = parts
            .next()
            .and_then(|value| value.trim().parse::<u32>().ok())
        else {
            continue;
        };
        let command = parts.next().unwrap_or_default().to_ascii_lowercase();
        if command.contains(&normalized_pattern) && seen.insert(pid) {
            pids.push(pid);
        }
    }

    pids
}

#[allow(dead_code)]
fn escape_powershell_single_quotes(value: &str) -> String {
    value.replace('\'', "''")
}

async fn find_pids_by_port(app: &AppHandle, project_id: &str, port: u16) -> Result<Vec<u32>> {
    if cfg!(windows) {
        let powershell_script = format!(
            "Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"
        );
        emit_log(
            app,
            project_id,
            "system",
            format!("CMD powershell tcp-port-scan {port}"),
        );

        match Command::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-Command")
            .arg(&powershell_script)
            .output()
            .await
        {
            Ok(output) => {
                let (stdout, stderr) = parse_command_output(&output);
                let pids = filter_current_process_pid(parse_pid_tokens(&stdout));
                if !pids.is_empty() {
                    return Ok(pids);
                }

                if !output.status.success() && !stderr.is_empty() {
                    emit_log(
                        app,
                        project_id,
                        "stderr",
                        format!(
                            "PowerShell PID lookup for port {} failed, falling back to netstat: {}",
                            port,
                            command_failure_reason(&output)
                        ),
                    );
                }
            }
            Err(error) => {
                emit_log(
                    app,
                    project_id,
                    "stderr",
                    format!(
                        "PowerShell PID lookup for port {} could not start, falling back to netstat: {}",
                        port, error
                    ),
                );
            }
        }

        let command_line = "netstat -ano -p tcp";
        emit_log(app, project_id, "system", format!("CMD {command_line}"));
        let output = Command::new("netstat")
            .arg("-ano")
            .arg("-p")
            .arg("tcp")
            .output()
            .await?;

        let (stdout, stderr) = parse_command_output(&output);
        if !output.status.success() && stdout.is_empty() && stderr.is_empty() {
            return Ok(Vec::new());
        }

        let pids = filter_current_process_pid(parse_windows_netstat_pids(&stdout, port));
        if pids.is_empty() && !stderr.is_empty() {
            emit_log(
                app,
                project_id,
                "stderr",
                format!(
                    "netstat PID lookup for port {} returned no PID: {}",
                    port,
                    command_failure_reason(&output)
                ),
            );
        }

        return Ok(pids);
    }

    let command_line = format!("lsof -nP -iTCP:{port} -t");
    emit_log(app, project_id, "system", format!("CMD {command_line}"));
    match Command::new("lsof")
        .arg("-nP")
        .arg(format!("-iTCP:{port}"))
        .arg("-t")
        .output()
        .await
    {
        Ok(output) => {
            let (stdout, stderr) = parse_command_output(&output);
            let pids = filter_current_process_pid(parse_pid_tokens(&stdout));
            if !pids.is_empty() {
                return Ok(pids);
            }

            if !output.status.success() && !stderr.is_empty() {
                emit_log(
                    app,
                    project_id,
                    "stderr",
                    format!(
                        "lsof PID lookup for port {} failed, trying Linux fallbacks if available: {}",
                        port,
                        command_failure_reason(&output)
                    ),
                );
            }
        }
        Err(error) => {
            emit_log(
                app,
                project_id,
                "stderr",
                format!(
                    "lsof PID lookup for port {} could not start, trying Linux fallbacks if available: {}",
                    port, error
                ),
            );
        }
    }

    #[cfg(target_os = "linux")]
    {
        let command_line = format!("ss -ltnp sport = :{port}");
        emit_log(app, project_id, "system", format!("CMD {command_line}"));
        match Command::new("ss")
            .arg("-ltnp")
            .arg(format!("sport = :{port}"))
            .output()
            .await
        {
            Ok(output) => {
                let (stdout, stderr) = parse_command_output(&output);
                let pids = filter_current_process_pid(parse_ss_pids(&stdout));
                if !pids.is_empty() {
                    return Ok(pids);
                }

                if !output.status.success() && !stderr.is_empty() {
                    emit_log(
                        app,
                        project_id,
                        "stderr",
                        format!(
                            "ss PID lookup for port {} failed, falling back to fuser: {}",
                            port,
                            command_failure_reason(&output)
                        ),
                    );
                }
            }
            Err(error) => {
                emit_log(
                    app,
                    project_id,
                    "stderr",
                    format!(
                        "ss PID lookup for port {} could not start, falling back to fuser: {}",
                        port, error
                    ),
                );
            }
        }

        let command_line = format!("fuser -n tcp {port}");
        emit_log(app, project_id, "system", format!("CMD {command_line}"));
        match Command::new("fuser")
            .arg("-n")
            .arg("tcp")
            .arg(port.to_string())
            .output()
            .await
        {
            Ok(output) => {
                let (stdout, stderr) = parse_command_output(&output);
                if !output.status.success() && stdout.is_empty() && stderr.is_empty() {
                    return Ok(Vec::new());
                }

                let pids = filter_current_process_pid(parse_pid_tokens(&stdout));
                if pids.is_empty() && !stderr.is_empty() {
                    emit_log(
                        app,
                        project_id,
                        "stderr",
                        format!(
                            "fuser PID lookup for port {} returned no PID: {}",
                            port,
                            command_failure_reason(&output)
                        ),
                    );
                }

                return Ok(pids);
            }
            Err(error) => {
                emit_log(
                    app,
                    project_id,
                    "stderr",
                    format!(
                        "fuser PID lookup for port {} could not start: {}",
                        port, error
                    ),
                );
            }
        }
    }

    Ok(Vec::new())
}

async fn find_pids_by_root_path(
    app: &AppHandle,
    project_id: &str,
    root_path: &str,
) -> Result<Vec<u32>> {
    if cfg!(windows) {
        let escaped_root = escape_powershell_single_quotes(root_path);
        let script = format!(
            "$root = '{escaped_root}'; Get-CimInstance Win32_Process | Where-Object {{ $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like \"*$root*\" }} | Select-Object -ExpandProperty ProcessId"
        );
        emit_log(
            app,
            project_id,
            "system",
            format!("CMD powershell root-scan {}", root_path),
        );
        let output = Command::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-Command")
            .arg(script)
            .output()
            .await?;

        let (stdout, stderr) = parse_command_output(&output);
        if !output.status.success() && stdout.is_empty() && stderr.is_empty() {
            return Ok(Vec::new());
        }

        return Ok(parse_pid_tokens(&stdout)
            .into_iter()
            .filter(|pid| *pid != std::process::id())
            .collect());
    }

    let command_line = "ps -ax -o pid=,command=";
    emit_log(app, project_id, "system", format!("CMD {command_line}"));
    let output = Command::new("sh")
        .arg("-lc")
        .arg(command_line)
        .output()
        .await?;

    let (stdout, stderr) = parse_command_output(&output);
    if !output.status.success() && stdout.is_empty() && stderr.is_empty() {
        return Ok(Vec::new());
    }

    Ok(parse_ps_command_pids(&stdout, root_path)
        .into_iter()
        .filter(|pid| *pid != std::process::id())
        .collect())
}

async fn wait_for_project_process_release(app: &AppHandle, project: &Project) -> bool {
    // 48 × 250 ms = 12 s. The retry loop in force_stop_project already does active
    // re-kills, so by the time we reach this final check the processes should be
    // dying — we just need enough margin for the OS to finish cleaning up.
    for _ in 0..48 {
        let port_released = project.port.map(port_is_available).unwrap_or(true);
        let root_released = find_pids_by_root_path(app, &project.id, &project.root_path)
            .await
            .map(|pids| pids.is_empty())
            .unwrap_or(false);

        if port_released && root_released {
            return true;
        }

        sleep(Duration::from_millis(250)).await;
    }

    false
}

async fn stop_pid(app: &AppHandle, project_id: &str, pid: u32) -> Result<std::process::Output> {
    if cfg!(windows) {
        emit_log(
            app,
            project_id,
            "system",
            format!("CMD taskkill /PID {pid} /T"),
        );
        return Ok(Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .output()
            .await?);
    }

    emit_log(app, project_id, "system", format!("CMD kill {pid}"));
    Ok(Command::new("kill").arg(pid.to_string()).output().await?)
}

async fn force_kill_pid(app: &AppHandle, project_id: &str, pid: u32) -> Result<()> {
    if cfg!(windows) {
        emit_log(
            app,
            project_id,
            "system",
            format!("CMD taskkill /PID {pid} /T /F"),
        );
        let output = Command::new("taskkill")
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .output()
            .await?;

        if output.status.success() || output_indicates_missing_process(&output) {
            return Ok(());
        }

        if output_indicates_access_denied(&output) {
            let already_elevated = is_windows_administrator().await.unwrap_or(false);
            emit_log(
                app,
                project_id,
                "stderr",
                if already_elevated {
                    format!(
                        "taskkill /F reported access denied for PID {pid} even while already elevated"
                    )
                } else {
                    format!(
                        "taskkill /F reported access denied for PID {pid}; retrying with administrator elevation"
                    )
                },
            );

            let elevated_output = force_kill_pid_elevated_windows(app, project_id, pid).await?;
            if elevated_output.status.success()
                || output_indicates_missing_process(&elevated_output)
            {
                return Ok(());
            }

            let reason = command_failure_reason(&elevated_output);
            if elevated_output.status.code() == Some(1223)
                || reason.to_ascii_lowercase().contains("1223")
                || reason
                    .to_ascii_lowercase()
                    .contains("operation was canceled")
                || reason.to_ascii_lowercase().contains("canceled by the user")
                || reason
                    .to_ascii_lowercase()
                    .contains("cancelled by the user")
            {
                return Err(anyhow!(
                    "Administrator privileges were required to terminate PID {} and the Windows UAC prompt was canceled",
                    pid
                ));
            }

            return Err(anyhow!(reason));
        }

        return Err(anyhow!(command_failure_reason(&output)));
    }

    emit_log(app, project_id, "system", format!("CMD kill -9 {pid}"));
    let output = Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .output()
        .await?;

    if output.status.success() || output_indicates_missing_process(&output) {
        return Ok(());
    }

    Err(anyhow!(command_failure_reason(&output)))
}

async fn force_stop_project(
    app: &AppHandle,
    project: &Project,
    tracked_process: Option<&RunningProcess>,
) -> Result<String> {
    let tracked_pid = tracked_process.and_then(|entry| entry.pid);
    let should_stop_root_processes = tracked_pid.is_some() || project.port.is_none();
    let mut attempted_pids = HashSet::new();
    let mut killed_anything = false;

    emit_log(
        app,
        &project.id,
        "system",
        format!(
            "Force stop requested for {} using {} commands",
            project.name,
            if cfg!(windows) { "Windows" } else { "Unix" }
        ),
    );

    if let Some(entry) = tracked_process {
        request_managed_server_shutdown(entry);

        match terminate_job_tree(app, &project.id, entry) {
            Ok(true) => {
                killed_anything = true;
                sleep(Duration::from_millis(250)).await;
            }
            Ok(false) => {}
            Err(error) => {
                emit_log(
                    app,
                    &project.id,
                    "stderr",
                    format!(
                        "JOB terminate failed, fallback to PID/port force stop: {}",
                        error
                    ),
                );
            }
        }
    }

    if let Some(pid) = tracked_pid {
        force_kill_pid(app, &project.id, pid).await?;
        attempted_pids.insert(pid);
        killed_anything = true;
    }

    if let Some(entry) = tracked_process {
        if entry.managed_server.is_some()
            && !wait_for_managed_server_shutdown(entry, entry.public_port.or(project.port)).await
        {
            emit_log(
                app,
                &project.id,
                "stderr",
                format!(
                    "{}; continuing with PID/port force stop",
                    managed_server_stop_failure(&project.name, entry.public_port.or(project.port))
                ),
            );
        }
    }

    if !wait_for_port_release(project.port).await {
        let port = project.port.unwrap();
        let pids = find_pids_by_port(app, &project.id, port).await?;

        if pids.is_empty() {
            emit_log(
                app,
                &project.id,
                "stderr",
                format!(
                    "Port {} is still busy for {} but no owning PID was found yet; continuing with root-path force stop",
                    port,
                    project.name
                ),
            );
        }

        if !pids.is_empty() {
            emit_log(
                app,
                &project.id,
                "system",
                format!(
                    "Port {} currently owned by PID(s): {}",
                    port,
                    pids.iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );

            for pid in pids {
                if attempted_pids.insert(pid) {
                    force_kill_pid(app, &project.id, pid).await?;
                    killed_anything = true;
                }
            }
        }
    }

    if should_stop_root_processes {
        let root_path_pids = find_pids_by_root_path(app, &project.id, &project.root_path).await?;
        for pid in root_path_pids {
            if attempted_pids.insert(pid) {
                force_kill_pid(app, &project.id, pid).await?;
                killed_anything = true;
            }
        }
    }

    // Retry loop: after the initial kill passes, child processes may still be alive or
    // new child processes may have been spawned.  We do up to 6 additional passes
    // (each 400 ms apart) using a single instant check — we do NOT call
    // wait_for_port_release here because that already sleeps up to 5 s internally,
    // which would make each retry iteration far too slow.
    for retry in 0..6u8 {
        sleep(Duration::from_millis(400)).await;

        // Instant (non-blocking) checks so we don't stall the loop.
        let port_busy = project.port.map(|p| !port_is_available(p)).unwrap_or(false);

        let remaining_root_pids = if should_stop_root_processes {
            find_pids_by_root_path(app, &project.id, &project.root_path)
                .await
                .unwrap_or_default()
        } else {
            vec![]
        };

        // If nothing is left we can exit the retry loop early.
        if !port_busy && remaining_root_pids.is_empty() {
            break;
        }

        if port_busy {
            if let Ok(port_pids) = find_pids_by_port(app, &project.id, project.port.unwrap_or(0)).await {
                for pid in port_pids {
                    if attempted_pids.insert(pid) {
                        emit_log(
                            app,
                            &project.id,
                            "system",
                            format!("Retry {}: killing port PID {pid}", retry + 1),
                        );
                        let _ = force_kill_pid(app, &project.id, pid).await;
                        killed_anything = true;
                    }
                }
            }
        }

        for pid in remaining_root_pids {
            if attempted_pids.insert(pid) {
                emit_log(
                    app,
                    &project.id,
                    "system",
                    format!("Retry {}: killing root-path PID {pid}", retry + 1),
                );
                let _ = force_kill_pid(app, &project.id, pid).await;
                killed_anything = true;
            }
        }
    }

    if !wait_for_port_release(project.port).await {
        return Err(anyhow!(
            "Port {} is still busy after force stop for {}",
            project.port.unwrap(),
            project.name
        ));
    }

    if should_stop_root_processes && !wait_for_project_process_release(app, project).await {
        return Err(anyhow!(
            "Processes related to {} are still running after force stop",
            project.name
        ));
    }

    if !killed_anything && tracked_pid.is_none() && project.port.is_none() {
        return Err(anyhow!(
            "{} has no tracked pid, configured port or matching root-path processes to force stop",
            project.name
        ));
    }

    Ok(if let Some(port) = project.port {
        format!("Process force stopped and port {port} was released")
    } else {
        "Process force stopped".to_string()
    })
}
async fn mark_project_stopped(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
    message: impl Into<String>,
) -> Result<()> {
    let message = message.into();
    clear_runtime_tracking(state, project_id).await;
    db::update_project_status(&state.db_path, project_id, ProjectStatus::Stopped, Some(0))?;
    emit_status(
        app,
        project_id,
        ProjectStatus::Stopped,
        Some(0),
        Some(message.clone()),
    );
    emit_log(app, project_id, "system", message);
    Ok(())
}

fn mark_project_stop_failure(
    app: &AppHandle,
    state: &AppState,
    project_id: &str,
    message: impl Into<String>,
) -> Result<()> {
    let message = message.into();
    db::update_project_status(&state.db_path, project_id, ProjectStatus::Failed, None)?;
    emit_status(
        app,
        project_id,
        ProjectStatus::Failed,
        None,
        Some(message.clone()),
    );
    emit_log(app, project_id, "stderr", message);
    Ok(())
}

fn mark_start_failure(
    app: &AppHandle,
    state: &AppState,
    project: &Project,
    message: impl Into<String>,
) -> Result<()> {
    let message = message.into();
    db::update_project_status(&state.db_path, &project.id, ProjectStatus::Failed, None)?;
    emit_status(
        app,
        &project.id,
        ProjectStatus::Failed,
        None,
        Some(message.clone()),
    );
    emit_log(app, &project.id, "stderr", message);
    Ok(())
}

async fn spawn_stream_reader<R>(
    app: AppHandle,
    project_id: String,
    stream: &'static str,
    reader: R,
    last_output_ms: Arc<AtomicU64>,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        last_output_ms.store(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            Ordering::Relaxed,
        );
        emit_log(&app, &project_id, stream, line);
    }
}

async fn spawn_service_process(
    app: &AppHandle,
    state: &AppState,
    project: &Project,
    forced_port: Option<u16>,
    managed_server: Option<mocking::ManagedServerHandle>,
    internal_port: Option<u16>,
    public_port: Option<u16>,
) -> Result<()> {
    let command_plan = build_command_plan(project);
    if command_plan.display.trim().is_empty() {
        if let Some(handle) = managed_server.as_ref() {
            handle.shutdown();
        }
        let error_message = format!("Project {} has no run target configured", project.name);
        mark_start_failure(app, state, project, error_message.clone())?;
        return Err(anyhow!(error_message));
    }

    let envs =
        load_environment_for_launch(state, project, forced_port, public_port.or(project.port))
            .await?;
    emit_log(
        app,
        &project.id,
        "system",
        format!("> {}", project.root_path),
    );
    emit_log(
        app,
        &project.id,
        "system",
        format!("CMD {}", command_plan.display),
    );
    emit_log(
        app,
        &project.id,
        "system",
        format!("MODE {}", project.launch_mode.as_str()),
    );
    if let Some(env_file) = &project.selected_env_file {
        emit_log(app, &project.id, "system", format!("ENV {}", env_file));
    }
    if let Some(port) = public_port.or(project.port) {
        emit_log(app, &project.id, "system", format!("PORT {}", port));
    }
    if let Some(port) = internal_port {
        emit_log(
            app,
            &project.id,
            "system",
            format!("UPSTREAM_PORT {}", port),
        );
    }

    let mut command = Command::new(&command_plan.executable);
    command.args(&command_plan.args);

    command
        .current_dir(&project.root_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in envs {
        command.env(key, value);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some(handle) = managed_server.as_ref() {
                handle.shutdown();
            }
            let error_message = format!(
                "Failed to spawn {} with `{}`: {}",
                project.name, command_plan.display, error
            );
            mark_start_failure(app, state, project, error_message.clone())?;
            return Err(anyhow!(error_message));
        }
    };

    #[cfg(windows)]
    let job = match JobHandle::create_and_assign(&child) {
        Ok(job) => Some(job),
        Err(error) => {
            emit_log(
                app,
                &project.id,
                "stderr",
                format!(
                    "JOB attach failed, fallback to PID/port force stop: {}",
                    error
                ),
            );
            None
        }
    };
    #[cfg(not(windows))]
    let job = None;

    let pid = child
        .id()
        .ok_or_else(|| anyhow!("{} did not expose a pid", project.name))?;

    // Shared timestamp updated by both stdout and stderr readers; the readiness
    // check uses it to detect processes that stopped logging without exiting.
    let last_output_ms = Arc::new(AtomicU64::new(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    ));

    {
        let mut runtime = state.runtime.lock().await;
        runtime.stopping.remove(&project.id);
        runtime.running.insert(
            project.id.clone(),
            RunningProcess {
                pid: Some(pid),
                job,
                managed_server,
                internal_port,
                public_port: public_port.or(project.port),
                command_preview: Some(command_plan.display.clone()),
                last_output_ms: Arc::clone(&last_output_ms),
            },
        );
    }
    diagnostics::invalidate_system_diagnostics(state).await;

    db::update_project_status(&state.db_path, &project.id, ProjectStatus::Starting, None)?;
    emit_status(
        app,
        &project.id,
        ProjectStatus::Starting,
        None,
        Some(format!("Executing {}", command_plan.display)),
    );
    emit_log(app, &project.id, "system", format!("PID {}", pid));

    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(spawn_stream_reader(
            app.clone(),
            project.id.clone(),
            "stdout",
            stdout,
            Arc::clone(&last_output_ms),
        ));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(spawn_stream_reader(
            app.clone(),
            project.id.clone(),
            "stderr",
            stderr,
            Arc::clone(&last_output_ms),
        ));
    }

    let app_handle = app.clone();
    let state_clone = state.clone();
    let project_id = project.id.clone();
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                let exit_code = status.code();
                let (removed_entry, stop_requested) = {
                    let mut runtime = state_clone.runtime.lock().await;
                    let entry = runtime.running.remove(&project_id);
                    let stopping = runtime.stopping.remove(&project_id);
                    (entry, stopping)
                };
                if let Some(entry) = &removed_entry {
                    request_managed_server_shutdown(entry);
                    if !wait_for_managed_server_shutdown(entry, entry.public_port).await {
                        let message = if let Some(port) = entry.public_port {
                            format!(
                                "Managed server did not release port {} after process exit",
                                port
                            )
                        } else {
                            "Managed server did not stop after process exit".to_string()
                        };
                        emit_log(&app_handle, &project_id, "stderr", message);
                    }
                }
                diagnostics::invalidate_system_diagnostics(&state_clone).await;
                let next_status = if stop_requested || status.success() {
                    ProjectStatus::Stopped
                } else {
                    ProjectStatus::Failed
                };
                let _ = db::update_project_status(
                    &state_clone.db_path,
                    &project_id,
                    next_status.clone(),
                    exit_code,
                );
                emit_status(
                    &app_handle,
                    &project_id,
                    next_status,
                    exit_code,
                    Some(if stop_requested {
                        "Process stopped".to_string()
                    } else {
                        "Process finished".to_string()
                    }),
                );
                emit_log(
                    &app_handle,
                    &project_id,
                    "system",
                    format!("Exited with {:?}", exit_code),
                );
            }
            Err(error) => {
                if let Some(entry) = runtime_entry(&state_clone, &project_id).await {
                    request_managed_server_shutdown(&entry);
                    if !wait_for_managed_server_shutdown(&entry, entry.public_port).await {
                        let message = if let Some(port) = entry.public_port {
                            format!(
                                "Managed server did not release port {} after process failure",
                                port
                            )
                        } else {
                            "Managed server did not stop after process failure".to_string()
                        };
                        emit_log(&app_handle, &project_id, "stderr", message);
                    }
                }
                clear_runtime_tracking(&state_clone, &project_id).await;
                let _ = db::update_project_status(
                    &state_clone.db_path,
                    &project_id,
                    ProjectStatus::Failed,
                    None,
                );
                emit_status(
                    &app_handle,
                    &project_id,
                    ProjectStatus::Failed,
                    None,
                    Some(error.to_string()),
                );
                emit_log(&app_handle, &project_id, "stderr", error.to_string());
            }
        }
    });

    Ok(())
}

async fn spawn_mock_only_project(
    app: &AppHandle,
    state: &AppState,
    project: &Project,
) -> Result<()> {
    let public_port = project.port.ok_or_else(|| {
        anyhow!(
            "Project {} needs a configured public port to start in mock mode",
            project.name
        )
    })?;
    let managed_server = mocking::start_mock_server(
        app.clone(),
        state.db_path.clone(),
        project.clone(),
        public_port,
    )
    .await?;

    {
        let mut runtime = state.runtime.lock().await;
        runtime.stopping.remove(&project.id);
        runtime.running.insert(
            project.id.clone(),
            RunningProcess {
                pid: None,
                job: None,
                managed_server: Some(managed_server),
                internal_port: None,
                public_port: Some(public_port),
                command_preview: Some(resolve_command_preview(project)),
                last_output_ms: Arc::new(AtomicU64::new(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                )),
            },
        );
    }
    diagnostics::invalidate_system_diagnostics(state).await;

    db::update_project_status(&state.db_path, &project.id, ProjectStatus::Starting, None)?;
    emit_status(
        app,
        &project.id,
        ProjectStatus::Starting,
        None,
        Some(format!("Mock server listening on {}", public_port)),
    );
    emit_log(
        app,
        &project.id,
        "system",
        format!("MODE {}", project.launch_mode.as_str()),
    );
    emit_log(app, &project.id, "system", format!("PORT {}", public_port));
    Ok(())
}

async fn spawn_recording_project(
    app: &AppHandle,
    state: &AppState,
    project: &Project,
) -> Result<()> {
    let public_port = project.port.ok_or_else(|| {
        anyhow!(
            "Project {} needs a configured public port to start in record mode",
            project.name
        )
    })?;
    let upstream_port = mocking::reserve_free_port()?;
    let managed_server = mocking::start_recording_proxy(
        app.clone(),
        state.db_path.clone(),
        project.clone(),
        public_port,
        upstream_port,
    )
    .await?;

    spawn_service_process(
        app,
        state,
        project,
        Some(upstream_port),
        Some(managed_server),
        Some(upstream_port),
        Some(public_port),
    )
    .await
}

async fn spawn_project(app: &AppHandle, state: &AppState, project: &Project) -> Result<()> {
    match project.launch_mode {
        LaunchMode::Service | LaunchMode::Unknown => {
            spawn_service_process(app, state, project, None, None, None, project.port).await
        }
        LaunchMode::Record => spawn_recording_project(app, state, project).await,
        LaunchMode::Mock => spawn_mock_only_project(app, state, project).await,
    }
}
async fn wait_until_ready(app: &AppHandle, state: &AppState, project: &Project) -> Result<String> {
    db::update_project_status(&state.db_path, &project.id, ProjectStatus::Running, None)?;
    emit_status(
        app,
        &project.id,
        ProjectStatus::Running,
        None,
        Some(match project.launch_mode {
            LaunchMode::Mock => "Mock server started".to_string(),
            LaunchMode::Record => "Recording proxy started".to_string(),
            LaunchMode::Service | LaunchMode::Unknown => "Process started".to_string(),
        }),
    );

    if matches!(project.launch_mode, LaunchMode::Mock) {
        sleep(Duration::from_millis(150)).await;
    } else {
        match project.readiness_mode {
            ReadinessMode::None | ReadinessMode::Unknown => sleep(Duration::from_millis(600)).await,
            ReadinessMode::Delay => {
                let delay = project
                    .readiness_value
                    .as_deref()
                    .unwrap_or("1500")
                    .parse::<u64>()
                    .unwrap_or(1500);
                sleep(Duration::from_millis(delay)).await;
            }
            ReadinessMode::Port => {
                let runtime_state = runtime_entry(state, &project.id).await;
                let runtime_port = match project.launch_mode {
                    LaunchMode::Record => {
                        runtime_state.as_ref().and_then(|entry| entry.internal_port)
                    }
                    LaunchMode::Mock => runtime_state.as_ref().and_then(|entry| entry.public_port),
                    LaunchMode::Service | LaunchMode::Unknown => runtime_state
                        .as_ref()
                        .and_then(|entry| entry.public_port.or(entry.internal_port)),
                };
                // In Record mode, project.port is the recording proxy port (already listening),
                // so we must NOT fall back to it: connecting would always succeed immediately
                // and produce a false-positive Ready signal before the real upstream MS starts.
                let port = runtime_port
                    .or_else(|| match project.launch_mode {
                        LaunchMode::Record => None,
                        _ => project.port,
                    })
                    .or_else(|| {
                        project
                            .readiness_value
                            .as_deref()
                            .and_then(|value| value.parse::<u16>().ok())
                    })
                    .ok_or_else(|| {
                        anyhow!(
                            "Project {} is configured with readiness=port but has no port",
                            project.name
                        )
                    })?;

                // Smart readiness wait: no fixed attempt count, no silence heuristic.
                //
                // The only reliable signal that a process has failed is that it actually
                // exited.  When a process exits the child.wait() task removes it from
                // runtime.running and updates the DB status to Failed / Stopped.
                //
                // We must NOT use log-silence as a failure indicator because many runtimes
                // (TypeScript watch compilation, JVM warm-up, heavy DB init) produce zero
                // output for extended periods while the process is perfectly healthy.
                //
                // Failure conditions:
                //   (a) runtime_entry returns None  → process exited → check DB status.
                //   (b) Absolute 10-minute ceiling  → last-resort guard, almost unreachable.
                const ABSOLUTE_CEILING: Duration = Duration::from_secs(600);
                let deadline = Instant::now() + ABSOLUTE_CEILING;

                loop {
                    // 1. Port responded → service is up.
                    if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                        break;
                    }

                    // 2. Check liveness: if the entry is gone the child already exited.
                    let entry = runtime_entry(state, &project.id).await;
                    if entry.is_none() {
                        // Give the child.wait() handler a tick to finish writing the DB
                        // status before we read it (the window is tiny but real).
                        sleep(Duration::from_millis(100)).await;

                        let current_status = db::list_projects(&state.db_path)?
                            .into_iter()
                            .find(|e| e.id == project.id)
                            .map(|e| e.status);

                        return Err(anyhow!(
                            "{} exited before port {} became ready (status: {:?})",
                            project.name,
                            port,
                            current_status
                        ));
                    }

                    // 3. Absolute ceiling (should almost never happen).
                    if Instant::now() >= deadline {
                        let message = format!(
                            "Port {} was not ready for {} after {}s",
                            port,
                            project.name,
                            ABSOLUTE_CEILING.as_secs()
                        );
                        db::update_project_status(
                            &state.db_path,
                            &project.id,
                            ProjectStatus::Failed,
                            None,
                        )?;
                        emit_status(
                            app,
                            &project.id,
                            ProjectStatus::Failed,
                            None,
                            Some(message.clone()),
                        );
                        emit_log(app, &project.id, "stderr", message.clone());
                        if let Some(entry) = runtime_entry(state, &project.id).await {
                            if let Some(pid) = entry.pid {
                                let _ = force_kill_pid(app, &project.id, pid).await;
                            }
                        }
                        return Err(anyhow!(message));
                    }

                    sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }

    db::update_project_status(&state.db_path, &project.id, ProjectStatus::Ready, None)?;
    emit_status(
        app,
        &project.id,
        ProjectStatus::Ready,
        None,
        Some(match project.launch_mode {
            LaunchMode::Mock => "Mock ready".to_string(),
            LaunchMode::Record => "Recording proxy ready".to_string(),
            LaunchMode::Service | LaunchMode::Unknown => "Project ready".to_string(),
        }),
    );
    Ok(project.id.clone())
}
fn validate_ports(projects: &[Project]) -> Result<()> {
    let mut grouped: HashMap<u16, Vec<String>> = HashMap::new();
    for project in projects {
        if let Some(port) = project.port {
            grouped.entry(port).or_default().push(project.name.clone());
        }
    }

    for (port, owners) in grouped {
        if owners.len() > 1 {
            return Err(anyhow!("Port conflict on {}: {}", port, owners.join(", ")));
        }
        if !port_is_available(port) {
            return Err(anyhow!("Port {} is already taken on localhost", port));
        }
    }

    Ok(())
}

fn dependencies_ready(
    project: &Project,
    ready_ids: &HashSet<String>,
    running_ids: &HashSet<String>,
) -> bool {
    project.dependencies.iter().all(|dependency| {
        !dependency.required_for_start
            || ready_ids.contains(&dependency.depends_on_project_id)
            || running_ids.contains(&dependency.depends_on_project_id)
    })
}

fn is_runtime_active_status(status: &ProjectStatus) -> bool {
    matches!(
        status,
        ProjectStatus::Starting | ProjectStatus::Running | ProjectStatus::Ready
    )
}

async fn wait_for_project_ready_status(
    app: &AppHandle,
    state: &AppState,
    project: &Project,
) -> Result<()> {
    emit_log(
        app,
        &project.id,
        "system",
        format!("Waiting for {} to report ready", project.name),
    );

    // Use a ceiling that matches the port-readiness absolute ceiling (600 s) so that
    // slow-starting services — especially those in Record mode where the MS listens
    // on a dynamically-assigned upstream port — are not incorrectly marked Failed
    // before they have had a fair chance to bind.  The loop breaks early as soon as
    // a terminal status (Ready / Failed / Stopped) is written to the DB.
    for _ in 0..1200 {
        let current_status = db::list_projects(&state.db_path)?
            .into_iter()
            .find(|entry| entry.id == project.id)
            .map(|entry| entry.status);

        match current_status {
            Some(ProjectStatus::Ready) => return Ok(()),
            Some(ProjectStatus::Failed | ProjectStatus::Stopped) => {
                return Err(anyhow!(
                    "{} stopped or failed before reporting ready",
                    project.name
                ));
            }
            Some(ProjectStatus::Idle | ProjectStatus::Starting | ProjectStatus::Running) => {
                sleep(Duration::from_millis(500)).await;
            }
            Some(ProjectStatus::Unknown) | None => {
                return Err(anyhow!(
                    "Could not confirm the status of {} while waiting for ready",
                    project.name
                ));
            }
        }
    }

    Err(anyhow!(
        "Timed out waiting for {} to become ready",
        project.name
    ))
}

fn select_projects(projects: Vec<Project>, project_ids: Option<Vec<String>>) -> Vec<Project> {
    match project_ids {
        Some(ids) if !ids.is_empty() => {
            let allowed = ids.into_iter().collect::<HashSet<_>>();
            projects
                .into_iter()
                // Always respect the `enabled` flag regardless of whether explicit IDs
                // were provided. A project with "Run" unchecked must never start.
                .filter(|project| allowed.contains(&project.id) && project.enabled)
                .collect()
        }
        _ => projects
            .into_iter()
            .filter(|project| project.enabled)
            .collect(),
    }
}

pub async fn start_selected(
    app: AppHandle,
    state: AppState,
    project_ids: Option<Vec<String>>,
) -> Result<()> {
    let all_projects = db::list_projects(&state.db_path)?;
    let selected_projects = select_projects(all_projects.clone(), project_ids);
    if selected_projects.is_empty() {
        return Ok(());
    }

    let tracked_running_ids = state
        .runtime
        .lock()
        .await
        .running
        .keys()
        .cloned()
        .collect::<HashSet<_>>();
    let projects_requiring_port_validation = selected_projects
        .iter()
        .filter(|project| !tracked_running_ids.contains(&project.id))
        .cloned()
        .collect::<Vec<_>>();

    if let Err(error) = validate_ports(&projects_requiring_port_validation) {
        let message = error.to_string();
        for project in &selected_projects {
            let _ = mark_start_failure(&app, &state, project, message.clone());
        }
        return Err(error);
    }

    let mut ready_ids = all_projects
        .iter()
        .filter(|project| matches!(&project.status, ProjectStatus::Ready))
        .map(|project| project.id.clone())
        .collect::<HashSet<_>>();
    let mut running_ids = all_projects
        .iter()
        .filter(|project| is_runtime_active_status(&project.status))
        .map(|project| project.id.clone())
        .collect::<HashSet<_>>();
    running_ids.extend(tracked_running_ids.clone());

    let mut previous_project: Option<Project> = None;
    let mut projects_by_phase = BTreeMap::<i64, Vec<Project>>::new();
    for project in selected_projects {
        projects_by_phase
            .entry(project.startup_phase)
            .or_default()
            .push(project);
    }

    for phase_projects in projects_by_phase.into_values() {
        let mut phase_projects_waiting_ready = Vec::new();

        for project in phase_projects {
            if project.wait_for_previous_ready {
                if let Some(previous) = previous_project.as_ref() {
                    if !ready_ids.contains(&previous.id) {
                        if let Err(error) =
                            wait_for_project_ready_status(&app, &state, previous).await
                        {
                            let message = format!(
                                "{} no pudo iniciar porque {} no llego a ready: {}",
                                project.name, previous.name, error
                            );
                            mark_start_failure(&app, &state, &project, message.clone())?;
                            return Err(anyhow!(message));
                        }
                        ready_ids.insert(previous.id.clone());
                    }
                }
            }

            if !dependencies_ready(&project, &ready_ids, &running_ids) {
                let message = format!("Dependencies are not ready for {}", project.name);
                mark_start_failure(&app, &state, &project, message.clone())?;
                return Err(anyhow!(message));
            }

            if tracked_running_ids.contains(&project.id) {
                emit_log(&app, &project.id, "system", "Project already running");
                if matches!(project.status, ProjectStatus::Ready) {
                    ready_ids.insert(project.id.clone());
                } else {
                    phase_projects_waiting_ready.push(project.clone());
                }
                running_ids.insert(project.id.clone());
                previous_project = Some(project);
                continue;
            }

            spawn_project(&app, &state, &project).await?;
            running_ids.insert(project.id.clone());
            phase_projects_waiting_ready.push(project.clone());

            let app_handle = app.clone();
            let state_clone = state.clone();
            let project_clone = project.clone();
            tokio::spawn(async move {
                let _ = wait_until_ready(&app_handle, &state_clone, &project_clone).await;
            });

            previous_project = Some(project);
        }

        for project in phase_projects_waiting_ready {
            if ready_ids.contains(&project.id) {
                continue;
            }

            if let Err(error) = wait_for_project_ready_status(&app, &state, &project).await {
                let message = format!(
                    "{} no pudo completar la fase {}: {}",
                    project.name, project.startup_phase, error
                );
                // Kill any orphaned process and managed server (recording proxy / mock server)
                // before marking the project failed.  Without this, the MS process and the
                // recording proxy would keep running with their ports occupied, causing the
                // next start attempt to fail on port validation.
                let tracked = runtime_entry(&state, &project.id).await;
                if let Some(ref entry) = tracked {
                    request_managed_server_shutdown(entry);
                }
                let _ = force_stop_project(&app, &project, tracked.as_ref()).await;
                clear_runtime_tracking(&state, &project.id).await;
                mark_start_failure(&app, &state, &project, message.clone())?;
                return Err(anyhow!(message));
            }

            ready_ids.insert(project.id.clone());
        }
    }

    Ok(())
}

async fn wait_for_project_tasks(
    tasks: Vec<tokio::task::JoinHandle<Result<(), String>>>,
    context: &str,
) -> Result<()> {
    let mut failures = Vec::new();

    for task in tasks {
        match task.await {
            Ok(Ok(())) => {}
            Ok(Err(message)) => failures.push(message),
            Err(error) => failures.push(format!("{context} task failed: {error}")),
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(anyhow!(failures.join("\n")))
    }
}

async fn stop_selected_project_task(
    app: AppHandle,
    state: AppState,
    project_id: String,
    project: Option<Project>,
) -> Result<(), String> {
    let tracked_process = runtime_entry(&state, &project_id).await;
    let project_name = project
        .as_ref()
        .map(|entry| entry.name.clone())
        .unwrap_or_else(|| project_id.clone());

    if let Some(running) = tracked_process {
        mark_stop_requested(&state, &project_id).await;

        if running.pid.is_none() {
            let managed_port = running
                .public_port
                .or(project.as_ref().and_then(|entry| entry.port));
            request_managed_server_shutdown(&running);
            if !wait_for_managed_server_shutdown(&running, managed_port).await {
                if let Some(project) = project.as_ref() {
                    emit_log(
                        &app,
                        &project_id,
                        "system",
                        "Managed server stop timed out, escalating to force stop by port/root path",
                    );
                    match force_stop_project(&app, project, Some(&running)).await {
                        Ok(message) => {
                            mark_project_stopped(&app, &state, &project_id, message)
                                .await
                                .map_err(|error| error.to_string())?;
                            return Ok(());
                        }
                        Err(error) => {
                            clear_stop_requested(&state, &project_id).await;
                            let message = format!("Failed to stop {}: {}", project_name, error);
                            mark_project_stop_failure(&app, &state, &project_id, message.clone())
                                .map_err(|error| error.to_string())?;
                            return Err(message);
                        }
                    }
                }

                clear_stop_requested(&state, &project_id).await;
                let message = managed_server_stop_failure(&project_name, managed_port);
                mark_project_stop_failure(&app, &state, &project_id, message.clone())
                    .map_err(|error| error.to_string())?;
                return Err(message);
            }

            mark_project_stopped(&app, &state, &project_id, "Managed server stopped")
                .await
                .map_err(|error| error.to_string())?;
            return Ok(());
        }

        let pid = running.pid.unwrap();
        let output = match stop_pid(&app, &project_id, pid).await {
            Ok(output) => output,
            Err(error) => {
                clear_stop_requested(&state, &project_id).await;
                let message = format!("Failed to stop {}: {}", project_name, error);
                mark_project_stop_failure(&app, &state, &project_id, message.clone())
                    .map_err(|persist_error| persist_error.to_string())?;
                return Err(message);
            }
        };

        let process_missing = output_indicates_missing_process(&output);

        if output.status.success() || process_missing {
            let managed_port = running
                .public_port
                .or(project.as_ref().and_then(|entry| entry.port));
            request_managed_server_shutdown(&running);
            if !wait_for_managed_server_shutdown(&running, managed_port).await {
                if let Some(project) = project.as_ref() {
                    emit_log(
                        &app,
                        &project_id,
                        "system",
                        "Managed server stop timed out after PID stop, escalating to force stop",
                    );
                    match force_stop_project(&app, project, Some(&running)).await {
                        Ok(message) => {
                            mark_project_stopped(&app, &state, &project_id, message)
                                .await
                                .map_err(|error| error.to_string())?;
                            return Ok(());
                        }
                        Err(error) => {
                            clear_stop_requested(&state, &project_id).await;
                            let message = format!("Failed to stop {}: {}", project_name, error);
                            mark_project_stop_failure(&app, &state, &project_id, message.clone())
                                .map_err(|persist_error| persist_error.to_string())?;
                            return Err(message);
                        }
                    }
                }

                clear_stop_requested(&state, &project_id).await;
                let message = managed_server_stop_failure(&project_name, managed_port);
                mark_project_stop_failure(&app, &state, &project_id, message.clone())
                    .map_err(|error| error.to_string())?;
                return Err(message);
            }
            remove_running_process(&state, &project_id).await;

            if let Some(project) = project.as_ref() {
                if !wait_for_project_process_release(&app, project).await {
                    emit_log(
                        &app,
                        &project_id,
                        "system",
                        "Tracked PID stopped but project processes are still alive, escalating to force stop",
                    );
                    match force_stop_project(&app, project, Some(&running)).await {
                        Ok(message) => {
                            mark_project_stopped(&app, &state, &project_id, message)
                                .await
                                .map_err(|error| error.to_string())?;
                            return Ok(());
                        }
                        Err(error) => {
                            clear_stop_requested(&state, &project_id).await;
                            let message = format!("Failed to stop {}: {}", project_name, error);
                            mark_project_stop_failure(&app, &state, &project_id, message.clone())
                                .map_err(|persist_error| persist_error.to_string())?;
                            return Err(message);
                        }
                    }
                }
            }

            mark_project_stopped(
                &app,
                &state,
                &project_id,
                if process_missing {
                    "Process was already gone; state cleared"
                } else {
                    "Process stopped"
                },
            )
            .await
            .map_err(|error| error.to_string())?;
            return Ok(());
        }

        clear_stop_requested(&state, &project_id).await;
        let reason = command_failure_reason(&output);
        if let Some(project) = project.as_ref() {
            emit_log(
                &app,
                &project_id,
                "system",
                format!("Stop failed with `{reason}`, escalating to force stop"),
            );
            match force_stop_project(&app, project, Some(&running)).await {
                Ok(message) => {
                    mark_project_stopped(&app, &state, &project_id, message)
                        .await
                        .map_err(|error| error.to_string())?;
                    return Ok(());
                }
                Err(error) => {
                    let message = format!("Failed to stop {}: {}", project_name, error);
                    mark_project_stop_failure(&app, &state, &project_id, message.clone())
                        .map_err(|persist_error| persist_error.to_string())?;
                    return Err(message);
                }
            }
        }

        let message = format!("Failed to stop {}: {}", project_name, reason);
        mark_project_stop_failure(&app, &state, &project_id, message.clone())
            .map_err(|error| error.to_string())?;
        return Err(message);
    }

    if matches!(
        project.as_ref().map(|entry| entry.status.clone()),
        Some(ProjectStatus::Starting | ProjectStatus::Running | ProjectStatus::Ready)
    ) {
        if let Some(project) = project.as_ref() {
            if !wait_for_project_process_release(&app, project).await {
                emit_log(
                    &app,
                    &project_id,
                    "system",
                    "No tracked PID was found, escalating to force stop by port/root path",
                );
                match force_stop_project(&app, project, None).await {
                    Ok(message) => {
                        mark_project_stopped(&app, &state, &project_id, message)
                            .await
                            .map_err(|error| error.to_string())?;
                        return Ok(());
                    }
                    Err(error) => {
                        let message = format!("Failed to stop {}: {}", project_name, error);
                        mark_project_stop_failure(&app, &state, &project_id, message.clone())
                            .map_err(|persist_error| persist_error.to_string())?;
                        return Err(message);
                    }
                }
            }
        }

        mark_project_stopped(&app, &state, &project_id, "No tracked pid; state cleared")
            .await
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

pub async fn stop_selected(
    app: AppHandle,
    state: AppState,
    project_ids: Option<Vec<String>>,
) -> Result<()> {
    let projects = db::list_projects(&state.db_path)?;
    let project_map = projects
        .iter()
        .cloned()
        .map(|project| (project.id.clone(), project))
        .collect::<HashMap<_, _>>();

    let selected_ids = match project_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => projects
            .into_iter()
            .filter(|project| {
                matches!(
                    project.status,
                    ProjectStatus::Starting | ProjectStatus::Running | ProjectStatus::Ready
                )
            })
            .map(|project| project.id)
            .collect(),
    };

    if selected_ids.is_empty() {
        return Ok(());
    }

    let tasks = selected_ids
        .into_iter()
        .map(|project_id| {
            let app = app.clone();
            let state = state.clone();
            let project = project_map.get(&project_id).cloned();
            tokio::spawn(async move {
                stop_selected_project_task(app, state, project_id, project).await
            })
        })
        .collect();

    wait_for_project_tasks(tasks, "stop").await
}
pub async fn shutdown_all(app: AppHandle, state: AppState) -> Result<()> {
    let _ = stop_selected(app.clone(), state.clone(), None).await;
    let _ = force_stop_selected(app, state, None).await;
    Ok(())
}

async fn force_stop_selected_project_task(
    app: AppHandle,
    state: AppState,
    project_id: String,
    project: Option<Project>,
) -> Result<(), String> {
    let Some(project) = project else {
        return Ok(());
    };

    let tracked_process = runtime_entry(&state, &project_id).await;

    if tracked_process.is_some() {
        mark_stop_requested(&state, &project_id).await;
    }

    if let Some(running) = tracked_process.as_ref() {
        request_managed_server_shutdown(running);

        if running.pid.is_none() {
            let managed_port = running.public_port.or(project.port);
            if !wait_for_managed_server_shutdown(running, managed_port).await {
                emit_log(
                    &app,
                    &project_id,
                    "system",
                    "Managed server force stop timed out, retrying with PID/port cleanup",
                );
            } else {
                clear_runtime_tracking(&state, &project_id).await;
                db::update_project_status(
                    &state.db_path,
                    &project_id,
                    ProjectStatus::Stopped,
                    Some(0),
                )
                .map_err(|error| error.to_string())?;
                emit_status(
                    &app,
                    &project_id,
                    ProjectStatus::Stopped,
                    Some(0),
                    Some("Managed server force stopped".to_string()),
                );
                emit_log(&app, &project_id, "system", "Managed server force stopped");
                return Ok(());
            }
        }
    }

    match force_stop_project(&app, &project, tracked_process.as_ref()).await {
        Ok(message) => {
            if tracked_process.is_some() {
                remove_running_process(&state, &project_id).await;
            } else {
                clear_runtime_tracking(&state, &project_id).await;
            }

            db::update_project_status(&state.db_path, &project_id, ProjectStatus::Stopped, Some(0))
                .map_err(|error| error.to_string())?;
            emit_status(
                &app,
                &project_id,
                ProjectStatus::Stopped,
                Some(0),
                Some(message.clone()),
            );
            emit_log(&app, &project_id, "system", message);
            Ok(())
        }
        Err(error) => {
            clear_stop_requested(&state, &project_id).await;
            let message = format!("Failed to force stop {}: {}", project.name, error);
            db::update_project_status(&state.db_path, &project_id, ProjectStatus::Failed, None)
                .map_err(|persist_error| persist_error.to_string())?;
            emit_status(
                &app,
                &project_id,
                ProjectStatus::Failed,
                None,
                Some(message.clone()),
            );
            emit_log(&app, &project_id, "stderr", message.clone());
            Err(message)
        }
    }
}

pub async fn force_stop_selected(
    app: AppHandle,
    state: AppState,
    project_ids: Option<Vec<String>>,
) -> Result<()> {
    let projects = db::list_projects(&state.db_path)?;
    let project_map = projects
        .iter()
        .cloned()
        .map(|project| (project.id.clone(), project))
        .collect::<HashMap<_, _>>();

    let selected_ids = match project_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => projects
            .into_iter()
            .filter(|project| {
                matches!(
                    project.status,
                    ProjectStatus::Starting
                        | ProjectStatus::Running
                        | ProjectStatus::Ready
                        | ProjectStatus::Failed
                )
            })
            .map(|project| project.id)
            .collect(),
    };

    if selected_ids.is_empty() {
        return Ok(());
    }

    let tasks = selected_ids
        .into_iter()
        .map(|project_id| {
            let app = app.clone();
            let state = state.clone();
            let project = project_map.get(&project_id).cloned();
            tokio::spawn(async move {
                force_stop_selected_project_task(app, state, project_id, project).await
            })
        })
        .collect();

    wait_for_project_tasks(tasks, "force stop").await
}

#[cfg(test)]
mod tests {
    use super::{parse_ss_pids, parse_windows_netstat_pids};

    #[test]
    fn parse_windows_netstat_pids_keeps_listening_owner() {
        let output = "  TCP    127.0.0.1:3303         0.0.0.0:0              LISTENING       11472\n  TCP    127.0.0.1:3303         127.0.0.1:61189        CLOSE_WAIT      11472\n  TCP    127.0.0.1:61189        127.0.0.1:3303         FIN_WAIT_2      22292\n";

        assert_eq!(parse_windows_netstat_pids(output, 3303), vec![11472]);
    }

    #[test]
    fn parse_windows_netstat_pids_supports_ipv6_rows() {
        let output =
            "  TCP    [::1]:3303             [::]:0                 LISTENING       11472\n";

        assert_eq!(parse_windows_netstat_pids(output, 3303), vec![11472]);
    }

    #[test]
    fn parse_ss_pids_collects_unique_process_ids() {
        let output = r#"LISTEN 0 4096 127.0.0.1:3303 0.0.0.0:* users:((\"node\",pid=11472,fd=23),(\"npm\",pid=11472,fd=24),(\"bash\",pid=22292,fd=5))"#;

        assert_eq!(parse_ss_pids(output), vec![11472, 22292]);
    }
}
