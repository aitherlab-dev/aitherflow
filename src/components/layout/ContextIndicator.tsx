import { memo } from "react";
import { useConductorStore } from "../../stores/conductorStore";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function getContextColor(pct: number): string {
  if (pct >= 80) return "var(--red)";
  if (pct >= 50) return "var(--yellow)";
  return "var(--green)";
}

export const ContextIndicator = memo(function ContextIndicator() {
  const contextUsed = useConductorStore((s) => s.contextUsed);
  const contextMax = useConductorStore((s) => s.contextMax);

  if (contextUsed === 0) return null;

  const pct = Math.min(100, Math.round((contextUsed / contextMax) * 100));
  const color = getContextColor(pct);

  return (
    <div className="context-indicator" title={`Context: ${formatTokens(contextUsed)} / ${formatTokens(contextMax)} (${pct}%)`}>
      <span className="context-indicator__text">
        {formatTokens(contextUsed)} / {formatTokens(contextMax)}
      </span>
      <div className="context-bar">
        <div
          className="context-bar__fill"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <span className="context-indicator__pct" style={{ color }}>
        {pct}%
      </span>
    </div>
  );
});
