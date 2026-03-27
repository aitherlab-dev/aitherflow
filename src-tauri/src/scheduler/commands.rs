use super::{load_tasks, save_tasks, ScheduledTask};

#[tauri::command]
pub async fn scheduler_list_tasks() -> Result<Vec<ScheduledTask>, String> {
    tokio::task::spawn_blocking(load_tasks)
        .await
        .map_err(|e| format!("Task failed: {e}"))
}

#[tauri::command]
pub async fn scheduler_save_task(mut task: ScheduledTask) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut tasks = load_tasks();

        if task.id.is_empty() {
            task.id = uuid::Uuid::new_v4().to_string();
            task.created_at = chrono::Local::now().to_rfc3339();
            tasks.push(task);
        } else if let Some(existing) = tasks.iter_mut().find(|t| t.id == task.id) {
            *existing = task;
        } else {
            tasks.push(task);
        }

        save_tasks(&tasks)
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn scheduler_delete_task(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut tasks = load_tasks();
        let len_before = tasks.len();
        tasks.retain(|t| t.id != id);
        if tasks.len() == len_before {
            return Err(format!("Task not found: {id}"));
        }
        save_tasks(&tasks)
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn scheduler_toggle_task(id: String, enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut tasks = load_tasks();
        let Some(task) = tasks.iter_mut().find(|t| t.id == id) else {
            return Err(format!("Task not found: {id}"));
        };
        task.enabled = enabled;
        save_tasks(&tasks)
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

#[tauri::command]
pub async fn scheduler_run_now(id: String, app: tauri::AppHandle) -> Result<(), String> {
    let task = tokio::task::spawn_blocking(move || {
        let tasks = load_tasks();
        tasks
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("Task not found: {id}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))??;

    super::runner::run_task_now(&app, &task).await;
    Ok(())
}
