import { memo, useState, useEffect } from "react";
import { Coins } from "lucide-react";
import { useConductorStore } from "../../../stores/conductorStore";
import { invoke } from "../../../lib/transport";
import { DashboardCard } from "../DashboardCard";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

interface OpenRouterBalance {
  totalCredits: number | null;
  totalUsage: number;
  remaining: number | null;
}

const COLOR_INACTIVE = "var(--fg-dim)";

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

  const [orBalance, setOrBalance] = useState<OpenRouterBalance | null>(null);

  useEffect(() => {
    const fetchBalance = () => {
      invoke<OpenRouterBalance>("external_models_openrouter_balance")
        .then(setOrBalance)
        .catch(console.error);
    };
    fetchBalance();
    const timer = setInterval(fetchBalance, 30_000);
    return () => clearInterval(timer);
  }, []);

  const pct = contextMax > 0 ? (contextUsed / contextMax) * 100 : 0;
  const cacheTotal = cacheRead + cacheCreation;
  const cacheHitRate = cacheTotal > 0 ? Math.round((cacheRead / cacheTotal) * 100) : 0;

  const statusText = contextMax > 0
    ? `${formatTokens(contextUsed)} / ${formatTokens(contextMax)}`
    : "—";

  const barColor = contextUsed > 0 && contextMax > 0
    ? "var(--accent)"
    : COLOR_INACTIVE;

  return (
    <DashboardCard
      id="tokens"
      icon={Coins}
      title="Tokens"
      statusText={statusText}
      statusColor={undefined}
      statusTextStyle={undefined}
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
          <span>
            {contextMax > 0
              ? <>{formatTokens(contextUsed)} / {formatTokens(contextMax)}{" "}
                  <span style={{ color: "var(--fg-muted)" }}>({Math.round(pct)}%)</span></>
              : "—"}
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
        {orBalance && (
          <>
            <div className="dash-card__row" style={{ marginTop: "4px", borderTop: "1px solid var(--border)", paddingTop: "4px" }}>
              <span className="dash-card__label">OpenRouter</span>
              <span>${orBalance.totalUsage.toFixed(2)} spent</span>
            </div>
            {orBalance.remaining != null && (
              <div className="dash-card__row">
                <span className="dash-card__label">Balance</span>
                <span>${orBalance.remaining.toFixed(2)}</span>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardCard>
  );
});
