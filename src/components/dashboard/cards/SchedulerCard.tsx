import { memo, useCallback, useEffect, useState } from "react";
import { Clock, Settings } from "lucide-react";
import { useLayoutStore } from "../../../stores/layoutStore";
import { invoke } from "../../../lib/transport";
import type { ScheduledTask } from "../../../types/scheduler";
import { DashboardCard } from "../DashboardCard";
import { Tooltip } from "../../shared/Tooltip";

export const SchedulerCard = memo(function SchedulerCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);

  useEffect(() => {
    if (expanded) {
      invoke<ScheduledTask[]>("scheduler_list_tasks")
        .then(setTasks)
        .catch(console.error);
    }
  }, [expanded]);

  const enabledCount = tasks.filter((t) => t.enabled).length;

  const handleOpenSettings = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useLayoutStore.getState().openSettings("scheduler");
  }, []);

  const settingsBtn = (
    <Tooltip text="Manage scheduled tasks">
      <button className="dash-card__action" onClick={handleOpenSettings}>
        <Settings size={12} />
      </button>
    </Tooltip>
  );

  return (
    <DashboardCard
      id="scheduler"
      icon={Clock}
      title="Scheduler"
      statusText={String(enabledCount)}
      statusColor={enabledCount > 0 ? "green" : "gray"}
      expanded={expanded}
      onToggle={onToggle}
      headerExtra={settingsBtn}
    >
      <div className="dash-card__details">
        {tasks.length > 0 ? (
          <>
            <div className="dash-card__row">
              <span className="dash-card__label">Tasks</span>
              <span>{enabledCount} enabled / {tasks.length} total</span>
            </div>
            {tasks.map((t) => (
              <div key={t.id} className="dash-card__row dash-card__row--sub">
                <span className="dash-card__label" style={{ opacity: t.enabled ? 1 : 0.5 }}>
                  {t.name}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    className={`scheduler-status-dot${t.last_status ? ` scheduler-status-dot--${t.last_status}` : ""}`}
                  />
                  <span style={{ fontSize: "0.78rem", color: "var(--fg-muted)" }}>
                    {formatSchedule(t.schedule)}
                  </span>
                </span>
              </div>
            ))}
          </>
        ) : (
          <div className="dash-card__row">
            <span className="dash-card__label">No scheduled tasks</span>
          </div>
        )}
      </div>
    </DashboardCard>
  );
});

function formatSchedule(s: ScheduledTask["schedule"]): string {
  switch (s.type) {
    case "interval":
      return `every ${s.minutes}m`;
    case "daily":
      return `daily ${pad(s.hour)}:${pad(s.minute)}`;
    case "weekly": {
      const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      return `${days[s.day] ?? "?"} ${pad(s.hour)}:${pad(s.minute)}`;
    }
    case "cron":
      return s.expression;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
