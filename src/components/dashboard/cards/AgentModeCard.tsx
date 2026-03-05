import { memo, useEffect, useState } from "react";
import { Shield } from "lucide-react";
import { invoke } from "../../../lib/transport";
import { DashboardCard } from "../DashboardCard";

interface AppSettings {
  bypassPermissions: boolean;
}

const MODE_LABELS: Record<string, string> = {
  default: "Default",
  bypassPermissions: "Bypass",
};

export const AgentModeCard = memo(function AgentModeCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const [bypass, setBypass] = useState(false);

  useEffect(() => {
    invoke<AppSettings>("load_settings")
      .then((s) => setBypass(s.bypassPermissions))
      .catch(console.error);
  }, []);

  const mode = bypass ? "bypassPermissions" : "default";
  const label = MODE_LABELS[mode];

  return (
    <DashboardCard
      id="agentmode"
      icon={Shield}
      title="Perms"
      statusText={label}
      statusColor={bypass ? "orange" : "green"}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div className="dash-card__details">
        <div className="dash-card__row">
          <span className="dash-card__label">Mode</span>
          <span>{label}</span>
        </div>
        <div className="dash-card__row">
          <span className="dash-card__label">Bypass</span>
          <span>{bypass ? "Yes" : "No"}</span>
        </div>
      </div>
    </DashboardCard>
  );
});
