import { memo } from "react";
import { Coins } from "lucide-react";
import { useConductorStore } from "../../../stores/conductorStore";
import { DashboardCard } from "../DashboardCard";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

const USAGE_COLORS = {
  green: "#4ade80",
  orange: "#f59e0b",
  red: "#f87171",
  gray: "#888",
} as const;

function getUsageLevel(pct: number): "green" | "orange" | "red" | "gray" {
  if (pct >= 80) return "red";
  if (pct >= 50) return "orange";
  return "green";
}

export const TokensCard = memo(function TokensCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const contextUsed = useConductorStore((s) => s.contextUsed);
  const contextMax = useConductorStore((s) => s.contextMax);
  const outputTokens = useConductorStore((s) => s.outputTokens);
  const cacheRead = useConductorStore((s) => s.cacheReadTokens);
  const cacheCreation = useConductorStore((s) => s.cacheCreationTokens);
  const costUsd = useConductorStore((s) => s.costUsd);

  const pct = contextMax > 0 ? (contextUsed / contextMax) * 100 : 0;
  const cacheTotal = cacheRead + cacheCreation;
  const cacheHitRate = cacheTotal > 0 ? Math.round((cacheRead / cacheTotal) * 100) : 0;

  const statusText = contextUsed > 0
    ? `${formatTokens(contextUsed)} / ${formatTokens(contextMax)}`
    : "—";

  const usageLevel = contextUsed > 0 ? getUsageLevel(pct) : "gray";
  const barColor = USAGE_COLORS[usageLevel];

  return (
    <DashboardCard
      id="tokens"
      icon={Coins}
      title="Tokens"
      statusText={statusText}
      statusColor={usageLevel}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div className="dash-card__details">
        {/* Context usage bar */}
        <div className="dash-card__bar-wrap">
          <div
            className="dash-card__bar-fill"
            style={{
              width: `${Math.min(pct, 100)}%`,
              backgroundColor: barColor,
            }}
          />
        </div>
        <div className="dash-card__row">
          <span className="dash-card__label">Context</span>
          <span>{formatTokens(contextUsed)} / {formatTokens(contextMax)}{" "}
            <span style={{ color: "var(--fg-muted)" }}>({Math.round(pct)}%)</span>
          </span>
        </div>
        <div className="dash-card__row">
          <span className="dash-card__label">Output</span>
          <span>{formatTokens(outputTokens)}</span>
        </div>
        {cacheTotal > 0 && (
          <div className="dash-card__row">
            <span className="dash-card__label">Cache Hit</span>
            <span>{cacheHitRate}%</span>
          </div>
        )}
        {costUsd > 0 && (
          <div className="dash-card__row">
            <span className="dash-card__label">Cost</span>
            <span>${costUsd.toFixed(2)}</span>
          </div>
        )}
      </div>
    </DashboardCard>
  );
});
