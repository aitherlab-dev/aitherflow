import { memo, useCallback, useEffect, useState } from "react";
import { Send } from "lucide-react";
import { invoke } from "../../../lib/transport";
import { DashboardCard } from "../DashboardCard";

interface TelegramStatus {
  running: boolean;
  connected: boolean;
  error: string | null;
  bot_username: string | null;
}

export const TelegramCard = memo(function TelegramCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [toggling, setToggling] = useState(false);

  const refresh = useCallback(() => {
    invoke<TelegramStatus>("get_telegram_status")
      .then(setStatus)
      .catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const running = status?.running && status?.connected;
  const statusText = !status
    ? "..."
    : running
      ? status.bot_username ?? "Online"
      : "Off";

  const handleToggle = useCallback(() => {
    setToggling(true);
    const cmd = running ? "stop_telegram_bot" : "start_telegram_bot";
    invoke(cmd)
      .then(() => refresh())
      .catch(console.error)
      .finally(() => setToggling(false));
  }, [running, refresh]);

  return (
    <DashboardCard
      id="telegram"
      icon={Send}
      title="Telegram"
      statusText={statusText}
      statusColor={!status ? "gray" : running ? "green" : "gray"}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div className="dash-card__details">
        <div className="dash-card__row">
          <span className="dash-card__label">Status</span>
          <button
            className={`dash-card__toggle ${running ? "dash-card__toggle--on" : ""}`}
            onClick={handleToggle}
            disabled={toggling}
          >
            <span className="dash-card__toggle-knob" />
          </button>
        </div>
        {status?.bot_username && (
          <div className="dash-card__row">
            <span className="dash-card__label">Bot</span>
            <span>@{status.bot_username}</span>
          </div>
        )}
        {status?.error && (
          <div className="dash-card__row dash-card__row--error">
            <span>{status.error}</span>
          </div>
        )}
      </div>
    </DashboardCard>
  );
});
