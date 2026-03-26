import { memo, useCallback } from "react";
import { Cable, Circle, Settings } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useMcpStore } from "../../../stores/mcpStore";
import { useLayoutStore } from "../../../stores/layoutStore";
import { DashboardCard } from "../DashboardCard";
import { Tooltip } from "../../shared/Tooltip";

export const McpCard = memo(function McpCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const globalServers = useMcpStore(useShallow((s) => s.global.map((m) => m.name)));
  const projectServers = useMcpStore(useShallow((s) => s.project.map((m) => m.name)));
  const builtin = useMcpStore(useShallow((s) => s.builtin));
  const builtinRunning = builtin.filter((b) => b.running).length;
  const total = builtinRunning + globalServers.length + projectServers.length;

  const handleOpenSettings = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useLayoutStore.getState().openSettings("mcp");
  }, []);

  const settingsBtn = (
    <Tooltip text="MCP settings">
      <button className="dash-card__action" onClick={handleOpenSettings}>
        <Settings size={12} />
      </button>
    </Tooltip>
  );

  return (
    <DashboardCard
      id="mcp"
      icon={Cable}
      title="MCP"
      statusText={String(total)}
      statusColor={total > 0 ? "green" : "gray"}
      expanded={expanded}
      onToggle={onToggle}
      headerExtra={settingsBtn}
    >
      <div className="dash-card__details">
        {builtin.length > 0 && (
          <>
            <div className="dash-card__row">
              <span className="dash-card__label">Built-in</span>
              <span>{builtinRunning}/{builtin.length}</span>
            </div>
            {builtin.map((b) => (
              <div key={b.name} className="dash-card__row dash-card__row--sub">
                <Circle
                  size={8}
                  fill={b.running ? "var(--status-green)" : "var(--status-red)"}
                  stroke="none"
                />
                <span className="dash-card__label">{b.name}</span>
              </div>
            ))}
          </>
        )}
        {globalServers.length > 0 && (
          <>
            <div className="dash-card__row">
              <span className="dash-card__label">Global</span>
              <span>{globalServers.length}</span>
            </div>
            {globalServers.map((name) => (
              <div key={name} className="dash-card__row dash-card__row--sub">
                <Circle
                  size={8}
                  fill="var(--status-green)"
                  stroke="none"
                />
                <span className="dash-card__label">{name}</span>
              </div>
            ))}
          </>
        )}
        {projectServers.length > 0 && (
          <>
            <div className="dash-card__row">
              <span className="dash-card__label">Project</span>
              <span>{projectServers.length}</span>
            </div>
            {projectServers.map((name) => (
              <div key={name} className="dash-card__row dash-card__row--sub">
                <Circle
                  size={8}
                  fill="var(--status-green)"
                  stroke="none"
                />
                <span className="dash-card__label">{name}</span>
              </div>
            ))}
          </>
        )}
        {total === 0 && (
          <div className="dash-card__row">
            <span className="dash-card__label">No servers configured</span>
          </div>
        )}
      </div>
    </DashboardCard>
  );
});
