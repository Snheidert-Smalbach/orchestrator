use std::time::{Duration, Instant};

use anyhow::Result;

// Windows-only standard imports
#[cfg(windows)]
use std::collections::{HashMap, HashSet, VecDeque};
#[cfg(windows)]
use anyhow::anyhow;
#[cfg(windows)]
use serde::Deserialize;

// tokio Command: used on Windows (powershell snapshot) and on macOS (sysctl / vm_stat)
#[cfg(any(windows, target_os = "macos"))]
use tokio::process::Command;

use crate::{models::SystemDiagnostics, AppState};

// Windows-only crate imports
#[cfg(windows)]
use crate::{
    db,
    models::{ProcessDiagnostic, ProjectResourceUsage},
};

const DIAGNOSTICS_CACHE_TTL: Duration = Duration::from_secs(20);

#[derive(Debug, Default)]
pub struct DiagnosticsCache {
    pub last_snapshot: Option<SystemDiagnostics>,
    pub last_updated_at: Option<Instant>,
}

pub async fn invalidate_system_diagnostics(state: &AppState) {
    let mut cache = state.diagnostics_cache.lock().await;
    cache.last_snapshot = None;
    cache.last_updated_at = None;
}

// ── Windows-only types ────────────────────────────────────────────────────────

#[cfg(windows)]
#[derive(Debug, Deserialize)]
struct WindowsDiagnosticsSnapshot {
    os: WindowsOsSnapshot,
    processes: Vec<WindowsProcessSnapshot>,
}

#[cfg(windows)]
#[derive(Debug, Deserialize)]
struct WindowsOsSnapshot {
    #[serde(rename = "TotalVisibleMemorySize")]
    total_visible_memory_size: u64,
    #[serde(rename = "FreePhysicalMemory")]
    free_physical_memory: u64,
}

#[cfg(windows)]
#[derive(Debug, Clone, Deserialize)]
struct WindowsProcessSnapshot {
    #[serde(rename = "ProcessId")]
    process_id: u32,
    #[serde(rename = "ParentProcessId")]
    parent_process_id: Option<u32>,
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "CommandLine")]
    command_line: Option<String>,
    #[serde(rename = "WorkingSetSize")]
    working_set_size: Option<u64>,
}

// ── Windows-only helpers ──────────────────────────────────────────────────────

#[cfg(windows)]
fn is_node_process(process: &WindowsProcessSnapshot) -> bool {
    process
        .name
        .as_deref()
        .map(|name| name.eq_ignore_ascii_case("node.exe") || name.eq_ignore_ascii_case("node"))
        .unwrap_or(false)
}

#[cfg(windows)]
fn working_set_mb(process: &WindowsProcessSnapshot) -> f64 {
    process
        .working_set_size
        .map(|value| value as f64 / 1024.0 / 1024.0)
        .unwrap_or_default()
}

#[cfg(windows)]
fn compact_command(command: Option<&str>, fallback_name: Option<&str>) -> String {
    command
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| fallback_name.map(|value| value.to_string()))
        .unwrap_or_else(|| "process".to_string())
}

#[cfg(windows)]
fn collect_descendant_pids(
    root_pid: u32,
    children_by_parent: &HashMap<u32, Vec<u32>>,
) -> HashSet<u32> {
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([root_pid]);

    while let Some(pid) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }

        if let Some(children) = children_by_parent.get(&pid) {
            for child in children {
                queue.push_back(*child);
            }
        }
    }

    seen
}

#[cfg(windows)]
async fn collect_windows_snapshot() -> Result<WindowsDiagnosticsSnapshot> {
    let script = r#"
$payload = [pscustomobject]@{
  os = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory
  processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize)
}
$payload | ConvertTo-Json -Depth 4 -Compress
"#;

    let output = Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(script)
        .output()
        .await?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let reason = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(anyhow!("PowerShell diagnostics failed: {}", reason));
    }

    Ok(serde_json::from_str(stdout.trim())?)
}

// ── Shared helpers ────────────────────────────────────────────────────────────

fn round_one(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn timestamp_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

// ── Non-Windows memory collection ────────────────────────────────────────────
//
// Returns (total_mb, free_mb).  Each platform uses the best available source:
//   • Linux  → /proc/meminfo  (MemTotal / MemAvailable)
//   • macOS  → `sysctl -n hw.memsize` + `vm_stat` page count
//   • other  → (0.0, 0.0) graceful fallback
//
// Compiled on all platforms so the type-checker stays happy; on Windows it is
// never called and the compiler will optimise it away.
#[allow(dead_code)]
async fn collect_unix_memory_mb() -> (f64, f64) {
    // ── Linux ─────────────────────────────────────────────────────────────────
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
            let mut total_kb: u64 = 0;
            let mut available_kb: u64 = 0;
            for line in content.lines() {
                if let Some(rest) = line.strip_prefix("MemTotal:") {
                    total_kb = rest
                        .split_whitespace()
                        .next()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
                    available_kb = rest
                        .split_whitespace()
                        .next()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                }
            }
            if total_kb > 0 {
                return (total_kb as f64 / 1024.0, available_kb as f64 / 1024.0);
            }
        }
    }

    // ── macOS ─────────────────────────────────────────────────────────────────
    #[cfg(target_os = "macos")]
    {
        // Total physical memory in bytes.
        let total_mb = Command::new("sysctl")
            .arg("-n")
            .arg("hw.memsize")
            .output()
            .await
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .parse::<u64>()
                    .ok()
            })
            .map(|bytes| bytes as f64 / 1024.0 / 1024.0)
            .unwrap_or(0.0);

        // Free memory: count "Pages free" lines in vm_stat output.
        // The system page size is almost always 4 096 bytes on Intel and
        // 16 384 bytes on Apple Silicon; we read it with `pagesize` to be
        // accurate.  Fall back to 4 096 if the command is not available.
        let page_size: u64 = Command::new("pagesize")
            .output()
            .await
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .parse::<u64>()
                    .ok()
            })
            .unwrap_or(4096);

        let free_mb = Command::new("vm_stat")
            .output()
            .await
            .ok()
            .and_then(|o| {
                let stdout = String::from_utf8_lossy(&o.stdout).to_string();
                let pages_free = stdout
                    .lines()
                    .find(|l| l.contains("Pages free:"))?
                    .split(':')
                    .nth(1)?
                    .trim()
                    .trim_end_matches('.')
                    .parse::<u64>()
                    .ok()?;
                Some(pages_free as f64 * page_size as f64 / 1024.0 / 1024.0)
            })
            .unwrap_or(0.0);

        return (total_mb, free_mb);
    }

    // ── Fallback (other Unix-like platforms) ──────────────────────────────────
    #[allow(unreachable_code)]
    (0.0, 0.0)
}

// ── Platform-specific diagnostics implementations ─────────────────────────────

/// Windows full diagnostics: process tree, memory, node tracking.
#[cfg(windows)]
async fn collect_diagnostics_inner(state: &AppState) -> Result<SystemDiagnostics> {
    let snapshot = collect_windows_snapshot().await?;
    let projects = db::list_projects(&state.db_path)?;
    let running = state.runtime.lock().await.running.clone();

    let processes_by_pid = snapshot
        .processes
        .iter()
        .cloned()
        .map(|process| (process.process_id, process))
        .collect::<HashMap<_, _>>();

    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    for process in &snapshot.processes {
        if let Some(parent_pid) = process.parent_process_id {
            children_by_parent
                .entry(parent_pid)
                .or_default()
                .push(process.process_id);
        }
    }

    let mut tracked_pids = HashSet::<u32>::new();
    let mut tracked_project_by_pid = HashMap::<u32, String>::new();
    let mut project_resources = Vec::new();

    for project in &projects {
        let Some(entry) = running.get(&project.id) else {
            continue;
        };

        let Some(root_pid) = entry.pid else {
            project_resources.push(ProjectResourceUsage {
                project_id: project.id.clone(),
                project_name: project.name.clone(),
                tracked_pid: None,
                total_processes: 0,
                total_node_processes: 0,
                total_working_set_mb: 0.0,
                total_node_working_set_mb: 0.0,
                command_preview: entry.command_preview.clone(),
            });
            continue;
        };

        let subtree = collect_descendant_pids(root_pid, &children_by_parent);
        let subtree_processes = subtree
            .iter()
            .filter_map(|pid| processes_by_pid.get(pid))
            .collect::<Vec<_>>();

        for pid in &subtree {
            tracked_pids.insert(*pid);
            tracked_project_by_pid.insert(*pid, project.id.clone());
        }

        let total_working_set_mb = subtree_processes
            .iter()
            .map(|process| working_set_mb(process))
            .sum::<f64>();

        let node_processes = subtree_processes
            .iter()
            .filter(|process| is_node_process(process))
            .collect::<Vec<_>>();

        let total_node_working_set_mb = node_processes
            .iter()
            .map(|process| working_set_mb(process))
            .sum::<f64>();

        let command_preview = node_processes
            .first()
            .map(|process| {
                compact_command(process.command_line.as_deref(), process.name.as_deref())
            })
            .or_else(|| {
                subtree_processes.first().map(|process| {
                    compact_command(process.command_line.as_deref(), process.name.as_deref())
                })
            })
            .or_else(|| entry.command_preview.clone());

        project_resources.push(ProjectResourceUsage {
            project_id: project.id.clone(),
            project_name: project.name.clone(),
            tracked_pid: Some(root_pid),
            total_processes: subtree_processes.len() as u32,
            total_node_processes: node_processes.len() as u32,
            total_working_set_mb: round_one(total_working_set_mb),
            total_node_working_set_mb: round_one(total_node_working_set_mb),
            command_preview,
        });
    }

    project_resources.sort_by(|left, right| {
        right
            .total_working_set_mb
            .partial_cmp(&left.total_working_set_mb)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut top_node_processes = snapshot
        .processes
        .iter()
        .filter(|process| is_node_process(process))
        .map(|process| ProcessDiagnostic {
            project_id: tracked_project_by_pid.get(&process.process_id).cloned(),
            pid: process.process_id,
            parent_pid: process.parent_process_id,
            name: process.name.clone().unwrap_or_else(|| "node".to_string()),
            command: compact_command(process.command_line.as_deref(), process.name.as_deref()),
            working_set_mb: round_one(working_set_mb(process)),
        })
        .collect::<Vec<_>>();

    top_node_processes.sort_by(|left, right| {
        right
            .working_set_mb
            .partial_cmp(&left.working_set_mb)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let untracked_node_processes = top_node_processes
        .iter()
        .filter(|process| !tracked_pids.contains(&process.pid))
        .take(8)
        .cloned()
        .collect::<Vec<_>>();

    let total_node_processes = top_node_processes.len() as u32;
    let total_node_working_set_mb = top_node_processes
        .iter()
        .map(|process| process.working_set_mb)
        .sum::<f64>();

    Ok(SystemDiagnostics {
        collected_at: timestamp_now(),
        total_node_processes,
        total_node_working_set_mb: round_one(total_node_working_set_mb),
        total_physical_memory_mb: round_one(
            snapshot.os.total_visible_memory_size as f64 / 1024.0,
        ),
        free_physical_memory_mb: round_one(snapshot.os.free_physical_memory as f64 / 1024.0),
        project_resources,
        top_node_processes: top_node_processes.into_iter().take(10).collect(),
        untracked_node_processes,
    })
}

/// Linux / macOS diagnostics: real memory stats, no process-tree tracking yet.
#[cfg(not(windows))]
async fn collect_diagnostics_inner(_state: &AppState) -> Result<SystemDiagnostics> {
    let (total_mb, free_mb) = collect_unix_memory_mb().await;
    Ok(SystemDiagnostics {
        collected_at: timestamp_now(),
        total_node_processes: 0,
        total_node_working_set_mb: 0.0,
        total_physical_memory_mb: round_one(total_mb),
        free_physical_memory_mb: round_one(free_mb),
        project_resources: Vec::new(),
        top_node_processes: Vec::new(),
        untracked_node_processes: Vec::new(),
    })
}

// ── Public entry point ────────────────────────────────────────────────────────

pub async fn collect_system_diagnostics(state: AppState) -> Result<SystemDiagnostics> {
    {
        let cache = state.diagnostics_cache.lock().await;
        if let (Some(snapshot), Some(updated_at)) = (&cache.last_snapshot, cache.last_updated_at) {
            if updated_at.elapsed() < DIAGNOSTICS_CACHE_TTL {
                return Ok(snapshot.clone());
            }
        }
    }

    let diagnostics = collect_diagnostics_inner(&state).await?;

    let mut cache = state.diagnostics_cache.lock().await;
    cache.last_snapshot = Some(diagnostics.clone());
    cache.last_updated_at = Some(Instant::now());

    Ok(diagnostics)
}
