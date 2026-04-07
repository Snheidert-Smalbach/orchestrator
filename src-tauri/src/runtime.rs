use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    net::TcpListener,
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
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
    diagnostics,
    db,
    models::{
        LogPayload, PackageManager, Project, ProjectStatus, ReadinessMode, RunMode,
        RuntimeStatusPayload,
    },
    AppState,
};

#[derive(Debug, Clone)]
pub struct RunningProcess {
    pub pid: u32,
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
        if project.available_scripts.iter().any(|script| script == candidate) {
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

    CommandPlan {
        executable: "cmd.exe".to_string(),
        args: vec!["/C".to_string(), command_line.clone()],
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

fn load_environment(project: &Project) -> Result<HashMap<String, String>> {
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

    Ok(envs)
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

    for _ in 0..8 {
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

fn parse_pid_tokens(output: &str) -> Vec<u32> {
    let mut seen = HashSet::new();

    output
        .split_whitespace()
        .filter_map(|token| token.trim().parse::<u32>().ok())
        .filter(|pid| seen.insert(*pid))
        .collect()
}

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

async fn find_pids_by_port(app: &AppHandle, project_id: &str, port: u16) -> Result<Vec<u32>> {
    if cfg!(windows) {
        let command_line = format!("netstat -ano | findstr :{port}");
        emit_log(app, project_id, "system", format!("CMD {command_line}"));
        let output = Command::new("cmd.exe")
            .arg("/C")
            .arg(&command_line)
            .output()
            .await?;

        let (stdout, stderr) = parse_command_output(&output);
        if !output.status.success() && stdout.is_empty() && stderr.is_empty() {
            return Ok(Vec::new());
        }

        return Ok(parse_windows_netstat_pids(&stdout, port));
    }

    let command_line = format!("lsof -ti tcp:{port}");
    emit_log(app, project_id, "system", format!("CMD {command_line}"));
    let output = Command::new("sh")
        .arg("-lc")
        .arg(&command_line)
        .output()
        .await?;

    let (stdout, stderr) = parse_command_output(&output);
    if !output.status.success() && stdout.is_empty() && stderr.is_empty() {
        return Ok(Vec::new());
    }

    Ok(parse_pid_tokens(&stdout))
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
    tracked_pid: Option<u32>,
) -> Result<String> {
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

    if let Some(pid) = tracked_pid {
        force_kill_pid(app, &project.id, pid).await?;
        attempted_pids.insert(pid);
        killed_anything = true;
    }

    if !wait_for_port_release(project.port).await {
        let port = project.port.unwrap();
        let pids = find_pids_by_port(app, &project.id, port).await?;

        if pids.is_empty() {
            return Err(anyhow!(
                "Port {} is still busy for {} but no PID was found to force stop",
                port,
                project.name
            ));
        }

        for pid in pids {
            if attempted_pids.insert(pid) {
                force_kill_pid(app, &project.id, pid).await?;
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

    if !killed_anything && tracked_pid.is_none() && project.port.is_none() {
        return Err(anyhow!(
            "{} has no tracked pid or configured port to force stop",
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

fn mark_start_failure(app: &AppHandle, state: &AppState, project: &Project, message: impl Into<String>) -> Result<()> {
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

async fn spawn_stream_reader<R>(app: AppHandle, project_id: String, stream: &'static str, reader: R)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        emit_log(&app, &project_id, stream, line);
    }
}

async fn spawn_project(app: &AppHandle, state: &AppState, project: &Project) -> Result<()> {
    let command_plan = build_command_plan(project);
    if command_plan.display.trim().is_empty() {
        let error_message = format!("Project {} has no run target configured", project.name);
        mark_start_failure(app, state, project, error_message.clone())?;
        return Err(anyhow!(error_message));
    }

    let envs = load_environment(project)?;
    emit_log(app, &project.id, "system", format!("> {}", project.root_path));
    emit_log(app, &project.id, "system", format!("CMD {}", command_plan.display));
    if let Some(env_file) = &project.selected_env_file {
        emit_log(app, &project.id, "system", format!("ENV {}", env_file));
    }
    if let Some(port) = project.port {
        emit_log(app, &project.id, "system", format!("PORT {}", port));
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
            let error_message = format!(
                "Failed to spawn {} with `{}`: {}",
                project.name, command_plan.display, error
            );
            mark_start_failure(app, state, project, error_message.clone())?;
            return Err(anyhow!(error_message));
        }
    };

    let pid = child
        .id()
        .ok_or_else(|| anyhow!("{} did not expose a pid", project.name))?;
    {
        let mut runtime = state.runtime.lock().await;
        runtime.stopping.remove(&project.id);
        runtime.running.insert(project.id.clone(), RunningProcess { pid });
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
        tokio::spawn(spawn_stream_reader(app.clone(), project.id.clone(), "stdout", stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(spawn_stream_reader(app.clone(), project.id.clone(), "stderr", stderr));
    }

    let app_handle = app.clone();
    let state_clone = state.clone();
    let project_id = project.id.clone();
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                let exit_code = status.code();
                let stop_requested = {
                    let mut runtime = state_clone.runtime.lock().await;
                    runtime.running.remove(&project_id);
                    runtime.stopping.remove(&project_id)
                };
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
                emit_log(&app_handle, &project_id, "system", format!("Exited with {:?}", exit_code));
            }
            Err(error) => {
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

async fn wait_until_ready(app: &AppHandle, state: &AppState, project: &Project) -> Result<String> {
    db::update_project_status(&state.db_path, &project.id, ProjectStatus::Running, None)?;
    emit_status(
        app,
        &project.id,
        ProjectStatus::Running,
        None,
        Some("Process started".to_string()),
    );

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
            let port = project
                .port
                .or_else(|| project.readiness_value.as_deref().and_then(|value| value.parse::<u16>().ok()))
                .ok_or_else(|| {
                    anyhow!(
                        "Project {} is configured with readiness=port but has no port",
                        project.name
                    )
                })?;

            let mut attempts = 0u8;
            loop {
                if TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
                    break;
                }
                attempts += 1;
                if attempts >= 40 {
                    let message = format!("Port {} was not ready for {}", port, project.name);
                    db::update_project_status(&state.db_path, &project.id, ProjectStatus::Failed, None)?;
                    emit_status(
                        app,
                        &project.id,
                        ProjectStatus::Failed,
                        None,
                        Some(message.clone()),
                    );
                    emit_log(app, &project.id, "stderr", message.clone());
                    return Err(anyhow!(message));
                }
                sleep(Duration::from_millis(500)).await;
            }
        }
    }

    db::update_project_status(&state.db_path, &project.id, ProjectStatus::Ready, None)?;
    emit_status(
        app,
        &project.id,
        ProjectStatus::Ready,
        None,
        Some("Project ready".to_string()),
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

fn dependencies_ready(project: &Project, ready_ids: &HashSet<String>, running_ids: &HashSet<String>) -> bool {
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

    for _ in 0..240 {
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
                .filter(|project| allowed.contains(&project.id))
                .collect()
        }
        _ => projects.into_iter().filter(|project| project.enabled).collect(),
    }
}

pub async fn start_selected(app: AppHandle, state: AppState, project_ids: Option<Vec<String>>) -> Result<()> {
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
                        if let Err(error) = wait_for_project_ready_status(&app, &state, previous).await {
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
                mark_start_failure(&app, &state, &project, message.clone())?;
                return Err(anyhow!(message));
            }

            ready_ids.insert(project.id.clone());
        }
    }

    Ok(())
}

pub async fn stop_selected(app: AppHandle, state: AppState, project_ids: Option<Vec<String>>) -> Result<()> {
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

    let mut failures = Vec::new();

    for project_id in selected_ids {
        let tracked_process = state.runtime.lock().await.running.get(&project_id).cloned();
        let project = project_map.get(&project_id);
        let project_name = project
            .map(|entry| entry.name.clone())
            .unwrap_or_else(|| project_id.clone());

        if let Some(running) = tracked_process {
            mark_stop_requested(&state, &project_id).await;
            let output = match Command::new("taskkill")
                .arg("/PID")
                .arg(running.pid.to_string())
                .arg("/T")
                .arg("/F")
                .output()
                .await
            {
                Ok(output) => output,
                Err(error) => {
                    clear_stop_requested(&state, &project_id).await;
                    let message = format!("Failed to stop {}: {}", project_name, error);
                    db::update_project_status(&state.db_path, &project_id, ProjectStatus::Failed, None)?;
                    emit_status(
                        &app,
                        &project_id,
                        ProjectStatus::Failed,
                        None,
                        Some(message.clone()),
                    );
                    emit_log(&app, &project_id, "stderr", message.clone());
                    failures.push(message);
                    continue;
                }
            };

            let process_missing = output_indicates_missing_process(&output);

            if output.status.success() || process_missing {
                remove_running_process(&state, &project_id).await;

                if !wait_for_port_release(project.and_then(|entry| entry.port)).await {
                    if let Some(project) = project {
                        emit_log(
                            &app,
                            &project_id,
                            "system",
                            "Tracked PID stopped but port is still busy, escalating to force stop",
                        );
                        match force_stop_project(&app, project, Some(running.pid)).await {
                            Ok(message) => {
                                mark_project_stopped(&app, &state, &project_id, message).await?;
                                continue;
                            }
                            Err(error) => {
                                clear_stop_requested(&state, &project_id).await;
                                let message = format!("Failed to stop {}: {}", project_name, error);
                                mark_project_stop_failure(&app, &state, &project_id, message.clone())?;
                                failures.push(message);
                                continue;
                            }
                        }
                    }

                    clear_stop_requested(&state, &project_id).await;
                    let message = format!(
                        "{} stopped its tracked PID, but the port is still busy and the project metadata is unavailable.",
                        project_name
                    );
                    mark_project_stop_failure(&app, &state, &project_id, message.clone())?;
                    failures.push(message);
                    continue;
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
                .await?;
                continue;
            }

            clear_stop_requested(&state, &project_id).await;
            let reason = command_failure_reason(&output);
            if let Some(project) = project {
                emit_log(
                    &app,
                    &project_id,
                    "system",
                    format!("Stop failed with `{reason}`, escalating to force stop"),
                );
                match force_stop_project(&app, project, Some(running.pid)).await {
                    Ok(message) => {
                        mark_project_stopped(&app, &state, &project_id, message).await?;
                        continue;
                    }
                    Err(error) => {
                        let message = format!("Failed to stop {}: {}", project_name, error);
                        mark_project_stop_failure(&app, &state, &project_id, message.clone())?;
                        failures.push(message);
                        continue;
                    }
                }
            }

            let message = format!("Failed to stop {}: {}", project_name, reason);
            mark_project_stop_failure(&app, &state, &project_id, message.clone())?;
            failures.push(message);
            continue;
        }

        if matches!(
            project.map(|entry| entry.status.clone()),
            Some(ProjectStatus::Starting | ProjectStatus::Running | ProjectStatus::Ready | ProjectStatus::Failed)
        ) {
            if let Some(project) = project {
                if !wait_for_port_release(project.port).await {
                    emit_log(
                        &app,
                        &project_id,
                        "system",
                        "No tracked PID was found, escalating to force stop by port",
                    );
                    match force_stop_project(&app, project, None).await {
                        Ok(message) => {
                            mark_project_stopped(&app, &state, &project_id, message).await?;
                            continue;
                        }
                        Err(error) => {
                            let message = format!("Failed to stop {}: {}", project_name, error);
                            mark_project_stop_failure(&app, &state, &project_id, message.clone())?;
                            failures.push(message);
                            continue;
                        }
                    }
                }
            }

            mark_project_stopped(
                &app,
                &state,
                &project_id,
                "No tracked pid; state cleared",
            )
            .await?;
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(anyhow!(failures.join("\n")))
    }
}

pub async fn shutdown_all(app: AppHandle, state: AppState) -> Result<()> {
    let _ = stop_selected(app.clone(), state.clone(), None).await;
    let _ = force_stop_selected(app, state, None).await;
    Ok(())
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

    let mut failures = Vec::new();

    for project_id in selected_ids {
        let tracked_process = state.runtime.lock().await.running.get(&project_id).cloned();
        let Some(project) = project_map.get(&project_id) else {
            continue;
        };

        if tracked_process.is_some() {
            mark_stop_requested(&state, &project_id).await;
        }

        match force_stop_project(&app, project, tracked_process.as_ref().map(|entry| entry.pid)).await {
            Ok(message) => {
                if tracked_process.is_some() {
                    remove_running_process(&state, &project_id).await;
                } else {
                    clear_runtime_tracking(&state, &project_id).await;
                }

                db::update_project_status(&state.db_path, &project_id, ProjectStatus::Stopped, Some(0))?;
                emit_status(
                    &app,
                    &project_id,
                    ProjectStatus::Stopped,
                    Some(0),
                    Some(message.clone()),
                );
                emit_log(&app, &project_id, "system", message);
            }
            Err(error) => {
                clear_stop_requested(&state, &project_id).await;
                let message = format!("Failed to force stop {}: {}", project.name, error);
                db::update_project_status(&state.db_path, &project_id, ProjectStatus::Failed, None)?;
                emit_status(
                    &app,
                    &project_id,
                    ProjectStatus::Failed,
                    None,
                    Some(message.clone()),
                );
                emit_log(&app, &project_id, "stderr", message.clone());
                failures.push(message);
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(anyhow!(failures.join("\n")))
    }
}
