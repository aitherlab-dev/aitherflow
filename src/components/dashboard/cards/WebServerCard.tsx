import { memo, useCallback, useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { useWebServerStore } from "../../../stores/webServerStore";
import { DashboardCard } from "../DashboardCard";

export const WebServerCard = memo(function WebServerCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { running, config, loaded, refresh, start, stop } = useWebServerStore();
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const statusText = !loaded ? "..." : running ? `Port ${config.port}` : "Off";

  const handleToggle = useCallback(async () => {
    setToggling(true);
    try {
      if (running) {
        await stop();
      } else {
        await start();
      }
    } catch (e) {
      console.error(e);
    }
    setToggling(false);
  }, [running, start, stop]);

  return (
    <DashboardCard
      id="webserver"
      icon={Globe}
      title="Web"
      statusText={statusText}
      statusColor={!loaded ? "gray" : running ? "green" : "gray"}
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
        {loaded && (
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
