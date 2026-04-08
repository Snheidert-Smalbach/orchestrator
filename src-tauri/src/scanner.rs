use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Result};
use serde_json::Value;
use walkdir::WalkDir;

use crate::models::{DetectedProject, PackageManager, RunMode, RuntimeKind};

fn is_ignored_dir(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|value| value.to_str()),
        Some("node_modules" | ".git" | "dist" | "target")
    )
}

fn detect_package_manager(path: &Path) -> PackageManager {
    if path.join("package-lock.json").exists() {
        PackageManager::Npm
    } else if path.join("pnpm-lock.yaml").exists() {
        PackageManager::Pnpm
    } else if path.join("yarn.lock").exists() {
        PackageManager::Yarn
    } else if path.join("package.json").exists() {
        PackageManager::Npm
    } else if path.join("Cargo.toml").exists() {
        PackageManager::Cargo
    } else {
        PackageManager::Unknown
    }
}

fn collect_env_files(path: &Path) -> Vec<String> {
    let mut env_files = fs::read_dir(path)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path())
        .filter(|entry| entry.is_file())
        .filter(|entry| {
            entry
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(".env"))
                .unwrap_or(false)
        })
        .map(|entry| entry.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    env_files.sort();
    env_files
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

fn parse_env_entries(path: &str) -> Vec<(String, String)> {
    fs::read_to_string(path)
        .ok()
        .into_iter()
        .flat_map(|content| content.lines().filter_map(parse_env_line).collect::<Vec<_>>())
        .collect()
}

fn parse_port(value: &str) -> Option<u16> {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .split([' ', '#', ';'])
        .next()
        .and_then(|candidate| candidate.parse::<u16>().ok())
}

fn extract_port(env_file: Option<&String>) -> Option<u16> {
    let file = env_file?;
    let entries = parse_env_entries(file);

    for key in ["PORT", "APP_PORT", "SERVER_PORT", "SERVICE_PORT", "HTTP_PORT", "HTTPS_PORT"] {
        if let Some((_, value)) = entries
            .iter()
            .find(|(entry_key, _)| entry_key.eq_ignore_ascii_case(key))
        {
            if let Some(port) = parse_port(value) {
                return Some(port);
            }
        }
    }

    entries.iter().find_map(|(key, value)| {
        let normalized = key.to_ascii_uppercase();
        if normalized.ends_with("_PORT") || normalized.contains("PORT") {
            parse_port(value)
        } else {
            None
        }
    })
}

fn choose_env_file(env_files: &[String], preferred_env_file: Option<&str>) -> Option<String> {
    if let Some(preferred_env_file) = preferred_env_file {
        if let Some(match_entry) = env_files
            .iter()
            .find(|entry| entry.eq_ignore_ascii_case(preferred_env_file))
        {
            return Some(match_entry.clone());
        }
    }

    env_files
        .iter()
        .find(|entry| entry.ends_with(".env"))
        .cloned()
        .or_else(|| {
            env_files
                .iter()
                .find(|entry| entry.ends_with(".env.local"))
                .cloned()
        })
        .or_else(|| env_files.first().cloned())
}

fn parse_package_json(path: &Path) -> Result<(String, Vec<String>)> {
    let package_json = path.join("package.json");
    let raw = fs::read_to_string(package_json)?;
    let json: Value = serde_json::from_str(&raw)?;
    let name = json
        .get("name")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| {
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("unknown")
                .to_string()
        });
    let mut scripts = json
        .get("scripts")
        .and_then(|value| value.as_object())
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    scripts.sort();
    Ok((name, scripts))
}

fn choose_run_target(scripts: &[String], has_package_json: bool, has_compose: bool) -> (RunMode, String) {
    for candidate in ["start:local", "start:localenv", "start", "start:dev"] {
        if scripts.iter().any(|script| script == candidate) {
            return (RunMode::Script, candidate.to_string());
        }
    }

    if has_package_json && !scripts.is_empty() {
        return (RunMode::Script, scripts[0].clone());
    }

    if has_compose {
        return (RunMode::Command, "docker compose up".to_string());
    }

    (RunMode::Command, String::new())
}

fn inspect_directory(
    path: &Path,
    imported_roots: &HashSet<String>,
    preferred_env_file: Option<&str>,
) -> Result<Option<DetectedProject>> {
    if is_ignored_dir(path) {
        return Ok(None);
    }

    let has_package_json = path.join("package.json").exists();
    let has_compose = path.join("docker-compose.yml").exists() || path.join("compose.yml").exists();

    if !has_package_json && !has_compose {
        return Ok(None);
    }

    let env_files = collect_env_files(path);
    let suggested_env_file = choose_env_file(&env_files, preferred_env_file);
    let suggested_port = extract_port(suggested_env_file.as_ref());
    let package_manager = detect_package_manager(path);
    let runtime_kind = if has_package_json {
        RuntimeKind::Node
    } else if has_compose {
        RuntimeKind::DockerCompose
    } else {
        RuntimeKind::Unknown
    };

    let (name, available_scripts) = if has_package_json {
        parse_package_json(path)?
    } else {
        (
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("compose-service")
                .to_string(),
            Vec::new(),
        )
    };

    let (suggested_run_mode, suggested_run_target) =
        choose_run_target(&available_scripts, has_package_json, has_compose);
    let root_path = path.to_string_lossy().to_string();

    Ok(Some(DetectedProject {
        name,
        root_path: root_path.clone(),
        runtime_kind,
        package_manager,
        env_files,
        available_scripts,
        suggested_run_mode,
        suggested_run_target,
        suggested_env_file,
        suggested_port,
        has_docker_compose: has_compose,
        already_imported: imported_roots.contains(&root_path),
    }))
}

fn collect_scan_candidates(root: &Path, recursive: bool) -> Result<Vec<PathBuf>> {
    let mut candidates = vec![root.to_path_buf()];

    if recursive {
        for entry in WalkDir::new(root)
            .min_depth(1)
            .max_depth(3)
            .into_iter()
            .filter_entry(|entry| !is_ignored_dir(entry.path()))
        {
            let entry = entry?;
            if entry.file_type().is_dir() {
                candidates.push(entry.into_path());
            }
        }
    } else {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                candidates.push(path);
            }
        }
    }

    Ok(candidates)
}

pub fn scan_root(root_path: &str, recursive: bool, imported_roots: &HashSet<String>) -> Result<Vec<DetectedProject>> {
    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(anyhow!("Root path does not exist: {}", root_path));
    }

    let mut detected = Vec::new();
    let mut seen_roots = HashSet::new();

    for candidate in collect_scan_candidates(&root, recursive)? {
        if let Some(project) = inspect_directory(&candidate, imported_roots, None)? {
            if seen_roots.insert(project.root_path.clone()) {
                detected.push(project);
            }
        }
    }

    detected.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(detected)
}

pub fn inspect_project(
    root_path: &str,
    imported_roots: &HashSet<String>,
    preferred_env_file: Option<&str>,
) -> Result<DetectedProject> {
    let path = PathBuf::from(root_path);
    if !path.exists() {
        return Err(anyhow!("Project path does not exist: {}", root_path));
    }

    inspect_directory(&path, imported_roots, preferred_env_file)?
        .ok_or_else(|| anyhow!("No supported project metadata found at {}", root_path))
}


