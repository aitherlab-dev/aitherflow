import { memo } from "react";
import { Activity } from "lucide-react";
import { useChatStore } from "../../../stores/chatStore";
import { DashboardCard } from "../DashboardCard";

export const AgentModeCard = memo(function AgentModeCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const planMode = useChatStore((s) => s.planMode);
  const hasSession = useChatStore((s) => s.hasSession);

  const label = !hasSession ? "Idle" : planMode ? "Plan" : "Edit";
  const color = !hasSession ? "dim" : planMode ? "blue" : "green";

  return (
    <DashboardCard
      id="agentmode"
      icon={Activity}
      title="Mode"
      statusText={label}
      statusColor={color}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div className="dash-card__details">
        <div className="dash-card__row">
          <span className="dash-card__label">Mode</span>
          <span>{label}</span>
        </div>
      </div>
    </DashboardCard>
  );
});
