use tauri::{AppHandle, State};

use crate::models::{Project, ProjectOrderUpdate, Snapshot, SystemDiagnostics};
use crate::{db, diagnostics, runtime, scanner, AppState};

fn map_error<T>(result: anyhow::Result<T>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    map_error(db::build_snapshot(&state.db_path))
}

#[tauri::command]
pub async fn get_runtime_diagnostics(
    state: State<'_, AppState>,
) -> Result<SystemDiagnostics, String> {
    let state = state.inner().clone();
    map_error(diagnostics::collect_system_diagnostics(state).await)
}

#[tauri::command]
pub fn scan_root(
    root_path: String,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::DetectedProject>, String> {
    let imported_roots = map_error(db::list_project_root_paths(&state.db_path))?;
    map_error(scanner::scan_root(&root_path, recursive, &imported_roots))
}

#[tauri::command]
pub fn inspect_project(
    root_path: String,
    preferred_env_file: Option<String>,
    state: State<'_, AppState>,
) -> Result<crate::models::DetectedProject, String> {
    let imported_roots = map_error(db::list_project_root_paths(&state.db_path))?;
    map_error(scanner::inspect_project(
        &root_path,
        &imported_roots,
        preferred_env_file.as_deref(),
    ))
}

#[tauri::command]
pub fn import_detected_projects(
    root_path: String,
    recursive: bool,
    selected_root_paths: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    let imported_roots = map_error(db::list_project_root_paths(&state.db_path))?;
    let detected = map_error(scanner::scan_root(&root_path, recursive, &imported_roots))?;
    let selected =
        selected_root_paths.map(|entries| entries.into_iter().collect::<std::collections::HashSet<_>>());

    for project in detected {
        if project.already_imported {
            continue;
        }
        if let Some(selected) = &selected {
            if !selected.contains(&project.root_path) {
                continue;
            }
        }
        let project = Project::from_detected(&project);
        map_error(db::save_project(&state.db_path, &project))?;
    }

    map_error(db::save_default_root(&state.db_path, &root_path))?;
    map_error(db::build_snapshot(&state.db_path))
}

#[tauri::command]
pub fn save_project(project: Project, state: State<'_, AppState>) -> Result<Snapshot, String> {
    map_error(db::save_project(&state.db_path, &project))?;
    map_error(db::build_snapshot(&state.db_path))
}

#[tauri::command]
pub fn reorder_projects(
    updates: Vec<ProjectOrderUpdate>,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    map_error(db::reorder_projects(&state.db_path, &updates))?;
    map_error(db::build_snapshot(&state.db_path))
}

#[tauri::command]
pub fn delete_project(project_id: String, state: State<'_, AppState>) -> Result<Snapshot, String> {
    map_error(db::delete_project(&state.db_path, &project_id))?;
    map_error(db::build_snapshot(&state.db_path))
}

#[tauri::command]
pub async fn start_projects(
    app: AppHandle,
    state: State<'_, AppState>,
    project_ids: Option<Vec<String>>,
) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    map_error(runtime::start_selected(app, state.clone(), project_ids).await)?;
    map_error(db::build_snapshot(&state.db_path))
}

#[tauri::command]
pub async fn stop_projects(
    app: AppHandle,
    state: State<'_, AppState>,
    project_ids: Option<Vec<String>>,
) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    map_error(runtime::stop_selected(app, state.clone(), project_ids).await)?;
    map_error(db::build_snapshot(&state.db_path))
}

#[tauri::command]
pub async fn force_stop_projects(
    app: AppHandle,
    state: State<'_, AppState>,
    project_ids: Option<Vec<String>>,
) -> Result<Snapshot, String> {
    let state = state.inner().clone();
    map_error(runtime::force_stop_selected(app, state.clone(), project_ids).await)?;
    map_error(db::build_snapshot(&state.db_path))
}
