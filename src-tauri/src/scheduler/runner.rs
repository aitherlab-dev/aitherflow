use std::str::FromStr;
use std::time::Duration;

use chrono::{Datelike, Local, Timelike};
use cron::Schedule;
use tauri::Manager;

use super::{load_tasks, save_tasks, ScheduledTask, TaskRunStatus, TaskSchedule};
use crate::conductor::process::{CliSessionConfig, EventSink};
use crate::conductor::session::SessionManager;

/// Main scheduler loop. Runs every 30 seconds, checks all tasks.
pub async fn start_scheduler(app_handle: tauri::AppHandle) {
    eprintln!("[scheduler] Started");

    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;

        let tasks = match tokio::task::spawn_blocking(load_tasks).await {
            Ok(tasks) => tasks,
            Err(e) => {
                eprintln!("[scheduler] Failed to load tasks: {e}");
                continue;
            }
        };

        let now = Local::now();

        for task in &tasks {
            if !task.enabled {
                continue;
            }
            if !should_run(task, &now) {
                continue;
            }

            eprintln!("[scheduler] Running task '{}' ({})", task.name, task.id);
            run_task_now(&app_handle, task).await;
        }
    }
}

/// Check if a task should run based on its schedule and last_run.
fn should_run(task: &ScheduledTask, now: &chrono::DateTime<Local>) -> bool {
    let last_run = task
        .last_run
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Local));

    // Don't re-run if already running
    if matches!(task.last_status, Some(TaskRunStatus::Running)) {
        return false;
    }

    match &task.schedule {
        TaskSchedule::Interval { minutes } => {
            let Some(last) = last_run else {
                return true; // never ran
            };
            let elapsed = (*now - last).num_minutes();
            elapsed >= *minutes as i64
        }
        TaskSchedule::Daily { hour, minute } => {
            if now.hour() as u8 != *hour || now.minute() as u8 != *minute {
                return false;
            }
            // Check we haven't already run this minute
            match last_run {
                Some(last) => last.date_naive() < now.date_naive() || last.hour() as u8 != *hour || last.minute() as u8 != *minute,
                None => true,
            }
        }
        TaskSchedule::Weekly {
            day,
            hour,
            minute,
        } => {
            // day: 0=Mon..6=Sun; chrono: Mon=0..Sun=6 via weekday().num_days_from_monday()
            let current_day = now.weekday().num_days_from_monday() as u8;
            if current_day != *day || now.hour() as u8 != *hour || now.minute() as u8 != *minute {
                return false;
            }
            match last_run {
                Some(last) => {
                    // Haven't run this week at this time
                    let days_since = (*now - last).num_days();
                    days_since >= 1
                }
                None => true,
            }
        }
        TaskSchedule::Cron { expression } => {
            // cron crate uses 7-field format: sec min hour dom month dow year
            // User provides 5-field: min hour dom month dow
            // Prepend "0 " (second=0) and append " *" (year=any)
            let full_expr = format!("0 {expression} *");
            let schedule = match Schedule::from_str(&full_expr) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[scheduler] Invalid cron expression '{}': {e}", expression);
                    return false;
                }
            };

            // cron crate works in UTC internally; convert results to Local for comparison
            let now_utc = now.with_timezone(&chrono::Utc);
            let window_start = now_utc - chrono::Duration::seconds(30);
            if let Some(next_utc) = schedule.after(&window_start).next() {
                let next_local = next_utc.with_timezone(&Local);
                if next_local <= *now {
                    // Check we haven't already run for this occurrence
                    match last_run {
                        Some(last) => (*now - last).num_seconds() > 30,
                        None => true,
                    }
                } else {
                    false
                }
            } else {
                false
            }
        }
    }
}

/// Launch a scheduled task as an agent session (public for `scheduler_run_now` command).
pub async fn run_task_now(app_handle: &tauri::AppHandle, task: &ScheduledTask) {
    let agent_id = format!("scheduler_{}", task.id);
    let now_iso = Local::now().to_rfc3339();

    // Update last_run and status
    if let Err(e) = tokio::task::spawn_blocking({
        let task_id = task.id.clone();
        let now_iso = now_iso.clone();
        move || {
            let mut tasks = load_tasks();
            if let Some(t) = tasks.iter_mut().find(|t| t.id == task_id) {
                t.last_run = Some(now_iso);
                t.last_status = Some(TaskRunStatus::Running);
            }
            save_tasks(&tasks)
        }
    })
    .await
    {
        eprintln!("[scheduler] Failed to update task status: {e}");
    }

    // Emit event for UI
    if let Err(e) = tauri::Emitter::emit(app_handle, "scheduler:task-started", &task.id) {
        eprintln!("[scheduler] Failed to emit task-started: {e}");
    }

    // Get additional dirs for the project
    let project_path = task.project_path.clone();
    let additional_dirs = {
        let pp = project_path.clone();
        tokio::task::spawn_blocking(move || crate::projects::get_additional_dirs_sync(&pp))
            .await
            .unwrap_or_default()
    };

    let sessions: SessionManager = app_handle.state::<SessionManager>().inner().clone();
    let app_clone = app_handle.clone();
    let prompt = task.prompt.clone();
    let teamwork_project_path = Some(project_path.clone());

    let task_id_for_spawn = task.id.clone();
    tokio::spawn(async move {
        let result = crate::conductor::process::run_cli_session(
            EventSink::new(app_clone.clone()),
            sessions,
            CliSessionConfig {
                agent_id: agent_id.clone(),
                prompt,
                project_path: Some(project_path),
                model: None,
                effort: None,
                resume_session_id: None,
                permission_mode: None,
                chrome: false,
                image_attachments: Vec::new(),
                teamwork_project_path,
                additional_dirs,
                role_system_prompt: None,
                role_allowed_tools: None,
                role_name: None,
            },
        )
        .await;

        let final_status = match &result {
            Ok(()) => TaskRunStatus::Success,
            Err(e) => {
                eprintln!("[scheduler] Task {agent_id} error: {e}");
                if let Err(e2) = tauri::Emitter::emit(
                    &app_clone,
                    "cli-event",
                    &crate::conductor::types::CliEvent::Error {
                        agent_id: agent_id.into(),
                        message: e.clone(),
                    },
                ) {
                    eprintln!("[scheduler] Failed to emit error: {e2}");
                }
                TaskRunStatus::Error
            }
        };

        // Update last_status after completion
        let tid = task_id_for_spawn;
        if let Err(e) = tokio::task::spawn_blocking(move || {
            let mut tasks = load_tasks();
            if let Some(t) = tasks.iter_mut().find(|t| t.id == tid) {
                t.last_status = Some(final_status);
            }
            save_tasks(&tasks)
        })
        .await
        {
            eprintln!("[scheduler] Failed to update final status: {e}");
        }
    });
}
