mod commands;
mod db;
mod diagnostics;
mod mock_catalog;
mod mocking;
mod models;
mod process_control;
mod runtime;
mod scanner;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use anyhow::Context;
use diagnostics::DiagnosticsCache;
use runtime::RuntimeManager;
use tauri::Manager;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct AppState {
    pub db_path: PathBuf,
    pub runtime: Arc<Mutex<RuntimeManager>>,
    pub diagnostics_cache: Arc<Mutex<DiagnosticsCache>>,
    pub shutdown_in_progress: Arc<AtomicBool>,
}

#[cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .context("failed to resolve app data dir")?;
            std::fs::create_dir_all(&app_dir)?;
            let db_path = app_dir.join("orchestrator.sqlite");
            db::init_db(&db_path)?;
            app.manage(AppState {
                db_path,
                runtime: Arc::new(Mutex::new(RuntimeManager::default())),
                diagnostics_cache: Arc::new(Mutex::new(DiagnosticsCache::default())),
                shutdown_in_progress: Arc::new(AtomicBool::new(false)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::get_runtime_diagnostics,
            commands::scan_root,
            commands::inspect_project,
            commands::import_detected_projects,
            commands::import_single_project,
            commands::save_project,
            commands::save_preset,
            commands::delete_preset,
            commands::reorder_projects,
            commands::delete_project,
            commands::get_project_mocks,
            commands::save_project_mock,
            commands::delete_project_mock,
            commands::start_projects,
            commands::stop_projects,
            commands::force_stop_projects
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app_handle.state::<AppState>();
                if state.shutdown_in_progress.swap(true, Ordering::SeqCst) {
                    return;
                }

                api.prevent_exit();
                let state = state.inner().clone();
                let _ = tauri::async_runtime::block_on(runtime::shutdown_all(
                    app_handle.clone(),
                    state,
                ));
                app_handle.exit(0);
            }
        });
}
