use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;

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

#[derive(Serialize)]
pub struct AggregatedStats {
    pub total_cost: f64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_sessions: u32,
    pub by_day: Vec<DayStats>,
    pub by_model: Vec<ModelStats>,
    pub by_project: Vec<ProjectStats>,
}

/// Scan all JSONL files in ~/.claude/projects/ and aggregate stats.
/// `days` limits to the last N days.
pub fn aggregate_cli_stats(days: u32) -> Result<AggregatedStats, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let projects_dir = home.join(".claude").join("projects");

    if !projects_dir.exists() {
        return Ok(empty_stats());
    }

    let cutoff = chrono::Utc::now() - chrono::Duration::days(i64::from(days));
    let cutoff_str = cutoff.format("%Y-%m-%d").to_string();

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
            // Quick date filter: check file mtime
            if let Ok(meta) = jsonl_path.metadata() {
                if let Ok(modified) = meta.modified() {
                    let mtime: chrono::DateTime<chrono::Utc> = modified.into();
                    if mtime < cutoff {
                        continue;
                    }
                }
            }

            if let Some(session) = parse_session_stats(jsonl_path, &cutoff_str) {
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
                let proj = by_project.entry(display_name.clone()).or_insert_with(|| ProjectStats {
                    project: display_name.clone(),
                    ..Default::default()
                });
                proj.cost += session.cost;
                proj.sessions += 1;
                proj.output_tokens += session.output_tokens;
            }
        }
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

struct SessionStats {
    date: String,
    model: String,
    cost: f64,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
}

/// Parse a single JSONL file and extract session-level stats.
/// Returns None if the session has no assistant events or is before cutoff.
fn parse_session_stats(path: &PathBuf, cutoff_date: &str) -> Option<SessionStats> {
    let content = std::fs::read_to_string(path).ok()?;

    let mut model = String::new();
    let mut date = String::new();
    // Sum across ALL turns for accurate cost
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

        // Get session date from first event with timestamp
        if date.is_empty() {
            if let Some(ts) = parsed.get("timestamp").and_then(|t| t.as_str()) {
                // "2026-03-04T08:01:10.977Z" → "2026-03-04"
                if let Some(d) = ts.get(..10) {
                    if d < cutoff_date {
                        return None; // Session is before cutoff
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

        // Each API call bills for its full input context + output
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

    Some(SessionStats {
        date,
        model,
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
