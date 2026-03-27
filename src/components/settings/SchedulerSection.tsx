import { useState, useEffect, useCallback } from "react";
import { Plus, Play, Trash2, X, Save } from "lucide-react";
import { invoke } from "../../lib/transport";
import { Tooltip } from "../shared/Tooltip";
import type { ScheduledTask, TaskSchedule } from "../../types/scheduler";
import type { ProjectBookmark } from "../../types/projects";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function formatScheduleLabel(s: TaskSchedule): string {
  switch (s.type) {
    case "interval":
      return `Every ${s.minutes} minutes`;
    case "daily":
      return `Daily at ${pad(s.hour)}:${pad(s.minute)}`;
    case "weekly":
      return `${DAYS[s.day] ?? "?"} at ${pad(s.hour)}:${pad(s.minute)}`;
    case "cron":
      return `Cron: ${s.expression}`;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function emptyTask(): ScheduledTask {
  return {
    id: "",
    name: "",
    prompt: "",
    project_path: "",
    schedule: { type: "interval", minutes: 60 },
    enabled: true,
    notify_telegram: false,
    created_at: "",
    last_run: null,
    last_status: null,
  };
}

export function SchedulerSection() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [projects, setProjects] = useState<ProjectBookmark[]>([]);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadTasks = useCallback(() => {
    invoke<ScheduledTask[]>("scheduler_list_tasks")
      .then((result) => {
        setTasks(result);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    loadTasks();
    invoke<{ projects: ProjectBookmark[] }>("load_projects")
      .then((cfg) => setProjects(cfg.projects))
      .catch(console.error);
  }, [loadTasks]);

  const handleToggle = useCallback(
    (id: string, enabled: boolean) => {
      invoke("scheduler_toggle_task", { id, enabled })
        .then(loadTasks)
        .catch(console.error);
    },
    [loadTasks],
  );

  const handleDelete = useCallback(
    (id: string) => {
      invoke("scheduler_delete_task", { id })
        .then(loadTasks)
        .catch(console.error);
    },
    [loadTasks],
  );

  const handleRunNow = useCallback(
    (id: string) => {
      invoke("scheduler_run_now", { id })
        .then(loadTasks)
        .catch(console.error);
    },
    [loadTasks],
  );

  const handleSave = useCallback(() => {
    if (!editing) return;
    if (!editing.name.trim() || !editing.prompt.trim() || !editing.project_path) return;
    invoke("scheduler_save_task", { task: editing })
      .then(() => {
        setEditing(null);
        loadTasks();
      })
      .catch(console.error);
  }, [editing, loadTasks]);

  const handleAdd = useCallback(() => {
    const task = emptyTask();
    if (projects.length > 0) {
      task.project_path = projects[0].path;
    }
    setEditing(task);
  }, [projects]);

  if (!loaded) return null;

  return (
    <div className="settings-section-general">
      {/* Task list */}
      {tasks.length === 0 && !editing && (
        <div className="scheduler-empty">No scheduled tasks</div>
      )}

      {tasks.map((task) => (
        <div key={task.id} className="scheduler-task-row">
          <div className="scheduler-task-info" onClick={() => setEditing({ ...task })}>
            <div className="scheduler-task-name" style={{ opacity: task.enabled ? 1 : 0.5 }}>
              {task.name}
              {task.last_status && (
                <span
                  className={`scheduler-status-dot scheduler-status-dot--${task.last_status}`}
                />
              )}
            </div>
            <div className="scheduler-task-meta">
              {formatScheduleLabel(task.schedule)}
              {" \u00b7 "}
              {projects.find((p) => p.path === task.project_path)?.name ?? task.project_path}
            </div>
          </div>
          <div className="scheduler-task-actions">
            <Tooltip text="Run now">
              <button
                className="settings-input-toggle"
                onClick={() => handleRunNow(task.id)}
                disabled={task.last_status === "running"}
              >
                <Play size={13} />
              </button>
            </Tooltip>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={task.enabled}
                onChange={(e) => handleToggle(task.id, e.target.checked)}
              />
              <span className="toggle-switch-track" />
            </label>
            <Tooltip text="Delete">
              <button className="settings-input-toggle" onClick={() => handleDelete(task.id)}>
                <Trash2 size={13} />
              </button>
            </Tooltip>
          </div>
        </div>
      ))}

      {/* Editor */}
      {editing && (
        <div className="scheduler-editor">
          <div className="scheduler-editor-header">
            <span className="settings-toggle-label">
              {editing.id ? "Edit task" : "New task"}
            </span>
            <button className="settings-input-toggle" onClick={() => setEditing(null)}>
              <X size={14} />
            </button>
          </div>

          {/* Name */}
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Name</span>
            </div>
            <input
              type="text"
              className="settings-input"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="Task name"
            />
          </div>

          {/* Prompt */}
          <div className="settings-toggle-row" style={{ alignItems: "flex-start" }}>
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Prompt</span>
            </div>
            <textarea
              className="settings-input scheduler-textarea"
              value={editing.prompt}
              onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
              placeholder="What should the agent do?"
              rows={4}
            />
          </div>

          {/* Project */}
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Project</span>
            </div>
            <select
              className="settings-select"
              value={editing.project_path}
              onChange={(e) => setEditing({ ...editing, project_path: e.target.value })}
            >
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Schedule type */}
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Schedule</span>
            </div>
            <select
              className="settings-select"
              value={editing.schedule.type}
              onChange={(e) => {
                const type = e.target.value as TaskSchedule["type"];
                let schedule: TaskSchedule;
                switch (type) {
                  case "interval":
                    schedule = { type: "interval", minutes: 60 };
                    break;
                  case "daily":
                    schedule = { type: "daily", hour: 9, minute: 0 };
                    break;
                  case "weekly":
                    schedule = { type: "weekly", day: 0, hour: 9, minute: 0 };
                    break;
                  case "cron":
                    schedule = { type: "cron", expression: "0 9 * * *" };
                    break;
                }
                setEditing({ ...editing, schedule });
              }}
            >
              <option value="interval">Every X minutes</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="cron">Cron expression</option>
            </select>
          </div>

          {/* Schedule params */}
          {editing.schedule.type === "interval" && (
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Minutes</span>
              </div>
              <input
                type="number"
                className="settings-input scheduler-num-input"
                min={1}
                value={editing.schedule.minutes}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    schedule: { type: "interval", minutes: Math.max(1, Number(e.target.value)) },
                  })
                }
              />
            </div>
          )}

          {editing.schedule.type === "daily" && (
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Time</span>
              </div>
              <input
                type="time"
                className="settings-input scheduler-time-input"
                value={`${pad(editing.schedule.hour)}:${pad(editing.schedule.minute)}`}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(":").map(Number);
                  setEditing({
                    ...editing,
                    schedule: { type: "daily", hour: h, minute: m },
                  });
                }}
              />
            </div>
          )}

          {editing.schedule.type === "weekly" && (
            <>
              <div className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <span className="settings-toggle-label">Day</span>
                </div>
                <select
                  className="settings-select"
                  value={editing.schedule.day}
                  onChange={(e) => {
                    const s = editing.schedule as { type: "weekly"; day: number; hour: number; minute: number };
                    setEditing({
                      ...editing,
                      schedule: { type: "weekly", day: Number(e.target.value), hour: s.hour, minute: s.minute },
                    });
                  }}
                >
                  {DAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <span className="settings-toggle-label">Time</span>
                </div>
                <input
                  type="time"
                  className="settings-input scheduler-time-input"
                  value={`${pad(editing.schedule.hour)}:${pad(editing.schedule.minute)}`}
                  onChange={(e) => {
                    const [h, m] = e.target.value.split(":").map(Number);
                    const s = editing.schedule as { type: "weekly"; day: number; hour: number; minute: number };
                    setEditing({
                      ...editing,
                      schedule: { type: "weekly", day: s.day, hour: h, minute: m },
                    });
                  }}
                />
              </div>
            </>
          )}

          {editing.schedule.type === "cron" && (
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Expression</span>
                <span className="settings-toggle-desc">5 fields: min hour dom month dow</span>
              </div>
              <input
                type="text"
                className="settings-input"
                value={editing.schedule.expression}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    schedule: { type: "cron", expression: e.target.value },
                  })
                }
                placeholder="0 9 * * *"
                spellCheck={false}
              />
            </div>
          )}

          {/* Telegram notify */}
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Notify via Telegram</span>
              <span className="settings-toggle-desc">Send result to Telegram when done</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={editing.notify_telegram}
                onChange={(e) => setEditing({ ...editing, notify_telegram: e.target.checked })}
              />
              <span className="toggle-switch-track" />
            </label>
          </div>

          {/* Save / Cancel */}
          <div className="scheduler-editor-footer">
            <button className="scheduler-btn scheduler-btn--secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              className="scheduler-btn scheduler-btn--primary"
              onClick={handleSave}
              disabled={!editing.name.trim() || !editing.prompt.trim() || !editing.project_path}
            >
              <Save size={14} />
              Save
            </button>
          </div>
        </div>
      )}

      {/* Add button */}
      {!editing && (
        <button className="scheduler-add-btn" onClick={handleAdd}>
          <Plus size={14} />
          Add task
        </button>
      )}
    </div>
  );
}
