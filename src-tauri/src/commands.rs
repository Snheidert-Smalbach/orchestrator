use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::models::{
    Preset, Project, ProjectMock, ProjectMockCollection, ProjectOrderUpdate, ProjectServiceLink,
    ServiceGraphSnapshot, Snapshot, SystemDiagnostics,
};
use crate::{db, diagnostics, mock_catalog, runtime, scanner, service_graph, AppState};

const SERVICE_TOPOLOGY_WINDOW_LABEL: &str = "service-topology-window";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceTopologyFocusPayload {
    focus_project_id: Option<String>,
}

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
    let selected = selected_root_paths.map(|entries| {
        entries
            .into_iter()
            .collect::<std::collections::HashSet<_>>()
    });

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
pub fn import_single_project(
    root_path: String,
    preferred_env_file: Option<String>,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    let imported_roots = map_error(db::list_project_root_paths(&state.db_path))?;
    let detected = map_error(scanner::inspect_project(
        &root_path,
        &imported_roots,
        preferred_env_file.as_deref(),
    ))?;

    if !detected.already_imported {
        let project = Project::from_detected(&detected);
        map_error(db::save_project(&state.db_path, &project))?;
    }

    if let Some(parent) = std::path::Path::new(&root_path).parent() {
        if let Some(parent_str) = parent.to_str() {
            map_error(db::save_default_root(&state.db_path, parent_str))?;
        }
    }

    map_error(db::build_snapshot(&state.db_path))
}

#[tauri::command]
pub fn save_project(project: Project, state: State<'_, AppState>) -> Result<Snapshot, String> {
    map_error(db::save_project(&state.db_path, &project))?;
    map_error(db::build_snapshot(&state.db_path))
}

#[tauri::command]
pub async fn get_service_graph_snapshot(
    state: State<'_, AppState>,
) -> Result<ServiceGraphSnapshot, String> {
    let state = state.inner().clone();
    map_error(service_graph::build_service_graph_snapshot(state).await)
}

#[tauri::command]
pub async fn save_service_link(
    link: ProjectServiceLink,
    state: State<'_, AppState>,
) -> Result<ServiceGraphSnapshot, String> {
    map_error(db::save_service_link(&state.db_path, &link))?;
    map_error(service_graph::build_service_graph_snapshot(state.inner().clone()).await)
}

#[tauri::command]
pub async fn delete_service_link(
    link_id: String,
    state: State<'_, AppState>,
) -> Result<ServiceGraphSnapshot, String> {
    map_error(db::delete_service_link(&state.db_path, &link_id))?;
    map_error(service_graph::build_service_graph_snapshot(state.inner().clone()).await)
}

#[tauri::command]
pub fn save_preset(preset: Preset, state: State<'_, AppState>) -> Result<Snapshot, String> {
    map_error(db::save_preset(&state.db_path, &preset))?;
    map_error(db::build_snapshot(&state.db_path))
}

#[tauri::command]
pub fn delete_preset(preset_id: String, state: State<'_, AppState>) -> Result<Snapshot, String> {
    map_error(db::delete_preset(&state.db_path, &preset_id))?;
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
pub fn get_project_mocks(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<ProjectMockCollection, String> {
    map_error(mock_catalog::list_project_mocks(
        &state.db_path,
        &project_id,
    ))
}

#[tauri::command]
pub fn save_project_mock(
    project_id: String,
    mock: ProjectMock,
    state: State<'_, AppState>,
) -> Result<ProjectMockCollection, String> {
    map_error(mock_catalog::save_project_mock(
        &state.db_path,
        &project_id,
        mock,
    ))
}

#[tauri::command]
pub fn delete_project_mock(
    project_id: String,
    mock_id: String,
    state: State<'_, AppState>,
) -> Result<ProjectMockCollection, String> {
    map_error(mock_catalog::delete_project_mock(
        &state.db_path,
        &project_id,
        &mock_id,
    ))
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

#[tauri::command]
pub async fn open_service_topology_window(
    app: AppHandle,
    focus_project_id: Option<String>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SERVICE_TOPOLOGY_WINDOW_LABEL) {
        if focus_project_id.is_some() {
            app.emit_to(
                SERVICE_TOPOLOGY_WINDOW_LABEL,
                "service-topology-focus-project",
                ServiceTopologyFocusPayload {
                    focus_project_id: focus_project_id.clone(),
                },
            )
            .map_err(|error| error.to_string())?;
        }

        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let mut url = String::from("index.html?topology=1");
    if let Some(project_id) = focus_project_id {
        url.push_str("&focusProjectId=");
        url.push_str(&project_id);
    }

    WebviewWindowBuilder::new(
        &app,
        SERVICE_TOPOLOGY_WINDOW_LABEL,
        WebviewUrl::App(url.into()),
    )
    .title("Mapa visual de microservicios")
    .inner_size(1760.0, 1100.0)
    .min_inner_size(1280.0, 820.0)
    .center()
    .resizable(true)
    .focused(true)
    .build()
    .map(|_| ())
    .map_err(|error| error.to_string())
}
