export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  project_path: string;
  schedule: TaskSchedule;
  enabled: boolean;
  notify_telegram: boolean;
  created_at: string;
  last_run: string | null;
  last_status: "success" | "error" | "running" | null;
}

export type TaskSchedule =
  | { type: "interval"; minutes: number }
  | { type: "daily"; hour: number; minute: number }
  | { type: "weekly"; day: number; hour: number; minute: number }
  | { type: "cron"; expression: string };
