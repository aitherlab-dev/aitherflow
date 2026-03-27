import { useState, useEffect, useCallback, useMemo } from "react";
import { Plus, Play, Trash2, X, Save } from "lucide-react";
import { invoke, listen } from "../../lib/transport";
import { Tooltip } from "../shared/Tooltip";
import type { ScheduledTask, TaskSchedule } from "../../types/scheduler";
import type { ProjectBookmark } from "../../types/projects";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_SHORTS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ── Cron visual builder ──

interface CronParts {
  minuteMode: "every" | "step" | "at";
  minuteStep: number;
  minuteAt: number;
  hourMode: "every" | "at";
  hourAt: number;
  days: boolean[]; // 7 booleans, Mon=0..Sun=6
  domMode: "every" | "specific";
  domValue: string; // "1,15"
}

function defaultCronParts(): CronParts {
  return {
    minuteMode: "at", minuteStep: 5, minuteAt: 0,
    hourMode: "at", hourAt: 9,
    days: [true, true, true, true, true, true, true],
    domMode: "every", domValue: "1",
  };
}

function parseCronExpr(expr: string): CronParts | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minP, hourP, domP, , dowP] = parts;

  const result = defaultCronParts();

  // Minute
  if (minP === "*" || minP === "*/1") {
    result.minuteMode = "every"; result.minuteStep = 1;
  } else if (minP.startsWith("*/")) {
    result.minuteMode = "step"; result.minuteStep = Number(minP.slice(2)) || 5;
  } else {
    result.minuteMode = "at"; result.minuteAt = Number(minP) || 0;
  }

  // Hour
  if (hourP === "*") {
    result.hourMode = "every";
  } else {
    result.hourMode = "at"; result.hourAt = Number(hourP) || 0;
  }

  // Day of month
  if (domP === "*") {
    result.domMode = "every";
  } else {
    result.domMode = "specific"; result.domValue = domP;
  }

  // Day of week
  if (dowP === "*") {
    result.days = [true, true, true, true, true, true, true];
  } else {
    result.days = [false, false, false, false, false, false, false];
    // Handle ranges (1-5) and lists (1,3,5) — cron: 0=Sun,1=Mon..6=Sat
    const cronToIdx = (n: number) => (n === 0 ? 6 : n - 1); // cron Sun=0 → idx 6
    for (const part of dowP.split(",")) {
      const range = part.split("-");
      if (range.length === 2) {
        const from = Number(range[0]); const to = Number(range[1]);
        for (let i = from; i <= to; i++) result.days[cronToIdx(i)] = true;
      } else {
        const n = Number(part);
        if (!isNaN(n)) result.days[cronToIdx(n)] = true;
      }
    }
  }

  return result;
}

function buildCronExpr(p: CronParts): string {
  let min: string;
  if (p.minuteMode === "every") min = "*";
  else if (p.minuteMode === "step") min = `*/${p.minuteStep}`;
  else min = String(p.minuteAt);

  const hour = p.hourMode === "every" ? "*" : String(p.hourAt);

  const dom = p.domMode === "every" ? "*" : (p.domValue.trim() || "*");

  const month = "*";

  let dow: string;
  const allOn = p.days.every(Boolean);
  const noneOn = p.days.every((d) => !d);
  if (allOn || noneOn) {
    dow = "*";
  } else {
    // Convert to cron format: 1=Mon..6=Sat, 0=Sun
    const idxToCron = (i: number) => (i === 6 ? 0 : i + 1);
    const selected = p.days
      .map((on, i) => (on ? idxToCron(i) : -1))
      .filter((n) => n >= 0)
      .sort((a, b) => a - b);
    dow = selected.join(",");
  }

  return `${min} ${hour} ${dom} ${month} ${dow}`;
}

function CronBuilder({ expression, onChange }: { expression: string; onChange: (expr: string) => void }) {
  const parsed = useMemo(() => parseCronExpr(expression), [expression]);
  const [parts, setParts] = useState<CronParts>(() => parsed ?? defaultCronParts());
  const [rawMode, setRawMode] = useState(parsed === null && expression !== "0 9 * * *");

  const update = useCallback(
    (patch: Partial<CronParts>) => {
      setParts((prev) => {
        const next = { ...prev, ...patch };
        onChange(buildCronExpr(next));
        return next;
      });
    },
    [onChange],
  );

  if (rawMode) {
    return (
      <div className="cron-builder">
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Expression</span>
            <span className="settings-toggle-desc">5 fields: min hour dom month dow</span>
          </div>
          <input
            type="text"
            className="settings-input"
            value={expression}
            onChange={(e) => onChange(e.target.value)}
            placeholder="0 9 * * *"
            spellCheck={false}
          />
        </div>
        <button className="cron-toggle-mode" onClick={() => { setRawMode(false); setParts(parseCronExpr(expression) ?? defaultCronParts()); }}>
          Switch to visual builder
        </button>
      </div>
    );
  }

  return (
    <div className="cron-builder">
      {/* Minute */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Minute</span>
        </div>
        <div className="cron-field-group">
          <select
            className="settings-select"
            value={parts.minuteMode === "step" ? `step-${parts.minuteStep}` : parts.minuteMode}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "every") update({ minuteMode: "every" });
              else if (v === "at") update({ minuteMode: "at" });
              else if (v.startsWith("step-")) update({ minuteMode: "step", minuteStep: Number(v.slice(5)) });
            }}
          >
            <option value="every">Every minute</option>
            <option value="step-5">Every 5 minutes</option>
            <option value="step-10">Every 10 minutes</option>
            <option value="step-15">Every 15 minutes</option>
            <option value="step-30">Every 30 minutes</option>
            <option value="at">At minute...</option>
          </select>
          {parts.minuteMode === "at" && (
            <input
              type="number"
              className="settings-input scheduler-num-input"
              min={0} max={59}
              value={parts.minuteAt}
              onChange={(e) => update({ minuteAt: Math.max(0, Math.min(59, Number(e.target.value))) })}
            />
          )}
        </div>
      </div>

      {/* Hour */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Hour</span>
        </div>
        <div className="cron-field-group">
          <select
            className="settings-select"
            value={parts.hourMode}
            onChange={(e) => update({ hourMode: e.target.value as "every" | "at" })}
          >
            <option value="every">Every hour</option>
            <option value="at">At hour...</option>
          </select>
          {parts.hourMode === "at" && (
            <input
              type="number"
              className="settings-input scheduler-num-input"
              min={0} max={23}
              value={parts.hourAt}
              onChange={(e) => update({ hourAt: Math.max(0, Math.min(23, Number(e.target.value))) })}
            />
          )}
        </div>
      </div>

      {/* Day of week */}
      <div className="settings-toggle-row" style={{ alignItems: "flex-start" }}>
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Days of week</span>
        </div>
        <div className="cron-days-row">
          {DAY_SHORTS.map((d, i) => (
            <button
              key={d}
              type="button"
              className={`cron-day-btn${parts.days[i] ? " cron-day-btn--active" : ""}`}
              onClick={() => {
                const next = [...parts.days];
                next[i] = !next[i];
                update({ days: next });
              }}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Day of month */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Day of month</span>
        </div>
        <div className="cron-field-group">
          <select
            className="settings-select"
            value={parts.domMode}
            onChange={(e) => update({ domMode: e.target.value as "every" | "specific" })}
          >
            <option value="every">Every day</option>
            <option value="specific">On days...</option>
          </select>
          {parts.domMode === "specific" && (
            <input
              type="text"
              className="settings-input scheduler-num-input"
              value={parts.domValue}
              onChange={(e) => update({ domValue: e.target.value })}
              placeholder="1,15"
              spellCheck={false}
              style={{ width: 80 }}
            />
          )}
        </div>
      </div>

      {/* Preview */}
      <div className="cron-preview">
        {buildCronExpr(parts)}
      </div>

      <button className="cron-toggle-mode" onClick={() => setRawMode(true)}>
        Edit as text
      </button>
    </div>
  );
}

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

  // Reload tasks when a scheduled task starts (auto or manual)
  useEffect(() => {
    const unlisten = listen("scheduler:task-started", () => loadTasks());
    return () => { unlisten.then((fn) => fn()).catch(console.error); };
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
              <option value="cron">Advanced</option>
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
            <CronBuilder
              expression={editing.schedule.expression}
              onChange={(expr) =>
                setEditing({ ...editing, schedule: { type: "cron", expression: expr } })
              }
            />
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
