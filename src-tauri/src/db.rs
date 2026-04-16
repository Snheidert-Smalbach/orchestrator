use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use crate::mock_catalog;
use crate::models::{
    default_root_path, LaunchMode, MockMatchMode, PackageManager, Preset, Project,
    ProjectDependency, ProjectEnvOverride, ProjectMockSummary, ProjectOrderUpdate,
    ProjectServiceLink, ProjectStatus, ReadinessMode, RunMode, RuntimeKind, Settings, Snapshot,
};

fn open_connection(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        ",
    )?;
    Ok(conn)
}

fn load_project_columns(conn: &Connection) -> Result<HashSet<String>> {
    let mut statement = conn.prepare("PRAGMA table_info(projects)")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    let mut columns = HashSet::new();

    for row in rows {
        columns.insert(row?);
    }

    Ok(columns)
}

fn backfill_catalog_order(conn: &Connection) -> Result<()> {
    let mut statement = conn.prepare(
        "SELECT id
         FROM projects
         ORDER BY startup_phase, name",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut project_ids = Vec::new();

    for row in rows {
        project_ids.push(row?);
    }

    for (index, project_id) in project_ids.iter().enumerate() {
        conn.execute(
            "UPDATE projects SET catalog_order = ?1 WHERE id = ?2",
            params![index as i64 + 1, project_id],
        )?;
    }

    Ok(())
}

fn ensure_project_columns(conn: &Connection) -> Result<bool> {
    let columns = load_project_columns(conn)?;
    let mut needs_mock_summary_backfill = false;

    if !columns.contains("catalog_order") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN catalog_order INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        backfill_catalog_order(conn)?;
    }

    if !columns.contains("wait_for_previous_ready") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN wait_for_previous_ready INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    if !columns.contains("launch_mode") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN launch_mode TEXT NOT NULL DEFAULT 'service'",
            [],
        )?;
    }

    if !columns.contains("mock_match_mode") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN mock_match_mode TEXT NOT NULL DEFAULT 'auto'",
            [],
        )?;
    }

    if !columns.contains("mock_unmatched_status") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN mock_unmatched_status INTEGER NOT NULL DEFAULT 404",
            [],
        )?;
    }

    if !columns.contains("mock_total_count") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN mock_total_count INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        needs_mock_summary_backfill = true;
    }

    if !columns.contains("mock_graphql_count") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN mock_graphql_count INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        needs_mock_summary_backfill = true;
    }

    if !columns.contains("mock_rest_count") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN mock_rest_count INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        needs_mock_summary_backfill = true;
    }

    if !columns.contains("mock_manual_count") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN mock_manual_count INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        needs_mock_summary_backfill = true;
    }

    if !columns.contains("mock_captured_count") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN mock_captured_count INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        needs_mock_summary_backfill = true;
    }

    if !columns.contains("mock_last_updated_at") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN mock_last_updated_at TEXT",
            [],
        )?;
        needs_mock_summary_backfill = true;
    }

    if !columns.contains("mock_routes_json") {
        conn.execute(
            "ALTER TABLE projects ADD COLUMN mock_routes_json TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
        needs_mock_summary_backfill = true;
    }

    let has_unordered_projects = conn.query_row(
        "SELECT EXISTS(
            SELECT 1
            FROM projects
            WHERE catalog_order <= 0
        )",
        [],
        |row| row.get::<_, i64>(0),
    )? == 1;

    if has_unordered_projects {
        backfill_catalog_order(conn)?;
    }

    Ok(needs_mock_summary_backfill)
}

fn compare_summary_timestamps(left: &str, right: &str) -> std::cmp::Ordering {
    match (left.parse::<u128>(), right.parse::<u128>()) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}

fn save_project_mock_summary_with_conn(
    conn: &Connection,
    project_id: &str,
    summary: &ProjectMockSummary,
) -> Result<()> {
    conn.execute(
        "UPDATE projects
         SET mock_total_count = ?1,
             mock_graphql_count = ?2,
             mock_rest_count = ?3,
             mock_manual_count = ?4,
             mock_captured_count = ?5,
             mock_last_updated_at = ?6,
             mock_routes_json = ?7
         WHERE id = ?8",
        params![
            summary.total_count as i64,
            summary.graphql_count as i64,
            summary.rest_count as i64,
            summary.manual_count as i64,
            summary.captured_count as i64,
            summary.last_updated_at.clone(),
            serde_json::to_string(&summary.routes)?,
            project_id
        ],
    )?;
    Ok(())
}

fn load_project_mock_summary_from_conn(
    conn: &Connection,
    project_id: &str,
) -> Result<ProjectMockSummary> {
    Ok(conn
        .query_row(
            "SELECT
                mock_total_count,
                mock_graphql_count,
                mock_rest_count,
                mock_manual_count,
                mock_captured_count,
                mock_last_updated_at,
                mock_routes_json
             FROM projects
             WHERE id = ?1",
            [project_id],
            |row| {
                let routes_json: String = row.get(6)?;
                Ok(ProjectMockSummary {
                    total_count: row.get::<_, i64>(0)? as usize,
                    graphql_count: row.get::<_, i64>(1)? as usize,
                    rest_count: row.get::<_, i64>(2)? as usize,
                    manual_count: row.get::<_, i64>(3)? as usize,
                    captured_count: row.get::<_, i64>(4)? as usize,
                    last_updated_at: row.get(5)?,
                    routes: serde_json::from_str(&routes_json).unwrap_or_default(),
                })
            },
        )
        .optional()?
        .unwrap_or_default())
}

fn load_mock_summary_cache_version(conn: &Connection) -> Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'mock_summary_cache_version'",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(Into::into)
}

fn save_mock_summary_cache_version(conn: &Connection, version: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES ('mock_summary_cache_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [version],
    )?;
    Ok(())
}

fn backfill_project_mock_summaries(db_path: &Path) -> Result<()> {
    let conn = open_connection(db_path)?;
    let mut statement =
        conn.prepare("SELECT id FROM projects ORDER BY catalog_order, startup_phase, name")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut project_ids = Vec::new();

    for row in rows {
        project_ids.push(row?);
    }

    for project_id in project_ids {
        let summary =
            mock_catalog::summarize_project_mocks(db_path, &project_id).unwrap_or_default();
        save_project_mock_summary_with_conn(&conn, &project_id, &summary)?;
    }

    save_mock_summary_cache_version(&conn, "1")?;
    Ok(())
}

fn resolve_preset_sort_order(conn: &Connection, preset: &Preset) -> Result<i64> {
    if preset.sort_order > 0 {
        return Ok(preset.sort_order);
    }

    let existing_sort_order = conn
        .query_row(
            "SELECT sort_order FROM presets WHERE id = ?1",
            [preset.id.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;

    if let Some(sort_order) = existing_sort_order {
        if sort_order > 0 {
            return Ok(sort_order);
        }
    }

    let next_sort_order = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM presets",
        [],
        |row| row.get::<_, i64>(0),
    )?;

    Ok(next_sort_order)
}

fn resolve_catalog_order(conn: &Connection, project: &Project) -> Result<i64> {
    if project.catalog_order > 0 {
        return Ok(project.catalog_order);
    }

    let existing_catalog_order = conn
        .query_row(
            "SELECT catalog_order FROM projects WHERE id = ?1",
            [project.id.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;

    if let Some(catalog_order) = existing_catalog_order {
        if catalog_order > 0 {
            return Ok(catalog_order);
        }
    }

    let next_catalog_order = conn.query_row(
        "SELECT COALESCE(MAX(catalog_order), 0) + 1 FROM projects",
        [],
        |row| row.get::<_, i64>(0),
    )?;

    Ok(next_catalog_order)
}

pub fn init_db(db_path: &Path) -> Result<()> {
    let conn = open_connection(db_path)?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            root_path TEXT NOT NULL UNIQUE,
            runtime_kind TEXT NOT NULL,
            package_manager TEXT NOT NULL,
            run_mode TEXT NOT NULL,
            run_target TEXT NOT NULL,
            shell TEXT NOT NULL,
            selected_env_file TEXT,
            available_env_files_json TEXT NOT NULL DEFAULT '[]',
            available_scripts_json TEXT NOT NULL DEFAULT '[]',
            port INTEGER,
            readiness_mode TEXT NOT NULL,
            readiness_value TEXT,
            launch_mode TEXT NOT NULL DEFAULT 'service',
            mock_match_mode TEXT NOT NULL DEFAULT 'auto',
            mock_unmatched_status INTEGER NOT NULL DEFAULT 404,
            startup_phase INTEGER NOT NULL DEFAULT 1,
            catalog_order INTEGER NOT NULL DEFAULT 0,
            wait_for_previous_ready INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            tags_json TEXT NOT NULL DEFAULT '[]',
            last_status TEXT NOT NULL DEFAULT 'idle',
            last_exit_code INTEGER
        );

        CREATE TABLE IF NOT EXISTS project_env_overrides (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            is_secret INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS project_dependencies (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            depends_on_project_id TEXT NOT NULL,
            required_for_start INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS project_service_links (
            id TEXT PRIMARY KEY,
            source_project_id TEXT NOT NULL,
            source_env_key TEXT NOT NULL,
            target_project_id TEXT NOT NULL,
            target_env_key TEXT,
            protocol TEXT NOT NULL DEFAULT 'http',
            host TEXT NOT NULL DEFAULT '127.0.0.1',
            path TEXT NOT NULL DEFAULT '',
            query TEXT NOT NULL DEFAULT '',
            FOREIGN KEY(source_project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY(target_project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS presets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS preset_projects (
            preset_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (preset_id, project_id),
            FOREIGN KEY(preset_id) REFERENCES presets(id) ON DELETE CASCADE,
            FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        ",
    )?;
    let needs_mock_summary_backfill = ensure_project_columns(&conn)?;
    let mock_summary_cache_version = load_mock_summary_cache_version(&conn)?;

    if needs_mock_summary_backfill || mock_summary_cache_version.as_deref() != Some("1") {
        drop(conn);
        backfill_project_mock_summaries(db_path)?;
        let conn = open_connection(db_path)?;
        let has_default_roots = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key = 'default_roots')",
            [],
            |row| row.get::<_, i64>(0),
        )? == 1;

        if !has_default_roots {
            save_default_root(db_path, &default_root_path())?;
        }

        return Ok(());
    }

    let has_default_roots = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key = 'default_roots')",
        [],
        |row| row.get::<_, i64>(0),
    )? == 1;

    if !has_default_roots {
        save_default_root(db_path, &default_root_path())?;
    }
    Ok(())
}

pub fn load_settings(db_path: &Path) -> Result<Settings> {
    let conn = open_connection(db_path)?;
    let raw = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'default_roots'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    let default_roots = raw
        .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
        .filter(|roots| !roots.is_empty())
        .unwrap_or_else(|| vec![default_root_path()]);

    Ok(Settings { default_roots })
}

pub fn save_default_root(db_path: &Path, root_path: &str) -> Result<()> {
    let conn = open_connection(db_path)?;
    let payload = serde_json::to_string(&vec![root_path.to_string()])?;
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES ('default_roots', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [payload],
    )?;
    Ok(())
}

pub fn list_project_root_paths(db_path: &Path) -> Result<HashSet<String>> {
    let conn = open_connection(db_path)?;
    let mut statement = conn.prepare("SELECT root_path FROM projects")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut roots = HashSet::new();
    for row in rows {
        roots.insert(row?);
    }
    Ok(roots)
}

fn load_all_env_overrides(conn: &Connection) -> Result<HashMap<String, Vec<ProjectEnvOverride>>> {
    let mut statement = conn.prepare(
        "SELECT project_id, id, key, value, is_secret, enabled
         FROM project_env_overrides
         ORDER BY project_id, key",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            ProjectEnvOverride {
                id: row.get(1)?,
                key: row.get(2)?,
                value: row.get(3)?,
                is_secret: row.get::<_, i64>(4)? == 1,
                enabled: row.get::<_, i64>(5)? == 1,
            },
        ))
    })?;
    let mut grouped = HashMap::<String, Vec<ProjectEnvOverride>>::new();

    for row in rows {
        let (project_id, override_entry) = row?;
        grouped.entry(project_id).or_default().push(override_entry);
    }

    Ok(grouped)
}

fn load_all_dependencies(conn: &Connection) -> Result<HashMap<String, Vec<ProjectDependency>>> {
    let mut statement = conn.prepare(
        "SELECT project_id, id, depends_on_project_id, required_for_start
         FROM project_dependencies
         ORDER BY project_id, depends_on_project_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            ProjectDependency {
                id: row.get(1)?,
                depends_on_project_id: row.get(2)?,
                required_for_start: row.get::<_, i64>(3)? == 1,
            },
        ))
    })?;
    let mut grouped = HashMap::<String, Vec<ProjectDependency>>::new();

    for row in rows {
        let (project_id, dependency) = row?;
        grouped.entry(project_id).or_default().push(dependency);
    }

    Ok(grouped)
}

pub fn list_service_links(db_path: &Path) -> Result<Vec<ProjectServiceLink>> {
    let conn = open_connection(db_path)?;
    let mut statement = conn.prepare(
        "SELECT
            id,
            source_project_id,
            source_env_key,
            target_project_id,
            target_env_key,
            protocol,
            host,
            path,
            query
         FROM project_service_links
         ORDER BY source_project_id, source_env_key, target_project_id, id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(ProjectServiceLink {
            id: row.get(0)?,
            source_project_id: row.get(1)?,
            source_env_key: row.get(2)?,
            target_project_id: row.get(3)?,
            target_env_key: row.get(4)?,
            protocol: row.get(5)?,
            host: row.get(6)?,
            path: row.get(7)?,
            query: row.get(8)?,
        })
    })?;

    let mut links = Vec::new();
    for row in rows {
        links.push(row?);
    }

    Ok(links)
}

pub fn list_service_links_for_source(
    db_path: &Path,
    source_project_id: &str,
) -> Result<Vec<ProjectServiceLink>> {
    let conn = open_connection(db_path)?;
    let mut statement = conn.prepare(
        "SELECT
            id,
            source_project_id,
            source_env_key,
            target_project_id,
            target_env_key,
            protocol,
            host,
            path,
            query
         FROM project_service_links
         WHERE source_project_id = ?1
         ORDER BY source_env_key, target_project_id, id",
    )?;
    let rows = statement.query_map([source_project_id], |row| {
        Ok(ProjectServiceLink {
            id: row.get(0)?,
            source_project_id: row.get(1)?,
            source_env_key: row.get(2)?,
            target_project_id: row.get(3)?,
            target_env_key: row.get(4)?,
            protocol: row.get(5)?,
            host: row.get(6)?,
            path: row.get(7)?,
            query: row.get(8)?,
        })
    })?;

    let mut links = Vec::new();
    for row in rows {
        links.push(row?);
    }

    Ok(links)
}

pub fn save_service_link(db_path: &Path, link: &ProjectServiceLink) -> Result<()> {
    let conn = open_connection(db_path)?;
    conn.execute(
        "DELETE FROM project_service_links
         WHERE source_project_id = ?1
           AND source_env_key = ?2
           AND id <> ?3",
        params![link.source_project_id, link.source_env_key, link.id],
    )?;
    conn.execute(
        "INSERT INTO project_service_links (
            id,
            source_project_id,
            source_env_key,
            target_project_id,
            target_env_key,
            protocol,
            host,
            path,
            query
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            source_project_id = excluded.source_project_id,
            source_env_key = excluded.source_env_key,
            target_project_id = excluded.target_project_id,
            target_env_key = excluded.target_env_key,
            protocol = excluded.protocol,
            host = excluded.host,
            path = excluded.path,
            query = excluded.query",
        params![
            link.id,
            link.source_project_id,
            link.source_env_key,
            link.target_project_id,
            link.target_env_key,
            link.protocol,
            link.host,
            link.path,
            link.query
        ],
    )?;
    Ok(())
}

pub fn delete_service_link(db_path: &Path, link_id: &str) -> Result<()> {
    let conn = open_connection(db_path)?;
    conn.execute("DELETE FROM project_service_links WHERE id = ?1", [link_id])?;
    Ok(())
}

fn load_preset_project_ids(conn: &Connection, preset_id: &str) -> Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT project_id
         FROM preset_projects
         WHERE preset_id = ?1
         ORDER BY sort_order, project_id",
    )?;
    let rows = statement.query_map([preset_id], |row| row.get::<_, String>(0))?;
    let mut project_ids = Vec::new();

    for row in rows {
        project_ids.push(row?);
    }

    Ok(project_ids)
}

pub fn list_projects(db_path: &Path) -> Result<Vec<Project>> {
    let conn = open_connection(db_path)?;
    let mut statement = conn.prepare(
        "SELECT
            id,
            name,
            root_path,
            runtime_kind,
            package_manager,
            run_mode,
            run_target,
            shell,
            selected_env_file,
            available_env_files_json,
            available_scripts_json,
            port,
            readiness_mode,
            readiness_value,
            launch_mode,
            mock_match_mode,
            mock_unmatched_status,
            startup_phase,
            catalog_order,
            wait_for_previous_ready,
            enabled,
            tags_json,
            mock_total_count,
            mock_graphql_count,
            mock_rest_count,
            mock_manual_count,
            mock_captured_count,
            mock_last_updated_at,
            mock_routes_json,
            last_status,
            last_exit_code
         FROM projects
         ORDER BY catalog_order, startup_phase, name",
    )?;

    let rows = statement.query_map([], |row| {
        let available_env_files: String = row.get(9)?;
        let available_scripts: String = row.get(10)?;
        let tags_json: String = row.get(21)?;
        let mock_routes_json: String = row.get(28)?;
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            root_path: row.get(2)?,
            runtime_kind: RuntimeKind::from_db(&row.get::<_, String>(3)?),
            package_manager: PackageManager::from_db(&row.get::<_, String>(4)?),
            run_mode: RunMode::from_db(&row.get::<_, String>(5)?),
            run_target: row.get(6)?,
            shell: row.get(7)?,
            selected_env_file: row.get(8)?,
            available_env_files: serde_json::from_str(&available_env_files).unwrap_or_default(),
            available_scripts: serde_json::from_str(&available_scripts).unwrap_or_default(),
            port: row.get::<_, Option<u16>>(11)?,
            readiness_mode: ReadinessMode::from_db(&row.get::<_, String>(12)?),
            readiness_value: row.get(13)?,
            launch_mode: LaunchMode::from_db(&row.get::<_, String>(14)?),
            mock_match_mode: MockMatchMode::from_db(&row.get::<_, String>(15)?),
            mock_unmatched_status: row.get::<_, u16>(16)?,
            startup_phase: row.get(17)?,
            catalog_order: row.get(18)?,
            wait_for_previous_ready: row.get::<_, i64>(19)? == 1,
            enabled: row.get::<_, i64>(20)? == 1,
            tags: serde_json::from_str(&tags_json).unwrap_or_default(),
            mock_summary: ProjectMockSummary {
                total_count: row.get::<_, i64>(22)? as usize,
                graphql_count: row.get::<_, i64>(23)? as usize,
                rest_count: row.get::<_, i64>(24)? as usize,
                manual_count: row.get::<_, i64>(25)? as usize,
                captured_count: row.get::<_, i64>(26)? as usize,
                last_updated_at: row.get(27)?,
                routes: serde_json::from_str(&mock_routes_json).unwrap_or_default(),
            },
            env_overrides: Vec::new(),
            dependencies: Vec::new(),
            status: ProjectStatus::from_db(&row.get::<_, String>(29)?),
            last_exit_code: row.get(30)?,
        })
    })?;

    let env_overrides_by_project = load_all_env_overrides(&conn)?;
    let dependencies_by_project = load_all_dependencies(&conn)?;
    let mut projects = Vec::new();
    for row in rows {
        let mut project = row?;
        project.env_overrides = env_overrides_by_project
            .get(&project.id)
            .cloned()
            .unwrap_or_default();
        project.dependencies = dependencies_by_project
            .get(&project.id)
            .cloned()
            .unwrap_or_default();
        projects.push(project);
    }

    Ok(projects)
}

pub fn save_project(db_path: &Path, project: &Project) -> Result<()> {
    let mut conn = open_connection(db_path)?;
    let catalog_order = resolve_catalog_order(&conn, project)?;
    let transaction = conn.transaction()?;
    transaction.execute(
        "INSERT INTO projects (
            id, name, root_path, runtime_kind, package_manager, run_mode, run_target, shell,
            selected_env_file, available_env_files_json, available_scripts_json, port,
            readiness_mode, readiness_value, launch_mode, mock_match_mode, mock_unmatched_status,
            startup_phase, catalog_order, wait_for_previous_ready, enabled, tags_json,
            last_status, last_exit_code
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            root_path = excluded.root_path,
            runtime_kind = excluded.runtime_kind,
            package_manager = excluded.package_manager,
            run_mode = excluded.run_mode,
            run_target = excluded.run_target,
            shell = excluded.shell,
            selected_env_file = excluded.selected_env_file,
            available_env_files_json = excluded.available_env_files_json,
            available_scripts_json = excluded.available_scripts_json,
            port = excluded.port,
            readiness_mode = excluded.readiness_mode,
            readiness_value = excluded.readiness_value,
            launch_mode = excluded.launch_mode,
            mock_match_mode = excluded.mock_match_mode,
            mock_unmatched_status = excluded.mock_unmatched_status,
            startup_phase = excluded.startup_phase,
            catalog_order = excluded.catalog_order,
            wait_for_previous_ready = excluded.wait_for_previous_ready,
            enabled = excluded.enabled,
            tags_json = excluded.tags_json,
            last_status = excluded.last_status,
            last_exit_code = excluded.last_exit_code",
        params![
            project.id,
            project.name,
            project.root_path,
            project.runtime_kind.as_str(),
            project.package_manager.as_str(),
            project.run_mode.as_str(),
            project.run_target,
            project.shell,
            project.selected_env_file,
            serde_json::to_string(&project.available_env_files)?,
            serde_json::to_string(&project.available_scripts)?,
            project.port,
            project.readiness_mode.as_str(),
            project.readiness_value,
            project.launch_mode.as_str(),
            project.mock_match_mode.as_str(),
            project.mock_unmatched_status,
            project.startup_phase,
            catalog_order,
            if project.wait_for_previous_ready { 1 } else { 0 },
            if project.enabled { 1 } else { 0 },
            serde_json::to_string(&project.tags)?,
            project.status.as_str(),
            project.last_exit_code
        ],
    )?;

    transaction.execute(
        "DELETE FROM project_env_overrides WHERE project_id = ?1",
        [project.id.as_str()],
    )?;
    for override_entry in &project.env_overrides {
        transaction.execute(
            "INSERT INTO project_env_overrides (id, project_id, key, value, is_secret, enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                override_entry.id,
                project.id,
                override_entry.key,
                override_entry.value,
                if override_entry.is_secret { 1 } else { 0 },
                if override_entry.enabled { 1 } else { 0 }
            ],
        )?;
    }

    transaction.execute(
        "DELETE FROM project_dependencies WHERE project_id = ?1",
        [project.id.as_str()],
    )?;
    for dependency in &project.dependencies {
        transaction.execute(
            "INSERT INTO project_dependencies (id, project_id, depends_on_project_id, required_for_start)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                dependency.id,
                project.id,
                dependency.depends_on_project_id,
                if dependency.required_for_start { 1 } else { 0 }
            ],
        )?;
    }

    transaction.commit()?;
    Ok(())
}

pub fn list_presets(db_path: &Path) -> Result<Vec<Preset>> {
    let conn = open_connection(db_path)?;
    let mut statement = conn.prepare(
        "SELECT id, name, description, sort_order
         FROM presets
         ORDER BY sort_order, name",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(Preset {
            id: row.get(0)?,
            name: row.get(1)?,
            description: row.get(2)?,
            sort_order: row.get(3)?,
            read_only: false,
            project_ids: Vec::new(),
        })
    })?;

    let mut presets = Vec::new();
    for row in rows {
        let mut preset = row?;
        preset.project_ids = load_preset_project_ids(&conn, &preset.id)?;
        presets.push(preset);
    }

    Ok(presets)
}

pub fn save_preset(db_path: &Path, preset: &Preset) -> Result<()> {
    let conn = open_connection(db_path)?;
    let sort_order = resolve_preset_sort_order(&conn, preset)?;

    conn.execute(
        "INSERT INTO presets (id, name, description, sort_order)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            sort_order = excluded.sort_order",
        params![preset.id, preset.name, preset.description, sort_order],
    )?;

    conn.execute(
        "DELETE FROM preset_projects WHERE preset_id = ?1",
        [preset.id.as_str()],
    )?;

    for (index, project_id) in preset.project_ids.iter().enumerate() {
        conn.execute(
            "INSERT INTO preset_projects (preset_id, project_id, sort_order)
             VALUES (?1, ?2, ?3)",
            params![preset.id, project_id, index as i64 + 1],
        )?;
    }

    Ok(())
}

pub fn delete_preset(db_path: &Path, preset_id: &str) -> Result<()> {
    let conn = open_connection(db_path)?;
    conn.execute("DELETE FROM presets WHERE id = ?1", [preset_id])?;
    Ok(())
}

pub fn reorder_projects(db_path: &Path, updates: &[ProjectOrderUpdate]) -> Result<()> {
    let mut conn = open_connection(db_path)?;
    let mut statement = conn.prepare(
        "SELECT id
         FROM projects
         ORDER BY catalog_order, startup_phase, name",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut existing_ids = Vec::new();

    for row in rows {
        existing_ids.push(row?);
    }
    drop(statement);

    let mut seen = HashSet::new();
    let mut ordered_ids = Vec::new();
    let mut sorted_updates = updates.to_vec();
    sorted_updates.sort_by_key(|entry| entry.catalog_order);

    for update in &sorted_updates {
        if existing_ids
            .iter()
            .any(|project_id| project_id == &update.project_id)
            && seen.insert(update.project_id.clone())
        {
            ordered_ids.push(update.project_id.clone());
        }
    }

    for project_id in existing_ids {
        if seen.insert(project_id.clone()) {
            ordered_ids.push(project_id);
        }
    }

    let transaction = conn.transaction()?;
    for (index, project_id) in ordered_ids.iter().enumerate() {
        transaction.execute(
            "UPDATE projects SET catalog_order = ?1 WHERE id = ?2",
            params![index as i64 + 1, project_id],
        )?;
    }
    transaction.commit()?;

    Ok(())
}

pub fn delete_project(db_path: &Path, project_id: &str) -> Result<()> {
    let conn = open_connection(db_path)?;
    conn.execute("DELETE FROM projects WHERE id = ?1", [project_id])?;
    Ok(())
}

pub fn update_project_status(
    db_path: &Path,
    project_id: &str,
    status: ProjectStatus,
    exit_code: Option<i32>,
) -> Result<()> {
    let conn = open_connection(db_path)?;
    conn.execute(
        "UPDATE projects SET last_status = ?1, last_exit_code = ?2 WHERE id = ?3",
        params![status.as_str(), exit_code, project_id],
    )?;
    Ok(())
}

pub fn update_project_mock_summary(
    db_path: &Path,
    project_id: &str,
    summary: &ProjectMockSummary,
) -> Result<()> {
    let conn = open_connection(db_path)?;
    save_project_mock_summary_with_conn(&conn, project_id, summary)
}

pub fn append_captured_mock_summary(
    db_path: &Path,
    project_id: &str,
    request_path: &str,
    recorded_at: &str,
    is_graphql: bool,
) -> Result<ProjectMockSummary> {
    let conn = open_connection(db_path)?;
    let mut summary = load_project_mock_summary_from_conn(&conn, project_id)?;
    summary.total_count += 1;
    if is_graphql {
        summary.graphql_count += 1;
    } else {
        summary.rest_count += 1;
    }
    summary.captured_count += 1;
    if summary.routes.len() < 4 && !summary.routes.iter().any(|route| route == request_path) {
        summary.routes.push(request_path.to_string());
    }
    if summary
        .last_updated_at
        .as_ref()
        .map(|current| compare_summary_timestamps(recorded_at, current).is_gt())
        .unwrap_or(true)
    {
        summary.last_updated_at = Some(recorded_at.to_string());
    }
    save_project_mock_summary_with_conn(&conn, project_id, &summary)?;
    Ok(summary)
}

pub fn build_snapshot(db_path: &Path) -> Result<Snapshot> {
    let settings = load_settings(db_path)?;
    let projects = list_projects(db_path)?;
    let system_preset = Preset {
        id: "all-enabled".to_string(),
        name: "Todos los habilitados".to_string(),
        description: "Ejecuta todos los proyectos habilitados".to_string(),
        sort_order: 0,
        read_only: true,
        project_ids: projects
            .iter()
            .filter(|project| project.enabled)
            .map(|project| project.id.clone())
            .collect(),
    };
    let mut presets = vec![system_preset];
    presets.extend(list_presets(db_path)?);

    Ok(Snapshot {
        settings,
        projects,
        presets,
    })
}
