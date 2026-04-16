use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::Path,
};

use anyhow::Result;

use crate::{
    db,
    models::{
        Project, ProjectServiceLink, ServiceGraphConnection, ServiceGraphEnvSource,
        ServiceGraphEnvVariable, ServiceGraphProject, ServiceGraphSnapshot, ServiceLinkSource,
    },
    AppState,
};

const DEFAULT_LINK_HOST: &str = "127.0.0.1";
const COMMON_PORT_KEYS: [&str; 6] = [
    "PORT",
    "APP_PORT",
    "SERVER_PORT",
    "SERVICE_PORT",
    "HTTP_PORT",
    "HTTPS_PORT",
];

#[derive(Debug, Clone)]
struct ResolvedEnvVariable {
    key: String,
    value: String,
    source: ServiceGraphEnvSource,
    enabled: bool,
    is_secret: bool,
}

#[derive(Debug, Clone)]
struct ParsedUrlValue {
    protocol: String,
    host: String,
    port: Option<u16>,
    path: String,
    query: String,
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

fn parse_env_file(path: &str) -> Vec<(String, String)> {
    fs::read_to_string(path)
        .ok()
        .into_iter()
        .flat_map(|content| {
            content
                .lines()
                .filter_map(parse_env_line)
                .collect::<Vec<_>>()
        })
        .collect()
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    normalized.contains("secret")
        || normalized.contains("token")
        || normalized.contains("password")
        || normalized.contains("apikey")
        || normalized.ends_with("_key")
}

fn build_display_value(value: &str, is_secret: bool) -> String {
    if !is_secret || value.trim().is_empty() {
        return value.to_string();
    }

    let visible_tail = value.chars().rev().take(4).collect::<String>();
    let visible_tail = visible_tail.chars().rev().collect::<String>();
    if visible_tail.is_empty() {
        "********".to_string()
    } else {
        format!("********{}", visible_tail)
    }
}

fn is_url_like(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.contains("://")
        || trimmed.starts_with("localhost:")
        || trimmed.starts_with("127.0.0.1:")
        || trimmed.starts_with("[::1]:")
}

fn normalize_lookup_token(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

fn project_aliases(project: &Project) -> Vec<String> {
    let mut aliases = HashSet::new();
    aliases.insert(normalize_lookup_token(&project.name));
    if let Some(root_name) = Path::new(&project.root_path)
        .file_name()
        .and_then(|value| value.to_str())
    {
        aliases.insert(normalize_lookup_token(root_name));
    }

    aliases
        .into_iter()
        .filter(|entry| !entry.is_empty())
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

fn default_port_from_inventory(inventory: &BTreeMap<String, ResolvedEnvVariable>) -> Option<u16> {
    for key in COMMON_PORT_KEYS {
        if let Some(entry) = inventory.get(key) {
            if let Some(port) = parse_port(&entry.value) {
                return Some(port);
            }
        }
    }

    inventory.values().find_map(|entry| {
        let normalized = entry.key.to_ascii_uppercase();
        if normalized.ends_with("_PORT") || normalized.contains("PORT") {
            parse_port(&entry.value)
        } else {
            None
        }
    })
}

fn build_env_inventory(
    project: &Project,
    manual_links: &[ProjectServiceLink],
) -> BTreeMap<String, ResolvedEnvVariable> {
    let mut values = BTreeMap::<String, ResolvedEnvVariable>::new();

    if let Some(env_file) = &project.selected_env_file {
        if Path::new(env_file).exists() {
            for (key, value) in parse_env_file(env_file) {
                values.insert(
                    key.clone(),
                    ResolvedEnvVariable {
                        key: key.clone(),
                        value,
                        source: ServiceGraphEnvSource::EnvFile,
                        enabled: true,
                        is_secret: is_secret_key(&key),
                    },
                );
            }
        }
    }

    for entry in &project.env_overrides {
        if !entry.enabled && values.contains_key(&entry.key) {
            continue;
        }

        values.insert(
            entry.key.clone(),
            ResolvedEnvVariable {
                key: entry.key.clone(),
                value: entry.value.clone(),
                source: ServiceGraphEnvSource::Override,
                enabled: entry.enabled,
                is_secret: entry.is_secret,
            },
        );
    }

    for link in manual_links {
        values
            .entry(link.source_env_key.clone())
            .or_insert_with(|| ResolvedEnvVariable {
                key: link.source_env_key.clone(),
                value: String::new(),
                source: ServiceGraphEnvSource::Missing,
                enabled: true,
                is_secret: is_secret_key(&link.source_env_key),
            });
    }

    values
}

fn normalize_link_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        String::new()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn normalize_link_query(query: &str) -> String {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        String::new()
    } else if trimmed.starts_with('?') {
        trimmed.to_string()
    } else {
        format!("?{trimmed}")
    }
}

fn normalize_protocol(protocol: &str) -> String {
    let trimmed = protocol.trim().to_ascii_lowercase();
    if trimmed == "https" {
        "https".to_string()
    } else {
        "http".to_string()
    }
}

fn normalize_host(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        DEFAULT_LINK_HOST.to_string()
    } else {
        trimmed.to_string()
    }
}

fn resolve_target_port(
    target_project: &Project,
    target_inventory: Option<&BTreeMap<String, ResolvedEnvVariable>>,
    runtime_port: Option<u16>,
    target_env_key: Option<&str>,
) -> Option<u16> {
    runtime_port
        .or(target_project.port)
        .or_else(|| {
            let inventory = target_inventory?;
            let env_key = target_env_key?;
            inventory
                .get(env_key)
                .and_then(|entry| parse_port(&entry.value))
        })
        .or_else(|| target_inventory.and_then(default_port_from_inventory))
}

fn resolve_link_value(
    link: &ProjectServiceLink,
    target_project: &Project,
    target_inventory: Option<&BTreeMap<String, ResolvedEnvVariable>>,
    runtime_port: Option<u16>,
) -> Option<String> {
    let port = resolve_target_port(
        target_project,
        target_inventory,
        runtime_port,
        link.target_env_key.as_deref(),
    )?;

    Some(format!(
        "{}://{}:{}{}{}",
        normalize_protocol(&link.protocol),
        normalize_host(&link.host),
        port,
        normalize_link_path(&link.path),
        normalize_link_query(&link.query),
    ))
}

fn split_path_and_query(value: &str) -> (String, String) {
    if value.is_empty() {
        return (String::new(), String::new());
    }

    if let Some((path, query)) = value.split_once('?') {
        return (path.to_string(), format!("?{query}"));
    }

    (value.to_string(), String::new())
}

fn parse_host_port(value: &str) -> Option<(String, Option<u16>)> {
    if value.is_empty() {
        return None;
    }

    if let Some(rest) = value.strip_prefix('[') {
        let end = rest.find(']')?;
        let host = rest[..end].to_string();
        let trailing = rest[end + 1..].trim();
        let port = trailing
            .strip_prefix(':')
            .and_then(|entry| entry.parse::<u16>().ok());
        return Some((host, port));
    }

    if let Some((host, port_text)) = value.rsplit_once(':') {
        if let Ok(port) = port_text.parse::<u16>() {
            return Some((host.to_string(), Some(port)));
        }
    }

    Some((value.to_string(), None))
}

fn parse_url_value(value: &str) -> Option<ParsedUrlValue> {
    let trimmed = value.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return None;
    }

    let (protocol, remainder) = if let Some((protocol, rest)) = trimmed.split_once("://") {
        (normalize_protocol(protocol), rest)
    } else if trimmed.starts_with("localhost:")
        || trimmed.starts_with("127.0.0.1:")
        || trimmed.starts_with("[::1]:")
    {
        ("http".to_string(), trimmed)
    } else {
        return None;
    };

    let host_end = remainder.find(['/', '?']).unwrap_or(remainder.len());
    let host_port = &remainder[..host_end];
    let suffix = &remainder[host_end..];
    let (host, port) = parse_host_port(host_port)?;
    let (path, query) = split_path_and_query(suffix);

    Some(ParsedUrlValue {
        protocol,
        host,
        port,
        path,
        query,
    })
}

fn host_is_loopback(host: &str) -> bool {
    let normalized = host.trim().to_ascii_lowercase();
    normalized == "localhost"
        || normalized == "127.0.0.1"
        || normalized == "::1"
        || normalized == "[::1]"
}

fn host_matches_project(host: &str, project: &Project) -> bool {
    let normalized_host = normalize_lookup_token(host);
    if normalized_host.is_empty() {
        return false;
    }

    project_aliases(project).into_iter().any(|alias| {
        !alias.is_empty() && (normalized_host.contains(&alias) || alias.contains(&normalized_host))
    })
}

fn infer_target_project<'a>(
    source_project: &Project,
    parsed: &ParsedUrlValue,
    projects: &'a [Project],
    runtime_ports: &HashMap<String, Option<u16>>,
) -> Option<&'a Project> {
    if let Some(port) = parsed.port {
        let by_port = projects
            .iter()
            .filter(|project| project.id != source_project.id)
            .filter(|project| {
                runtime_ports
                    .get(&project.id)
                    .copied()
                    .flatten()
                    .or(project.port)
                    == Some(port)
            })
            .collect::<Vec<_>>();
        if by_port.len() == 1 {
            return by_port.into_iter().next();
        }
    }

    if host_is_loopback(&parsed.host) {
        return None;
    }

    let by_host = projects
        .iter()
        .filter(|project| project.id != source_project.id)
        .filter(|project| host_matches_project(&parsed.host, project))
        .collect::<Vec<_>>();
    if by_host.len() == 1 {
        return by_host.into_iter().next();
    }

    None
}

fn infer_connections(
    projects: &[Project],
    inventories: &HashMap<String, BTreeMap<String, ResolvedEnvVariable>>,
    runtime_ports: &HashMap<String, Option<u16>>,
    manual_keys: &HashSet<(String, String)>,
) -> Vec<ServiceGraphConnection> {
    let inventories = inventories;
    let mut inferred = Vec::new();

    for project in projects {
        let Some(inventory) = inventories.get(&project.id) else {
            continue;
        };

        for entry in inventory.values() {
            if manual_keys.contains(&(project.id.clone(), entry.key.clone())) || !entry.enabled {
                continue;
            }

            let Some(parsed) = parse_url_value(&entry.value) else {
                continue;
            };
            let Some(target_project) =
                infer_target_project(project, &parsed, projects, runtime_ports)
            else {
                continue;
            };

            let inferred_id = format!(
                "inferred:{}:{}:{}",
                project.id, entry.key, target_project.id
            );
            inferred.push(ServiceGraphConnection {
                id: inferred_id,
                source_project_id: project.id.clone(),
                source_env_key: entry.key.clone(),
                target_project_id: target_project.id.clone(),
                target_env_key: Some("PORT".to_string()),
                protocol: parsed.protocol.clone(),
                host: parsed.host.clone(),
                path: normalize_link_path(&parsed.path),
                query: normalize_link_query(&parsed.query),
                resolved_value: Some(entry.value.clone()),
                source_value: Some(entry.value.clone()),
                link_source: ServiceLinkSource::Inferred,
            });
        }
    }

    inferred.sort_by(|left, right| {
        left.source_project_id
            .cmp(&right.source_project_id)
            .then(left.source_env_key.cmp(&right.source_env_key))
            .then(left.target_project_id.cmp(&right.target_project_id))
    });

    inferred
}

pub async fn build_service_graph_snapshot(state: AppState) -> Result<ServiceGraphSnapshot> {
    let projects = db::list_projects(&state.db_path)?;
    let manual_links = db::list_service_links(&state.db_path)?;
    let runtime_ports = {
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

    let projects_by_id = projects
        .iter()
        .map(|project| (project.id.clone(), project.clone()))
        .collect::<HashMap<_, _>>();
    let manual_by_source = manual_links.iter().fold(
        HashMap::<String, Vec<ProjectServiceLink>>::new(),
        |mut grouped, link| {
            grouped
                .entry(link.source_project_id.clone())
                .or_default()
                .push(link.clone());
            grouped
        },
    );

    let inventories = projects
        .iter()
        .map(|project| {
            let manual = manual_by_source
                .get(&project.id)
                .cloned()
                .unwrap_or_default();
            (project.id.clone(), build_env_inventory(project, &manual))
        })
        .collect::<HashMap<_, _>>();

    let graph_projects = projects
        .iter()
        .map(|project| {
            let inventory = inventories.get(&project.id).cloned().unwrap_or_default();
            ServiceGraphProject {
                project_id: project.id.clone(),
                project_name: project.name.clone(),
                status: project.status.clone(),
                launch_mode: project.launch_mode.clone(),
                configured_port: project.port,
                runtime_port: runtime_ports
                    .get(&project.id)
                    .copied()
                    .flatten()
                    .or(project.port),
                env_variables: inventory
                    .into_values()
                    .map(|entry| ServiceGraphEnvVariable {
                        key: entry.key.clone(),
                        value: entry.value.clone(),
                        display_value: if matches!(entry.source, ServiceGraphEnvSource::Missing) {
                            "Configurar desde el mapa".to_string()
                        } else {
                            build_display_value(&entry.value, entry.is_secret)
                        },
                        source: entry.source,
                        enabled: entry.enabled,
                        is_secret: entry.is_secret,
                        is_url_like: is_url_like(&entry.value),
                    })
                    .collect(),
            }
        })
        .collect::<Vec<_>>();

    let manual_connections = manual_links
        .iter()
        .filter_map(|link| {
            let target_project = projects_by_id.get(&link.target_project_id)?;
            let source_inventory = inventories.get(&link.source_project_id);
            let target_inventory = inventories.get(&link.target_project_id);
            Some(ServiceGraphConnection {
                id: link.id.clone(),
                source_project_id: link.source_project_id.clone(),
                source_env_key: link.source_env_key.clone(),
                target_project_id: link.target_project_id.clone(),
                target_env_key: link.target_env_key.clone(),
                protocol: normalize_protocol(&link.protocol),
                host: normalize_host(&link.host),
                path: normalize_link_path(&link.path),
                query: normalize_link_query(&link.query),
                resolved_value: resolve_link_value(
                    link,
                    target_project,
                    target_inventory,
                    runtime_ports
                        .get(&link.target_project_id)
                        .copied()
                        .flatten(),
                ),
                source_value: source_inventory
                    .and_then(|inventory| inventory.get(&link.source_env_key))
                    .map(|entry| entry.value.clone())
                    .filter(|value| !value.trim().is_empty()),
                link_source: ServiceLinkSource::Manual,
            })
        })
        .collect::<Vec<_>>();

    let manual_keys = manual_links
        .iter()
        .map(|link| (link.source_project_id.clone(), link.source_env_key.clone()))
        .collect::<HashSet<_>>();
    let mut connections = manual_connections;
    connections.extend(infer_connections(
        &projects,
        &inventories,
        &runtime_ports,
        &manual_keys,
    ));

    connections.sort_by(|left, right| {
        left.source_project_id
            .cmp(&right.source_project_id)
            .then(left.source_env_key.cmp(&right.source_env_key))
            .then(left.target_project_id.cmp(&right.target_project_id))
            .then(left.id.cmp(&right.id))
    });

    Ok(ServiceGraphSnapshot {
        projects: graph_projects,
        connections,
    })
}

pub fn resolve_service_links_for_project(
    db_path: &Path,
    project: &Project,
    target_projects: &[Project],
    runtime_public_ports: &HashMap<String, Option<u16>>,
) -> Result<HashMap<String, String>> {
    let links = db::list_service_links_for_source(db_path, &project.id)?;
    if links.is_empty() {
        return Ok(HashMap::new());
    }

    let inventories = target_projects
        .iter()
        .map(|entry| (entry.id.clone(), build_env_inventory(entry, &[])))
        .collect::<HashMap<_, _>>();
    let targets_by_id = target_projects
        .iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect::<HashMap<_, _>>();

    let mut resolved = HashMap::new();
    for link in links {
        let Some(target_project) = targets_by_id.get(&link.target_project_id).copied() else {
            continue;
        };

        if let Some(value) = resolve_link_value(
            &link,
            target_project,
            inventories.get(&link.target_project_id),
            runtime_public_ports
                .get(&link.target_project_id)
                .copied()
                .flatten(),
        ) {
            resolved.insert(link.source_env_key.clone(), value);
        }
    }

    Ok(resolved)
}
