use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::models::{
    MockHeader, MockKind, MockSource, ProjectMock, ProjectMockCollection, ProjectMockSummary,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedHeader {
    name: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedRequest {
    method: String,
    path: String,
    query: String,
    version: String,
    headers: Vec<PersistedHeader>,
    content_type: Option<String>,
    body_hex: String,
    body_preview: String,
    normalized_query: String,
    normalized_body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedResponse {
    version: String,
    status_code: u16,
    reason_phrase: String,
    headers: Vec<PersistedHeader>,
    content_type: Option<String>,
    body_hex: String,
    body_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedMockLine {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    recorded_at: String,
    kind: String,
    request: PersistedRequest,
    response: PersistedResponse,
}

pub fn summarize_project_mocks(db_path: &Path, project_id: &str) -> Result<ProjectMockSummary> {
    Ok(list_project_mocks(db_path, project_id)?.summary)
}

pub fn list_project_mocks(db_path: &Path, project_id: &str) -> Result<ProjectMockCollection> {
    let mocks = load_project_mocks(db_path, project_id)?;
    Ok(ProjectMockCollection {
        summary: build_summary(&mocks),
        mocks,
    })
}

pub fn save_project_mock(
    db_path: &Path,
    project_id: &str,
    mock: ProjectMock,
) -> Result<ProjectMockCollection> {
    let mut lines = load_registry_lines(db_path, project_id)?;
    let persisted = project_mock_to_line(mock);

    if let Some(index) = lines
        .iter()
        .position(|entry| stable_line_id(entry) == persisted.id)
    {
        lines[index] = persisted;
    } else {
        lines.push(persisted);
    }

    rewrite_registry(db_path, project_id, &lines)?;
    list_project_mocks(db_path, project_id)
}

pub fn delete_project_mock(
    db_path: &Path,
    project_id: &str,
    mock_id: &str,
) -> Result<ProjectMockCollection> {
    let mut lines = load_registry_lines(db_path, project_id)?;
    lines.retain(|entry| stable_line_id(entry) != mock_id);
    rewrite_registry(db_path, project_id, &lines)?;
    list_project_mocks(db_path, project_id)
}

fn build_summary(mocks: &[ProjectMock]) -> ProjectMockSummary {
    let mut routes = Vec::new();
    let mut seen_routes = std::collections::HashSet::new();
    let mut graphql_count = 0usize;
    let mut rest_count = 0usize;
    let mut manual_count = 0usize;
    let mut captured_count = 0usize;
    let mut last_updated_at: Option<String> = None;

    for mock in mocks {
        match mock.kind {
            MockKind::Graphql => graphql_count += 1,
            MockKind::Rest | MockKind::HttpOther => rest_count += 1,
            MockKind::Unknown => {}
        }

        match mock.source {
            MockSource::Manual => manual_count += 1,
            MockSource::Captured | MockSource::Unknown => captured_count += 1,
        }

        if seen_routes.insert(mock.request_path.clone()) && routes.len() < 4 {
            routes.push(mock.request_path.clone());
        }

        if last_updated_at
            .as_ref()
            .map(|current| compare_timestamps(&mock.recorded_at, current).is_gt())
            .unwrap_or(true)
        {
            last_updated_at = Some(mock.recorded_at.clone());
        }
    }

    ProjectMockSummary {
        total_count: mocks.len(),
        graphql_count,
        rest_count,
        manual_count,
        captured_count,
        last_updated_at,
        routes,
    }
}

fn compare_timestamps(left: &str, right: &str) -> std::cmp::Ordering {
    match (left.parse::<u128>(), right.parse::<u128>()) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}

fn load_project_mocks(db_path: &Path, project_id: &str) -> Result<Vec<ProjectMock>> {
    let mut mocks = load_registry_lines(db_path, project_id)?
        .iter()
        .map(line_to_project_mock)
        .collect::<Vec<_>>();

    mocks.sort_by(|left, right| {
        compare_timestamps(&right.recorded_at, &left.recorded_at)
            .then_with(|| left.request_path.cmp(&right.request_path))
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(mocks)
}

fn load_registry_lines(db_path: &Path, project_id: &str) -> Result<Vec<PersistedMockLine>> {
    let path = capture_file_for_project(db_path, project_id);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&path)?;
    let mut lines = Vec::new();

    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }

        if let Ok(entry) = serde_json::from_str::<PersistedMockLine>(line) {
            lines.push(entry);
        }
    }

    Ok(lines)
}

fn rewrite_registry(db_path: &Path, project_id: &str, lines: &[PersistedMockLine]) -> Result<()> {
    let path = capture_file_for_project(db_path, project_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    if lines.is_empty() {
        if path.exists() {
            fs::write(path, "")?;
        }
        return Ok(());
    }

    let mut payload = String::new();
    for line in lines {
        payload.push_str(&serde_json::to_string(line)?);
        payload.push('\n');
    }
    fs::write(path, payload)?;
    Ok(())
}

fn line_to_project_mock(line: &PersistedMockLine) -> ProjectMock {
    let source = line
        .source
        .as_deref()
        .map(MockSource::from_db)
        .unwrap_or(MockSource::Captured);
    let kind = MockKind::from_db(&line.kind);

    ProjectMock {
        id: stable_line_id(line),
        name: line
            .name
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| default_mock_name(&line.request.method, &line.request.path)),
        source,
        kind,
        recorded_at: line.recorded_at.clone(),
        notes: line.notes.clone(),
        request_method: line.request.method.clone(),
        request_path: line.request.path.clone(),
        request_query: line.request.query.clone(),
        request_headers: line
            .request
            .headers
            .iter()
            .map(|entry| MockHeader {
                name: entry.name.clone(),
                value: entry.value.clone(),
            })
            .collect(),
        request_content_type: line.request.content_type.clone(),
        request_body: decode_hex_to_text(&line.request.body_hex),
        response_status_code: line.response.status_code,
        response_reason_phrase: if line.response.reason_phrase.trim().is_empty() {
            default_reason_phrase(line.response.status_code).to_string()
        } else {
            line.response.reason_phrase.clone()
        },
        response_headers: line
            .response
            .headers
            .iter()
            .map(|entry| MockHeader {
                name: entry.name.clone(),
                value: entry.value.clone(),
            })
            .collect(),
        response_content_type: line.response.content_type.clone(),
        response_body: decode_hex_to_text(&line.response.body_hex),
    }
}

fn project_mock_to_line(mock: ProjectMock) -> PersistedMockLine {
    let recorded_at = if mock.recorded_at.trim().is_empty() {
        timestamp_now()
    } else {
        mock.recorded_at
    };

    let request_content_type = normalize_optional_string(mock.request_content_type);
    let response_content_type = normalize_optional_string(mock.response_content_type);
    let request_body = mock.request_body;
    let response_body = mock.response_body;
    let normalized_request_body =
        normalize_body(request_body.as_bytes(), request_content_type.as_deref());
    let resolved_kind = match mock.kind {
        MockKind::Unknown => detect_kind(
            &mock.request_path,
            request_content_type.as_deref(),
            &normalized_request_body,
        ),
        _ => mock.kind,
    };

    PersistedMockLine {
        id: if mock.id.trim().is_empty() {
            format!("manual-{}", timestamp_now())
        } else {
            mock.id
        },
        name: Some(mock.name.trim().to_string()).filter(|value| !value.is_empty()),
        source: Some(mock.source.as_str().to_string()),
        notes: normalize_optional_string(mock.notes),
        recorded_at,
        kind: resolved_kind.as_str().to_string(),
        request: PersistedRequest {
            method: mock.request_method.trim().to_uppercase(),
            path: normalize_path(&mock.request_path),
            query: mock.request_query.trim().to_string(),
            version: "HTTP/1.1".to_string(),
            headers: mock
                .request_headers
                .into_iter()
                .map(|entry| PersistedHeader {
                    name: entry.name,
                    value: entry.value,
                })
                .collect(),
            content_type: request_content_type.clone(),
            body_hex: hex_encode(request_body.as_bytes()),
            body_preview: preview_text(request_body.as_bytes()),
            normalized_query: normalize_query_string(&mock.request_query),
            normalized_body: normalized_request_body,
        },
        response: PersistedResponse {
            version: "HTTP/1.1".to_string(),
            status_code: mock.response_status_code,
            reason_phrase: if mock.response_reason_phrase.trim().is_empty() {
                default_reason_phrase(mock.response_status_code).to_string()
            } else {
                mock.response_reason_phrase.trim().to_string()
            },
            headers: mock
                .response_headers
                .into_iter()
                .map(|entry| PersistedHeader {
                    name: entry.name,
                    value: entry.value,
                })
                .collect(),
            content_type: response_content_type.clone(),
            body_hex: hex_encode(response_body.as_bytes()),
            body_preview: preview_text(response_body.as_bytes()),
        },
    }
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        "/".to_string()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

fn stable_line_id(line: &PersistedMockLine) -> String {
    if !line.id.trim().is_empty() {
        return line.id.clone();
    }

    let mut hasher = DefaultHasher::new();
    line.recorded_at.hash(&mut hasher);
    line.kind.hash(&mut hasher);
    line.request.method.hash(&mut hasher);
    line.request.path.hash(&mut hasher);
    line.request.query.hash(&mut hasher);
    line.request.body_hex.hash(&mut hasher);
    line.response.status_code.hash(&mut hasher);
    line.response.body_hex.hash(&mut hasher);
    format!("legacy-{:x}", hasher.finish())
}

fn default_mock_name(method: &str, path: &str) -> String {
    format!("{} {}", method.trim().to_uppercase(), path.trim())
}

fn decode_hex_to_text(value: &str) -> String {
    hex_decode(value)
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .unwrap_or_default()
}

fn detect_kind(path: &str, content_type: Option<&str>, normalized_body: &str) -> MockKind {
    let normalized_content_type = content_type.unwrap_or_default().to_ascii_lowercase();
    let normalized_path = path.to_ascii_lowercase();
    if normalized_content_type.contains("graphql") || normalized_path.contains("graphql") {
        return MockKind::Graphql;
    }

    if !normalized_body.is_empty() {
        if let Ok(value) = serde_json::from_str::<Value>(normalized_body) {
            if value.get("query").is_some() {
                return MockKind::Graphql;
            }
        }
    }

    if normalized_content_type.contains("json")
        || normalized_content_type.contains("xml")
        || path.contains('/')
    {
        MockKind::Rest
    } else {
        MockKind::HttpOther
    }
}

fn normalize_query_string(query: &str) -> String {
    if query.trim().is_empty() {
        return String::new();
    }

    let mut entries = query
        .split('&')
        .filter(|entry| !entry.trim().is_empty())
        .map(|entry| {
            let (key, value) = entry.split_once('=').unwrap_or((entry, ""));
            (key.trim().to_string(), value.trim().to_string())
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn normalize_body(body: &[u8], content_type: Option<&str>) -> String {
    if body.is_empty() {
        return String::new();
    }

    let as_text = String::from_utf8_lossy(body).trim().to_string();
    let normalized_content_type = content_type.unwrap_or_default().to_ascii_lowercase();
    if normalized_content_type.contains("json") || looks_like_json(&as_text) {
        if let Ok(value) = serde_json::from_slice::<Value>(body) {
            return canonical_json_value(&value);
        }
    }

    as_text
}

fn looks_like_json(value: &str) -> bool {
    let trimmed = value.trim();
    (trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']'))
}

fn canonical_json_value(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut sorted = Map::new();
            let mut keys = object.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(entry) = object.get(&key) {
                    sorted.insert(key, canonicalize_json(entry));
                }
            }
            serde_json::to_string(&Value::Object(sorted)).unwrap_or_default()
        }
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut sorted = Map::new();
            let mut keys = object.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(entry) = object.get(&key) {
                    sorted.insert(key, canonicalize_json(entry));
                }
            }
            Value::Object(sorted)
        }
        Value::Array(array) => Value::Array(array.iter().map(canonicalize_json).collect()),
        _ => value.clone(),
    }
}

fn preview_text(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body).replace(['\r', '\n'], " ");
    let trimmed = text.trim();
    if trimmed.len() <= 180 {
        trimmed.to_string()
    } else {
        format!("{}...", &trimmed[..180])
    }
}

fn capture_file_for_project(db_path: &Path, project_id: &str) -> PathBuf {
    capture_dir_for_project(db_path, project_id).join("traffic.jsonl")
}

fn capture_dir_for_project(db_path: &Path, project_id: &str) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("captures")
        .join(project_id)
}

fn timestamp_now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn default_reason_phrase(status_code: u16) -> &'static str {
    match status_code {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn hex_decode(value: &str) -> Result<Vec<u8>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    if trimmed.len() % 2 != 0 {
        anyhow::bail!("Hex body length must be even");
    }

    let mut bytes = Vec::with_capacity(trimmed.len() / 2);
    let chars = trimmed.as_bytes();
    let mut index = 0usize;
    while index + 1 < chars.len() {
        let pair = std::str::from_utf8(&chars[index..index + 2])?;
        bytes.push(u8::from_str_radix(pair, 16)?);
        index += 2;
    }
    Ok(bytes)
}
