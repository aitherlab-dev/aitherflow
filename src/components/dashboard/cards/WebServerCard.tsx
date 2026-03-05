import { memo, useCallback, useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { invoke } from "../../../lib/transport";
import { DashboardCard } from "../DashboardCard";

interface WebConfig {
  enabled: boolean;
  port: number;
  remote_access: boolean;
}

export const WebServerCard = memo(function WebServerCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const [running, setRunning] = useState<boolean | null>(null);
  const [config, setConfig] = useState<WebConfig | null>(null);
  const [toggling, setToggling] = useState(false);

  const refresh = useCallback(() => {
    invoke<boolean>("web_server_status").then(setRunning).catch(console.error);
    invoke<WebConfig>("load_web_config").then(setConfig).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const statusText =
    running === null ? "..." : running ? `Port ${config?.port ?? "?"}` : "Off";

  const handleToggle = useCallback(() => {
    setToggling(true);
    const cmd = running ? "stop_web_server" : "start_web_server";
    invoke(cmd)
      .then(() => refresh())
      .catch(console.error)
      .finally(() => setToggling(false));
  }, [running, refresh]);

  return (
    <DashboardCard
      id="webserver"
      icon={Globe}
      title="Web"
      statusText={statusText}
      statusColor={running === null ? "gray" : running ? "green" : "gray"}
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
        {config && (
          <>
            <div className="dash-card__row">
              <span className="dash-card__label">Port</span>
              <span>{config.port}</span>
            </div>
            <div className="dash-card__row">
              <span className="dash-card__label">Remote</span>
              <span>{config.remote_access ? "Yes" : "No"}</span>
            </div>
          </>
        )}
      </div>
    </DashboardCard>
  );
});
