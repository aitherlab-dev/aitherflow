import { memo } from "react";
import { Cable } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useMcpStore } from "../../../stores/mcpStore";
import { DashboardCard } from "../DashboardCard";

export const McpCard = memo(function McpCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const globalServers = useMcpStore(useShallow((s) => s.global.map((m) => m.name)));
  const projectServers = useMcpStore(useShallow((s) => s.project.map((m) => m.name)));
  const total = globalServers.length + projectServers.length;

  return (
    <DashboardCard
      id="mcp"
      icon={Cable}
      title="MCP"
      statusText={String(total)}
      statusColor={total > 0 ? "green" : "gray"}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div className="dash-card__details">
        {globalServers.length > 0 && (
          <>
            <div className="dash-card__row">
              <span className="dash-card__label">Global</span>
              <span>{globalServers.length}</span>
            </div>
            {globalServers.map((name) => (
              <div key={name} className="dash-card__row dash-card__row--sub">
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
