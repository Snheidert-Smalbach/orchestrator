use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, Sender},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    time::timeout,
};

use crate::{
    db,
    models::{MockMatchMode, Project, ProjectMockSummaryPayload, ServiceTrafficEvent},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TrafficKind {
    Rest,
    Graphql,
    HttpOther,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HeaderEntry {
    name: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecordedRequest {
    method: String,
    path: String,
    query: String,
    version: String,
    headers: Vec<HeaderEntry>,
    content_type: Option<String>,
    body_hex: String,
    body_preview: String,
    normalized_query: String,
    normalized_body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecordedResponse {
    version: String,
    status_code: u16,
    reason_phrase: String,
    headers: Vec<HeaderEntry>,
    content_type: Option<String>,
    body_hex: String,
    body_preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RecordedExchange {
    recorded_at: String,
    kind: TrafficKind,
    request: RecordedRequest,
    response: RecordedResponse,
}

#[derive(Debug, Default)]
struct RegistryLoad {
    entries: Vec<RecordedExchange>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct HttpRequestMessage {
    method: String,
    target: String,
    version: String,
    headers: Vec<HeaderEntry>,
    body: Vec<u8>,
}

#[derive(Debug, Clone)]
struct HttpResponseMessage {
    version: String,
    status_code: u16,
    reason_phrase: String,
    headers: Vec<HeaderEntry>,
    body: Vec<u8>,
}

static CAPTURE_APPEND_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
static CAPTURE_PERSIST_TX: OnceLock<Sender<CapturePersistJob>> = OnceLock::new();

#[derive(Debug)]
struct CapturePersistJob {
    app: AppHandle,
    db_path: PathBuf,
    project_id: String,
    exchange: RecordedExchange,
}

#[derive(Debug, Clone)]
pub struct ManagedServerHandle {
    shutdown_tx: watch::Sender<bool>,
    stopped_rx: watch::Receiver<bool>,
}

impl ManagedServerHandle {
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    pub async fn wait_stopped(&self, max_wait: Duration) -> bool {
        if *self.stopped_rx.borrow() {
            return true;
        }

        let mut stopped_rx = self.stopped_rx.clone();
        if *stopped_rx.borrow() {
            return true;
        }

        timeout(max_wait, async move {
            loop {
                if *stopped_rx.borrow_and_update() {
                    return true;
                }

                if stopped_rx.changed().await.is_err() {
                    return *stopped_rx.borrow();
                }
            }
        })
        .await
        .unwrap_or(false)
    }
}

fn timestamp_now() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn emit_log(app: &AppHandle, project_id: &str, stream: &str, line: impl Into<String>) {
    let _ = app.emit(
        "project-log",
        crate::models::LogPayload {
            project_id: project_id.to_string(),
            stream: stream.to_string(),
            line: line.into(),
            timestamp: timestamp_now(),
        },
    );
}

fn emit_traffic(app: &AppHandle, payload: ServiceTrafficEvent) {
    let _ = app.emit("service-traffic", payload);
}

fn emit_project_mock_summary(
    app: &AppHandle,
    project_id: &str,
    summary: crate::models::ProjectMockSummary,
) {
    let _ = app.emit(
        "project-mock-summary",
        ProjectMockSummaryPayload {
            project_id: project_id.to_string(),
            summary,
        },
    );
}

fn persist_capture_job(job: CapturePersistJob) -> Result<()> {
    let result = (|| -> Result<_> {
        append_exchange(&job.db_path, &job.project_id, &job.exchange)?;
        db::append_captured_mock_summary(
            &job.db_path,
            &job.project_id,
            &job.exchange.request.path,
            &job.exchange.recorded_at,
            matches!(job.exchange.kind, TrafficKind::Graphql),
        )
    })();

    match result {
        Ok(summary) => {
            emit_project_mock_summary(&job.app, &job.project_id, summary);
            Ok(())
        }
        Err(error) => {
            emit_log(
                &job.app,
                &job.project_id,
                "stderr",
                format!("Failed to persist recorded exchange: {error}"),
            );
            Err(error)
        }
    }
}

fn capture_persist_sender() -> &'static Sender<CapturePersistJob> {
    CAPTURE_PERSIST_TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<CapturePersistJob>();
        let _ = std::thread::Builder::new()
            .name("orchestrator-capture-persist".to_string())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    if let Err(error) = persist_capture_job(job) {
                        eprintln!("capture persistence failed: {error}");
                    }
                }
            });
        tx
    })
}

fn queue_capture_persist(
    app: AppHandle,
    db_path: PathBuf,
    project_id: String,
    exchange: RecordedExchange,
) -> Result<()> {
    let job = CapturePersistJob {
        app,
        db_path,
        project_id,
        exchange,
    };

    match capture_persist_sender().send(job) {
        Ok(()) => Ok(()),
        Err(error) => persist_capture_job(error.0),
    }
}

async fn emit_request_traffic(
    app: &AppHandle,
    project: &Project,
    source_project_id: Option<String>,
    source_label: Option<String>,
    method: &str,
    path: &str,
    status_code: Option<u16>,
    error: Option<String>,
    duration_ms: Option<u64>,
) {
    let ok = error.is_none() && status_code.map(|value| value < 400).unwrap_or(false);

    emit_traffic(
        app,
        ServiceTrafficEvent {
            id: uuid::Uuid::new_v4().to_string(),
            source_project_id,
            source_label,
            target_project_id: project.id.clone(),
            method: method.to_string(),
            path: path.to_string(),
            status_code,
            ok,
            duration_ms,
            error,
            timestamp: timestamp_now(),
        },
    );
}

pub fn capture_dir_for_project(db_path: &Path, project_id: &str) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("captures")
        .join(project_id)
}

fn capture_file_for_project(db_path: &Path, project_id: &str) -> PathBuf {
    capture_dir_for_project(db_path, project_id).join("traffic.jsonl")
}

pub fn reserve_free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

pub async fn start_recording_proxy(
    app: AppHandle,
    db_path: PathBuf,
    project: Project,
    public_port: u16,
    upstream_port: u16,
) -> Result<ManagedServerHandle> {
    let listener = TcpListener::bind(("127.0.0.1", public_port))
        .await
        .with_context(|| format!("Could not bind recording proxy on port {public_port}"))?;
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let (stopped_tx, stopped_rx) = watch::channel(false);
    let project_id = project.id.clone();
    let capture_path = capture_file_for_project(&db_path, &project.id);
    let capture_dir = capture_dir_for_project(&db_path, &project.id);
    fs::create_dir_all(&capture_dir)?;

    emit_log(
        &app,
        &project.id,
        "system",
        format!(
            "Recording proxy listening on {public_port}, upstream on {upstream_port}, captures at {}",
            capture_path.display()
        ),
    );

    tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_ok() && *shutdown_rx.borrow() {
                        emit_log(&app, &project_id, "system", format!("Recording proxy stopped on port {public_port}"));
                        break;
                    }
                }
                accepted = listener.accept() => {
                    let Ok((socket, address)) = accepted else {
                        emit_log(&app, &project_id, "stderr", format!("Recording proxy accept failed on {public_port}"));
                        continue;
                    };

                    let app_handle = app.clone();
                    let db_path = db_path.clone();
                    let project = project.clone();
                    let project_id = project_id.clone();
                    tokio::spawn(async move {
                        if let Err(error) = handle_proxy_connection(
                            app_handle.clone(),
                            db_path,
                            project,
                            socket,
                            address.to_string(),
                            upstream_port,
                        )
                        .await
                        {
                            emit_log(&app_handle, &project_id, "stderr", format!("Recording proxy error: {error}"));
                        }
                    });
                }
            }
        }

        let _ = stopped_tx.send(true);
    });

    Ok(ManagedServerHandle {
        shutdown_tx,
        stopped_rx,
    })
}

pub async fn start_mock_server(
    app: AppHandle,
    db_path: PathBuf,
    project: Project,
    public_port: u16,
) -> Result<ManagedServerHandle> {
    let listener = TcpListener::bind(("127.0.0.1", public_port))
        .await
        .with_context(|| format!("Could not bind mock server on port {public_port}"))?;
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let (stopped_tx, stopped_rx) = watch::channel(false);
    let project_id = project.id.clone();
    let RegistryLoad { entries, warnings } = load_registry(&db_path, &project.id)?;
    let captures_count = entries.len();

    emit_log(
        &app,
        &project.id,
        "system",
        format!(
            "Mock server listening on {public_port} with {captures_count} captured exchange(s)"
        ),
    );
    for warning in warnings {
        emit_log(&app, &project.id, "stderr", warning);
    }

    tokio::spawn(async move {
        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_ok() && *shutdown_rx.borrow() {
                        emit_log(&app, &project_id, "system", format!("Mock server stopped on port {public_port}"));
                        break;
                    }
                }
                accepted = listener.accept() => {
                    let Ok((socket, address)) = accepted else {
                        emit_log(&app, &project_id, "stderr", format!("Mock accept failed on {public_port}"));
                        continue;
                    };

                    let app_handle = app.clone();
                    let db_path = db_path.clone();
                    let project = project.clone();
                    let project_id = project_id.clone();
                    tokio::spawn(async move {
                        if let Err(error) = handle_mock_connection(
                            app_handle.clone(),
                            db_path,
                            project,
                            socket,
                            address.to_string(),
                        )
                        .await
                        {
                            emit_log(&app_handle, &project_id, "stderr", format!("Mock response error: {error}"));
                        }
                    });
                }
            }
        }

        let _ = stopped_tx.send(true);
    });

    Ok(ManagedServerHandle {
        shutdown_tx,
        stopped_rx,
    })
}

async fn handle_proxy_connection(
    app: AppHandle,
    db_path: PathBuf,
    project: Project,
    mut socket: TcpStream,
    remote_address: String,
    upstream_port: u16,
) -> Result<()> {
    let started_at = Instant::now();
    let request = read_http_request(&mut socket).await?;
    let (request_path, _) = split_target(&request.target);
    emit_log(
        &app,
        &project.id,
        "system",
        format!(
            "REC {} {} from {}",
            request.method, request.target, remote_address
        ),
    );

    let mut upstream = match TcpStream::connect(("127.0.0.1", upstream_port)).await {
        Ok(upstream) => upstream,
        Err(error) => {
            let message = format!("Could not reach upstream service on {upstream_port}: {error}");
            emit_request_traffic(
                &app,
                &project,
                None,
                Some(remote_address.clone()),
                &request.method,
                &request_path,
                Some(502),
                Some(message.clone()),
                Some(started_at.elapsed().as_millis() as u64),
            )
            .await;
            return Err(error)
                .with_context(|| format!("Could not reach upstream service on {upstream_port}"));
        }
    };
    let upstream_payload = serialize_request(&request);
    upstream.write_all(&upstream_payload).await?;
    upstream.flush().await?;

    let response = match read_http_response(
        &mut upstream,
        request.method.eq_ignore_ascii_case("HEAD"),
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            emit_request_traffic(
                &app,
                &project,
                None,
                Some(remote_address.clone()),
                &request.method,
                &request_path,
                None,
                Some(error.to_string()),
                Some(started_at.elapsed().as_millis() as u64),
            )
            .await;
            return Err(error);
        }
    };
    let exchange = build_exchange(&request, &response);
    let response_payload = serialize_response(&response);
    socket.write_all(&response_payload).await?;
    socket.flush().await?;
    let _ = socket.shutdown().await;
    queue_capture_persist(app.clone(), db_path, project.id.clone(), exchange.clone())?;
    emit_log(
        &app,
        &project.id,
        "system",
        format!(
            "Recorded {} {} -> {} ({})",
            request.method,
            request_path,
            response.status_code,
            kind_label(&exchange.kind)
        ),
    );
    emit_request_traffic(
        &app,
        &project,
        None,
        Some(remote_address),
        &request.method,
        &request_path,
        Some(response.status_code),
        None,
        Some(started_at.elapsed().as_millis() as u64),
    )
    .await;
    Ok(())
}

async fn handle_mock_connection(
    app: AppHandle,
    db_path: PathBuf,
    project: Project,
    mut socket: TcpStream,
    remote_address: String,
) -> Result<()> {
    let started_at = Instant::now();
    let request = read_http_request(&mut socket).await?;
    let request_view = build_request_record(&request);
    let RegistryLoad { entries, warnings } = load_registry(&db_path, &project.id)?;

    for warning in warnings {
        emit_log(&app, &project.id, "stderr", warning);
    }

    let response = if let Some(exchange) = find_matching_exchange(&project, &entries, &request_view)
    {
        emit_log(
            &app,
            &project.id,
            "system",
            format!(
                "MOCK HIT {} {} from {} ({})",
                request.method,
                request.target,
                remote_address,
                kind_label(&exchange.kind)
            ),
        );
        build_response_from_record(&exchange.response)?
    } else {
        emit_log(
            &app,
            &project.id,
            "stderr",
            format!(
                "MOCK MISS {} {} from {}",
                request.method, request.target, remote_address
            ),
        );
        build_unmatched_response(&project, &request_view)
    };
    let payload = serialize_response(&response);
    socket.write_all(&payload).await?;
    socket.flush().await?;
    let _ = socket.shutdown().await;
    emit_request_traffic(
        &app,
        &project,
        None,
        Some(remote_address),
        &request.method,
        &request_view.path,
        Some(response.status_code),
        if response.status_code >= 400 {
            Some(format!(
                "Mock response returned {} for {} {}",
                response.status_code, request.method, request_view.path
            ))
        } else {
            None
        },
        Some(started_at.elapsed().as_millis() as u64),
    )
    .await;
    Ok(())
}

fn capture_append_lock(path: &Path) -> Arc<Mutex<()>> {
    let locks = CAPTURE_APPEND_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn load_registry(db_path: &Path, project_id: &str) -> Result<RegistryLoad> {
    let path = capture_file_for_project(db_path, project_id);
    if !path.exists() {
        return Ok(RegistryLoad::default());
    }

    let content = fs::read_to_string(&path)?;
    let mut registry = RegistryLoad::default();
    for (line_number, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }

        match serde_json::from_str::<RecordedExchange>(line) {
            Ok(entry) => registry.entries.push(entry),
            Err(error) => registry.warnings.push(format!(
                "Skipped malformed capture line {} in {}: {}",
                line_number + 1,
                path.display(),
                error
            )),
        }
    }
    Ok(registry)
}

fn append_exchange(db_path: &Path, project_id: &str, exchange: &RecordedExchange) -> Result<()> {
    let path = capture_file_for_project(db_path, project_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut payload = serde_json::to_vec(exchange)?;
    payload.push(b'\n');

    let append_lock = capture_append_lock(&path);
    let _guard = append_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(&payload)?;
    file.flush()?;
    Ok(())
}

fn kind_label(kind: &TrafficKind) -> &'static str {
    match kind {
        TrafficKind::Rest => "rest",
        TrafficKind::Graphql => "graphql",
        TrafficKind::HttpOther => "http_other",
    }
}

fn find_matching_exchange<'a>(
    project: &Project,
    registry: &'a [RecordedExchange],
    request: &RecordedRequest,
) -> Option<&'a RecordedExchange> {
    registry.iter().rev().find(|entry| {
        if !entry.request.method.eq_ignore_ascii_case(&request.method) {
            return false;
        }

        match project.mock_match_mode {
            MockMatchMode::Path => entry.request.path == request.path,
            MockMatchMode::Strict => {
                entry.request.path == request.path
                    && entry.request.query == request.query
                    && entry.request.normalized_body == request.normalized_body
                    && entry.request.content_type == request.content_type
            }
            MockMatchMode::Auto | MockMatchMode::Unknown => {
                if entry.kind != detect_kind_for_record(request) {
                    return false;
                }

                if entry.request.path != request.path {
                    return false;
                }

                match entry.kind {
                    TrafficKind::Graphql => {
                        entry.request.normalized_body == request.normalized_body
                    }
                    TrafficKind::Rest => {
                        if request.body_hex.is_empty() {
                            entry.request.normalized_query == request.normalized_query
                        } else {
                            entry.request.normalized_query == request.normalized_query
                                && entry.request.normalized_body == request.normalized_body
                        }
                    }
                    TrafficKind::HttpOther => {
                        if request.body_hex.is_empty() {
                            entry.request.query == request.query
                        } else {
                            entry.request.query == request.query
                                && entry.request.body_hex == request.body_hex
                        }
                    }
                }
            }
        }
    })
}

fn build_exchange(
    request: &HttpRequestMessage,
    response: &HttpResponseMessage,
) -> RecordedExchange {
    let request_record = build_request_record(request);
    let response_record = build_response_record(response);
    RecordedExchange {
        recorded_at: timestamp_now(),
        kind: detect_kind_for_record(&request_record),
        request: request_record,
        response: response_record,
    }
}

fn build_request_record(request: &HttpRequestMessage) -> RecordedRequest {
    let (path, query) = split_target(&request.target);
    let content_type = header_value(&request.headers, "content-type");
    let body_preview = preview_text(&request.body);
    let normalized_query = normalize_query_string(&query);
    let normalized_body = normalize_body(&request.body, content_type.as_deref());

    RecordedRequest {
        method: request.method.clone(),
        path,
        query,
        version: request.version.clone(),
        headers: request.headers.clone(),
        content_type,
        body_hex: hex_encode(&request.body),
        body_preview,
        normalized_query,
        normalized_body,
    }
}

fn build_response_record(response: &HttpResponseMessage) -> RecordedResponse {
    let content_type = header_value(&response.headers, "content-type");
    RecordedResponse {
        version: response.version.clone(),
        status_code: response.status_code,
        reason_phrase: response.reason_phrase.clone(),
        headers: response.headers.clone(),
        content_type,
        body_hex: hex_encode(&response.body),
        body_preview: preview_text(&response.body),
    }
}

fn build_response_from_record(record: &RecordedResponse) -> Result<HttpResponseMessage> {
    Ok(HttpResponseMessage {
        version: record.version.clone(),
        status_code: record.status_code,
        reason_phrase: if record.reason_phrase.trim().is_empty() {
            default_reason_phrase(record.status_code).to_string()
        } else {
            record.reason_phrase.clone()
        },
        headers: record.headers.clone(),
        body: hex_decode(&record.body_hex)?,
    })
}

fn build_unmatched_response(project: &Project, request: &RecordedRequest) -> HttpResponseMessage {
    let status_code = if project.mock_unmatched_status == 0 {
        404
    } else {
        project.mock_unmatched_status
    };

    let body = serde_json::to_vec(&serde_json::json!({
        "error": "no_mock_match",
        "message": format!("No capture matched {} {}", request.method, request.path),
        "matchMode": project.mock_match_mode.as_str(),
    }))
    .unwrap_or_else(|_| {
        br#"{"error":"no_mock_match","message":"No capture matched request","matchMode":"unknown"}"#
            .to_vec()
    });

    HttpResponseMessage {
        version: "HTTP/1.1".to_string(),
        status_code,
        reason_phrase: default_reason_phrase(status_code).to_string(),
        headers: vec![HeaderEntry {
            name: "Content-Type".to_string(),
            value: "application/json".to_string(),
        }],
        body,
    }
}

fn detect_kind_for_record(request: &RecordedRequest) -> TrafficKind {
    let content_type = request
        .content_type
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if content_type.contains("graphql") || request.path.to_ascii_lowercase().contains("graphql") {
        return TrafficKind::Graphql;
    }

    if !request.normalized_body.is_empty() {
        if let Ok(value) = serde_json::from_str::<Value>(&request.normalized_body) {
            if value.get("query").is_some() {
                return TrafficKind::Graphql;
            }
        }
    }

    if content_type.contains("json") || content_type.contains("xml") || request.path.contains('/') {
        TrafficKind::Rest
    } else {
        TrafficKind::HttpOther
    }
}

fn split_target(target: &str) -> (String, String) {
    match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target.to_string(), String::new()),
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

fn header_value(headers: &[HeaderEntry], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.clone())
}

fn strip_hop_by_hop_headers(headers: &[HeaderEntry]) -> Vec<HeaderEntry> {
    headers
        .iter()
        .filter(|header| {
            !header.name.eq_ignore_ascii_case("content-length")
                && !header.name.eq_ignore_ascii_case("transfer-encoding")
                && !header.name.eq_ignore_ascii_case("connection")
        })
        .cloned()
        .collect()
}

fn serialize_request(request: &HttpRequestMessage) -> Vec<u8> {
    let mut payload = format!(
        "{} {} {}\r\n",
        request.method, request.target, request.version
    )
    .into_bytes();
    let mut headers = strip_hop_by_hop_headers(&request.headers);
    headers.push(HeaderEntry {
        name: "Connection".to_string(),
        value: "close".to_string(),
    });
    if !request.body.is_empty() {
        headers.push(HeaderEntry {
            name: "Content-Length".to_string(),
            value: request.body.len().to_string(),
        });
    }
    for header in headers {
        payload.extend_from_slice(format!("{}: {}\r\n", header.name, header.value).as_bytes());
    }
    payload.extend_from_slice(b"\r\n");
    payload.extend_from_slice(&request.body);
    payload
}

fn serialize_response(response: &HttpResponseMessage) -> Vec<u8> {
    let mut payload = format!(
        "{} {} {}\r\n",
        response.version,
        response.status_code,
        if response.reason_phrase.trim().is_empty() {
            default_reason_phrase(response.status_code)
        } else {
            response.reason_phrase.as_str()
        }
    )
    .into_bytes();
    let mut headers = strip_hop_by_hop_headers(&response.headers);
    headers.push(HeaderEntry {
        name: "Connection".to_string(),
        value: "close".to_string(),
    });
    headers.push(HeaderEntry {
        name: "Content-Length".to_string(),
        value: response.body.len().to_string(),
    });
    for header in headers {
        payload.extend_from_slice(format!("{}: {}\r\n", header.name, header.value).as_bytes());
    }
    payload.extend_from_slice(b"\r\n");
    payload.extend_from_slice(&response.body);
    payload
}

async fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequestMessage> {
    let (start_line, headers, body) = read_http_message(stream, false, false).await?;
    let mut parts = start_line.splitn(3, ' ');
    let method = parts.next().unwrap_or_default().trim();
    let target = parts.next().unwrap_or_default().trim();
    let version = parts.next().unwrap_or("HTTP/1.1").trim();

    if method.is_empty() || target.is_empty() {
        return Err(anyhow!("Invalid HTTP request line: {start_line}"));
    }

    Ok(HttpRequestMessage {
        method: method.to_string(),
        target: target.to_string(),
        version: version.to_string(),
        headers,
        body,
    })
}

async fn read_http_response(
    stream: &mut TcpStream,
    head_response: bool,
) -> Result<HttpResponseMessage> {
    let (start_line, headers, body) = read_http_message(stream, true, head_response).await?;
    let mut parts = start_line.splitn(3, ' ');
    let version = parts.next().unwrap_or("HTTP/1.1").trim();
    let status_code = parts
        .next()
        .unwrap_or("502")
        .trim()
        .parse::<u16>()
        .unwrap_or(502);
    let reason_phrase = parts
        .next()
        .unwrap_or(default_reason_phrase(status_code))
        .trim();

    Ok(HttpResponseMessage {
        version: version.to_string(),
        status_code,
        reason_phrase: reason_phrase.to_string(),
        headers,
        body,
    })
}

async fn read_http_message(
    stream: &mut TcpStream,
    is_response: bool,
    head_response: bool,
) -> Result<(String, Vec<HeaderEntry>, Vec<u8>)> {
    let mut buffer = Vec::new();
    let header_end = loop {
        if let Some(index) = find_sequence(&buffer, b"\r\n\r\n") {
            break index;
        }

        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(anyhow!("Connection closed while reading HTTP headers"));
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let header_bytes = &buffer[..header_end];
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.split("\r\n");
    let start_line = lines.next().unwrap_or_default().trim().to_string();
    if start_line.is_empty() {
        return Err(anyhow!("HTTP message is missing a start line"));
    }

    let mut headers = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| anyhow!("Invalid HTTP header `{line}`"))?;
        headers.push(HeaderEntry {
            name: name.trim().to_string(),
            value: value.trim().to_string(),
        });
    }

    let mut body_buffer = buffer[(header_end + 4)..].to_vec();
    let body = match determine_body_mode(&headers, is_response, &start_line, head_response) {
        BodyMode::None => Vec::new(),
        BodyMode::ContentLength(length) => {
            while body_buffer.len() < length {
                let mut chunk = [0u8; 4096];
                let read = stream.read(&mut chunk).await?;
                if read == 0 {
                    return Err(anyhow!("Connection closed while reading HTTP body"));
                }
                body_buffer.extend_from_slice(&chunk[..read]);
            }
            body_buffer[..length].to_vec()
        }
        BodyMode::Chunked => read_chunked_body(stream, body_buffer).await?,
        BodyMode::UntilClose => {
            let mut chunk = [0u8; 4096];
            loop {
                let read = stream.read(&mut chunk).await?;
                if read == 0 {
                    break;
                }
                body_buffer.extend_from_slice(&chunk[..read]);
            }
            body_buffer
        }
    };

    Ok((start_line, headers, body))
}

#[derive(Debug, Clone, Copy)]
enum BodyMode {
    None,
    ContentLength(usize),
    Chunked,
    UntilClose,
}

fn determine_body_mode(
    headers: &[HeaderEntry],
    is_response: bool,
    start_line: &str,
    head_response: bool,
) -> BodyMode {
    if head_response {
        return BodyMode::None;
    }

    if let Some(value) = header_value(headers, "transfer-encoding") {
        if value.to_ascii_lowercase().contains("chunked") {
            return BodyMode::Chunked;
        }
    }

    if let Some(length) = header_value(headers, "content-length") {
        if let Ok(length) = length.trim().parse::<usize>() {
            return if length == 0 {
                BodyMode::None
            } else {
                BodyMode::ContentLength(length)
            };
        }
    }

    if is_response {
        let mut parts = start_line.split_whitespace();
        let _version = parts.next();
        if let Some(status_text) = parts.next() {
            if let Ok(status_code) = status_text.parse::<u16>() {
                if (100..200).contains(&status_code) || status_code == 204 || status_code == 304 {
                    return BodyMode::None;
                }
            }
        }
        BodyMode::UntilClose
    } else {
        BodyMode::None
    }
}

async fn read_chunked_body(stream: &mut TcpStream, mut buffer: Vec<u8>) -> Result<Vec<u8>> {
    let mut decoded = Vec::new();
    let mut cursor = 0usize;

    loop {
        let line_end = loop {
            if let Some(index) = find_sequence_from(&buffer, b"\r\n", cursor) {
                break index;
            }
            let mut chunk = [0u8; 4096];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                return Err(anyhow!("Connection closed while reading chunk size"));
            }
            buffer.extend_from_slice(&chunk[..read]);
        };

        let size_line = String::from_utf8_lossy(&buffer[cursor..line_end]);
        let size_text = size_line.split(';').next().unwrap_or_default().trim();
        let chunk_size = usize::from_str_radix(size_text, 16)
            .with_context(|| format!("Invalid chunk size `{size_text}`"))?;
        cursor = line_end + 2;

        if chunk_size == 0 {
            loop {
                let trailer_end = loop {
                    if let Some(index) = find_sequence_from(&buffer, b"\r\n", cursor) {
                        break index;
                    }
                    let mut chunk = [0u8; 4096];
                    let read = stream.read(&mut chunk).await?;
                    if read == 0 {
                        return Err(anyhow!("Connection closed while reading chunk trailer"));
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                };

                if trailer_end == cursor {
                    return Ok(decoded);
                }
                cursor = trailer_end + 2;
            }
        }

        while buffer.len() < cursor + chunk_size + 2 {
            let mut chunk = [0u8; 4096];
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                return Err(anyhow!("Connection closed while reading chunk body"));
            }
            buffer.extend_from_slice(&chunk[..read]);
        }

        decoded.extend_from_slice(&buffer[cursor..cursor + chunk_size]);
        cursor += chunk_size;
        if buffer.get(cursor..cursor + 2) != Some(&b"\r\n"[..]) {
            return Err(anyhow!("Chunk payload did not end with CRLF"));
        }
        cursor += 2;
    }
}

fn find_sequence(buffer: &[u8], needle: &[u8]) -> Option<usize> {
    find_sequence_from(buffer, needle, 0)
}

fn find_sequence_from(buffer: &[u8], needle: &[u8], start: usize) -> Option<usize> {
    if needle.is_empty() || buffer.len() < needle.len() || start >= buffer.len() {
        return None;
    }

    let last_start = buffer.len().saturating_sub(needle.len());
    (start..=last_start).find(|index| &buffer[*index..(*index + needle.len())] == needle)
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
        return Err(anyhow!("Hex body length must be even"));
    }

    let mut bytes = Vec::with_capacity(trimmed.len() / 2);
    let chars = trimmed.as_bytes();
    let mut index = 0usize;
    while index < chars.len() {
        let pair = std::str::from_utf8(&chars[index..index + 2])?;
        bytes.push(u8::from_str_radix(pair, 16)?);
        index += 2;
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    use crate::models::{
        default_project_shell, LaunchMode, MockMatchMode, PackageManager, Project, ProjectStatus,
        ReadinessMode, RunMode, RuntimeKind,
    };

    fn sample_project(project_id: &str) -> Project {
        Project {
            id: project_id.to_string(),
            name: "sample".to_string(),
            root_path: ".".to_string(),
            runtime_kind: RuntimeKind::Node,
            package_manager: PackageManager::Npm,
            run_mode: RunMode::Script,
            run_target: "start".to_string(),
            shell: default_project_shell().to_string(),
            selected_env_file: None,
            available_env_files: Vec::new(),
            available_scripts: vec!["start".to_string()],
            port: Some(3032),
            readiness_mode: ReadinessMode::Port,
            readiness_value: Some("3032".to_string()),
            launch_mode: LaunchMode::Mock,
            mock_match_mode: MockMatchMode::Auto,
            mock_unmatched_status: 404,
            startup_phase: 1,
            catalog_order: 1,
            wait_for_previous_ready: false,
            enabled: true,
            tags: Vec::new(),
            mock_summary: crate::models::ProjectMockSummary::default(),
            env_overrides: Vec::new(),
            dependencies: Vec::new(),
            status: ProjectStatus::Idle,
            last_exit_code: None,
        }
    }

    fn sample_exchange() -> RecordedExchange {
        let request = HttpRequestMessage {
            method: "POST".to_string(),
            target: "/graphql".to_string(),
            version: "HTTP/1.1".to_string(),
            headers: vec![HeaderEntry {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
            }],
            body: br#"{"query":"query Ping { ping }"}"#.to_vec(),
        };
        let response = HttpResponseMessage {
            version: "HTTP/1.1".to_string(),
            status_code: 200,
            reason_phrase: "OK".to_string(),
            headers: vec![HeaderEntry {
                name: "Content-Type".to_string(),
                value: "application/json".to_string(),
            }],
            body: br#"{"data":{"ping":"pong"}}"#.to_vec(),
        };

        build_exchange(&request, &response)
    }

    fn temp_db_path() -> PathBuf {
        let unique = format!(
            "orchestrator-mocking-{}-{}-{}",
            std::process::id(),
            timestamp_now(),
            uuid::Uuid::new_v4()
        );
        let root = std::env::temp_dir().join(unique);
        fs::create_dir_all(&root).expect("temp dir");
        root.join("orchestrator.sqlite")
    }

    fn cleanup_temp_root(db_path: &Path) {
        if let Some(root) = db_path.parent() {
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn append_exchange_round_trips_valid_jsonl() {
        let db_path = temp_db_path();
        let exchange = sample_exchange();

        append_exchange(&db_path, "project-1", &exchange).expect("append exchange");
        let registry = load_registry(&db_path, "project-1").expect("load registry");

        assert!(registry.warnings.is_empty());
        assert_eq!(registry.entries.len(), 1);
        assert_eq!(
            registry.entries[0].request.normalized_body,
            exchange.request.normalized_body
        );
        assert_eq!(
            registry.entries[0].response.body_hex,
            exchange.response.body_hex
        );

        let raw = fs::read_to_string(capture_file_for_project(&db_path, "project-1"))
            .expect("capture file");
        let line = raw.lines().next().expect("jsonl line");
        serde_json::from_str::<RecordedExchange>(line).expect("valid json line");

        cleanup_temp_root(&db_path);
    }

    #[test]
    fn load_registry_skips_malformed_lines() {
        let db_path = temp_db_path();
        let capture_dir = capture_dir_for_project(&db_path, "project-2");
        fs::create_dir_all(&capture_dir).expect("capture dir");
        let path = capture_file_for_project(&db_path, "project-2");
        let valid = serde_json::to_string(&sample_exchange()).expect("valid exchange json");
        let content = format!("{valid}\n{{\"broken\":true\n");
        fs::write(&path, content).expect("write capture file");

        let registry = load_registry(&db_path, "project-2").expect("load registry");

        assert_eq!(registry.entries.len(), 1);
        assert_eq!(registry.warnings.len(), 1);
        assert!(registry.warnings[0].contains("Skipped malformed capture line 2"));

        cleanup_temp_root(&db_path);
    }

    #[test]
    fn unmatched_response_body_is_always_valid_json() {
        let project = sample_project("project-3");
        let request = RecordedRequest {
            method: "GET".to_string(),
            path: "/quotes/\"unsafe\"".to_string(),
            query: String::new(),
            version: "HTTP/1.1".to_string(),
            headers: Vec::new(),
            content_type: None,
            body_hex: String::new(),
            body_preview: String::new(),
            normalized_query: String::new(),
            normalized_body: String::new(),
        };

        let response = build_unmatched_response(&project, &request);
        let parsed = serde_json::from_slice::<Value>(&response.body).expect("valid fallback json");

        assert_eq!(parsed["error"], "no_mock_match");
        assert_eq!(
            parsed["message"],
            "No capture matched GET /quotes/\"unsafe\""
        );
        assert_eq!(parsed["matchMode"], "auto");
    }
}
