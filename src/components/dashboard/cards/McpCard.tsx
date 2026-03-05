import { memo } from "react";
import { Cable } from "lucide-react";
import { useMcpStore } from "../../../stores/mcpStore";
import { DashboardCard } from "../DashboardCard";

export const McpCard = memo(function McpCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const globalCount = useMcpStore((s) => s.global.length);
  const projectCount = useMcpStore((s) => s.project.length);
  const total = globalCount + projectCount;

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
        <div className="dash-card__row">
          <span className="dash-card__label">Global</span>
          <span>{globalCount}</span>
        </div>
        <div className="dash-card__row">
          <span className="dash-card__label">Project</span>
          <span>{projectCount}</span>
        </div>
      </div>
    </DashboardCard>
  );
});
