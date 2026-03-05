import { memo } from "react";
import { Coins } from "lucide-react";
import { useConductorStore } from "../../../stores/conductorStore";
import { DashboardCard } from "../DashboardCard";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export const TokensCard = memo(function TokensCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const inputTokens = useConductorStore((s) => s.inputTokens);
  const outputTokens = useConductorStore((s) => s.outputTokens);
  const costUsd = useConductorStore((s) => s.costUsd);

  const statusText = costUsd > 0 ? `$${costUsd.toFixed(2)}` : "$0";

  return (
    <DashboardCard
      id="tokens"
      icon={Coins}
      title="Tokens"
      statusText={statusText}
      statusColor={costUsd > 0 ? "orange" : "gray"}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div className="dash-card__details">
        <div className="dash-card__row">
          <span className="dash-card__label">Input</span>
          <span>{formatTokens(inputTokens)}</span>
        </div>
        <div className="dash-card__row">
          <span className="dash-card__label">Output</span>
          <span>{formatTokens(outputTokens)}</span>
        </div>
        <div className="dash-card__row">
          <span className="dash-card__label">Cost</span>
          <span>${costUsd.toFixed(4)}</span>
        </div>
      </div>
    </DashboardCard>
  );
});
