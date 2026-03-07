use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

/// In-memory cache: (days, computed_at, stats).
static STATS_CACHE: Mutex<Option<(u32, Instant, AggregatedStats)>> = Mutex::new(None);

const CACHE_TTL_SECS: u64 = 300; // 5 minutes

/// Model pricing per million tokens (USD).
/// Prices as of 2025 for Claude models.
struct ModelPricing {
    input_per_m: f64,
    output_per_m: f64,
    cache_read_per_m: f64,
}

fn pricing_for_model(model: &str) -> ModelPricing {
    if model.contains("opus") {
        ModelPricing {
            input_per_m: 15.0,
            output_per_m: 75.0,
            cache_read_per_m: 1.875,
        }
    } else if model.contains("haiku") {
        ModelPricing {
            input_per_m: 0.80,
            output_per_m: 4.0,
            cache_read_per_m: 0.08,
        }
    } else {
        // Sonnet / default
        ModelPricing {
            input_per_m: 3.0,
            output_per_m: 15.0,
            cache_read_per_m: 0.30,
        }
    }
}

fn estimate_cost(model: &str, input: u64, cache_creation: u64, cache_read: u64, output: u64) -> f64 {
    let p = pricing_for_model(model);
    let m = 1_000_000.0;
    ((input + cache_creation) as f64 * p.input_per_m
        + cache_read as f64 * p.cache_read_per_m
        + output as f64 * p.output_per_m)
        / m
}

/// Decode project directory name back to a human-readable short name.
/// "-home-sasha-WORK-AITHEFLOW" → "AITHEFLOW"
fn project_display_name(dir_name: &str) -> String {
    dir_name
        .rsplit('-')
        .next()
        .unwrap_or(dir_name)
        .to_string()
}

#[derive(Serialize, Default, Clone)]
pub struct DayStats {
    pub date: String,
    pub cost: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub sessions: u32,
}

#[derive(Serialize, Default, Clone)]
pub struct ModelStats {
    pub model: String,
    pub cost: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Serialize, Default, Clone)]
pub struct ProjectStats {
    pub project: String,
    pub cost: f64,
    pub sessions: u32,
    pub output_tokens: u64,
}

#[derive(Serialize, Clone)]
pub struct AggregatedStats {
    pub total_cost: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_sessions: u32,
    pub by_day: Vec<DayStats>,
    pub by_model: Vec<ModelStats>,
    pub by_project: Vec<ProjectStats>,
}

/// Per-session parsed stats, cached to disk keyed by file path + mtime.
#[derive(Serialize, Deserialize, Clone)]
struct CachedSession {
    mtime_secs: u64,
    date: String,
    model: String,
    project: String,
    cost: f64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
}

/// Disk cache: path → CachedSession.
type DiskCache = HashMap<String, CachedSession>;

fn cache_path() -> Option<PathBuf> {
    let cache_dir = dirs::cache_dir()?.join("aither-flow");
    Some(cache_dir.join("cli-stats-cache.json"))
}

fn load_disk_cache() -> DiskCache {
    let Some(path) = cache_path() else {
        return HashMap::new();
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_disk_cache(cache: &DiskCache) {
    let Some(path) = cache_path() else { return };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[stats] Failed to create cache dir: {e}");
            return;
        }
    }
    if let Ok(json) = serde_json::to_string(cache) {
        if let Err(e) = crate::file_ops::atomic_write(&path, json.as_bytes()) {
            eprintln!("[stats] Failed to write cache: {e}");
        }
    }
}

fn file_mtime_secs(path: &std::path::Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Return cached stats if fresh, otherwise compute and cache.
/// Holds lock during computation to prevent stampede.
pub fn aggregate_cli_stats(days: u32) -> Result<AggregatedStats, String> {
    let mut guard = STATS_CACHE.lock().unwrap_or_else(|e| e.into_inner());

    if let Some((cached_days, computed_at, ref stats)) = *guard {
        if cached_days == days && computed_at.elapsed().as_secs() < CACHE_TTL_SECS {
            return Ok(stats.clone());
        }
    }

    let stats = aggregate_cli_stats_inner(days)?;
    *guard = Some((days, Instant::now(), stats.clone()));
    Ok(stats)
}

/// Scan all JSONL files in ~/.claude/projects/ and aggregate stats.
/// Uses disk cache to avoid re-parsing unchanged files.
fn aggregate_cli_stats_inner(days: u32) -> Result<AggregatedStats, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    if !projects_dir.exists() {
        return Ok(empty_stats());
    }

    let cutoff = chrono::Utc::now() - chrono::Duration::days(i64::from(days));
    let cutoff_secs = cutoff.timestamp() as u64;
    let cutoff_str = cutoff.format("%Y-%m-%d").to_string();

    let mut disk_cache = load_disk_cache();
    let mut cache_dirty = false;

    let mut by_day: HashMap<String, DayStats> = HashMap::new();
    let mut by_model: HashMap<String, ModelStats> = HashMap::new();
    let mut by_project: HashMap<String, ProjectStats> = HashMap::new();

    let project_dirs: Vec<_> = std::fs::read_dir(&projects_dir)
        .map_err(|e| format!("Failed to read projects dir: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|ft| ft.is_dir()).unwrap_or(false))
        .collect();

    for proj_entry in &project_dirs {
        let proj_name = proj_entry.file_name().to_string_lossy().to_string();
        let display_name = project_display_name(&proj_name);

        let jsonl_files = collect_jsonl_recursive(&proj_entry.path());

        for jsonl_path in &jsonl_files {
            let mtime = file_mtime_secs(jsonl_path);

            // Skip files older than cutoff by mtime
            if mtime < cutoff_secs {
                continue;
            }

            let path_key = jsonl_path.to_string_lossy().to_string();

            // Try disk cache first
            let session = if let Some(cached) = disk_cache.get(&path_key) {
                if cached.mtime_secs == mtime {
                    // File unchanged, use cached
                    if cached.date < cutoff_str {
                        continue; // Session before cutoff
                    }
                    cached.clone()
                } else {
                    // File changed, re-parse
                    match parse_and_cache(jsonl_path, &display_name, mtime, &cutoff_str) {
                        Some(s) => {
                            disk_cache.insert(path_key, s.clone());
                            cache_dirty = true;
                            s
                        }
                        None => {
                            disk_cache.remove(&path_key);
                            cache_dirty = true;
                            continue;
                        }
                    }
                }
            } else {
                // Not in cache, parse
                match parse_and_cache(jsonl_path, &display_name, mtime, &cutoff_str) {
                    Some(s) => {
                        disk_cache.insert(path_key, s.clone());
                        cache_dirty = true;
                        s
                    }
                    None => continue,
                }
            };

            // Aggregate by day
            let day = by_day.entry(session.date.clone()).or_insert_with(|| DayStats {
                date: session.date.clone(),
                ..Default::default()
            });
            day.cost += session.cost;
            day.input_tokens += session.input_tokens;
            day.output_tokens += session.output_tokens;
            day.cache_read_tokens += session.cache_read_tokens;
            day.cache_creation_tokens += session.cache_creation_tokens;
            day.sessions += 1;

            // Aggregate by model
            let model = by_model.entry(session.model.clone()).or_insert_with(|| ModelStats {
                model: session.model.clone(),
                ..Default::default()
            });
            model.cost += session.cost;
            model.input_tokens += session.input_tokens;
            model.output_tokens += session.output_tokens;

            // Aggregate by project
            let proj = by_project.entry(session.project.clone()).or_insert_with(|| ProjectStats {
                project: session.project.clone(),
                ..Default::default()
            });
            proj.cost += session.cost;
            proj.sessions += 1;
            proj.output_tokens += session.output_tokens;
        }
    }

    if cache_dirty {
        save_disk_cache(&disk_cache);
    }

    // Sort and collect
    let mut by_day_vec: Vec<_> = by_day.into_values().collect();
    by_day_vec.sort_by(|a, b| a.date.cmp(&b.date));

    let mut by_model_vec: Vec<_> = by_model.into_values().collect();
    by_model_vec.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    let mut by_project_vec: Vec<_> = by_project.into_values().collect();
    by_project_vec.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    let total_cost: f64 = by_day_vec.iter().map(|d| d.cost).sum();
    let total_input: u64 = by_day_vec.iter().map(|d| d.input_tokens).sum();
    let total_output: u64 = by_day_vec.iter().map(|d| d.output_tokens).sum();
    let total_sessions: u32 = by_day_vec.iter().map(|d| d.sessions).sum();

    Ok(AggregatedStats {
        total_cost,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        total_sessions,
        by_day: by_day_vec,
        by_model: by_model_vec,
        by_project: by_project_vec,
    })
}

/// Parse a JSONL file and return a CachedSession (with project name baked in).
fn parse_and_cache(
    path: &PathBuf,
    project: &str,
    mtime: u64,
    cutoff_date: &str,
) -> Option<CachedSession> {
    let content = std::fs::read_to_string(path).ok()?;

    let mut model = String::new();
    let mut date = String::new();
    let mut sum_input: u64 = 0;
    let mut sum_output: u64 = 0;
    let mut sum_cache_creation: u64 = 0;
    let mut sum_cache_read: u64 = 0;
    let mut found_any = false;

    for line in content.lines() {
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if date.is_empty() {
            if let Some(ts) = parsed.get("timestamp").and_then(|t| t.as_str()) {
                if let Some(d) = ts.get(..10) {
                    if d < cutoff_date {
                        return None;
                    }
                    date = d.to_string();
                }
            }
        }

        if parsed.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }

        let msg = match parsed.get("message") {
            Some(m) => m,
            None => continue,
        };
        let usage = match msg.get("usage") {
            Some(u) => u,
            None => continue,
        };

        found_any = true;

        if let Some(m) = msg.get("model").and_then(|m| m.as_str()) {
            model = m.to_string();
        }

        sum_input += usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        sum_output += usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        sum_cache_creation += usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        sum_cache_read += usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
    }

    if !found_any || date.is_empty() {
        return None;
    }

    let cost = estimate_cost(&model, sum_input, sum_cache_creation, sum_cache_read, sum_output);

    Some(CachedSession {
        mtime_secs: mtime,
        date,
        model,
        project: project.to_string(),
        cost,
        input_tokens: sum_input + sum_cache_creation + sum_cache_read,
        output_tokens: sum_output,
        cache_read_tokens: sum_cache_read,
        cache_creation_tokens: sum_cache_creation,
    })
}

/// Recursively collect all .jsonl files in a directory (includes subagents/).
fn collect_jsonl_recursive(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return result,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "jsonl") {
            result.push(path);
        } else if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            result.extend(collect_jsonl_recursive(&path));
        }
    }
    result
}

fn empty_stats() -> AggregatedStats {
    AggregatedStats {
        total_cost: 0.0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_sessions: 0,
        by_day: vec![],
        by_model: vec![],
        by_project: vec![],
    }
}
