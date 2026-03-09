import { memo, useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/transport";

interface DayStats {
  date: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  sessions: number;
}

interface ModelStats {
  model: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
}

interface ProjectStats {
  project: string;
  cost: number;
  sessions: number;
  output_tokens: number;
}

interface AggregatedStats {
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_sessions: number;
  by_day: DayStats[];
  by_model: ModelStats[];
  by_project: ProjectStats[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 1000) return `$${Math.round(n)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

/** Short model name: "claude-opus-4-6" → "Opus" */
function shortModel(model: string): string {
  if (model.includes("opus")) return "Opus";
  if (model.includes("haiku")) return "Haiku";
  if (model.includes("sonnet")) return "Sonnet";
  return model;
}

const PERIODS = [
  { label: "1d", days: 1 },
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "All", days: 9999 },
] as const;

export const CliStatsSection = memo(function CliStatsSection() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<AggregatedStats | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback((d: number) => {
    setDays(d);
    setLoading(true);
    invoke<AggregatedStats>("get_cli_stats", { days: d })
      .then(setStats)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(days);
  }, []); // eslint-disable-line

  if (!stats) {
    return <div className="cli-stats">{loading ? "Loading..." : "No data"}</div>;
  }

  return (
    <div className="cli-stats">
      {/* Period selector */}
      <div className="cli-stats__period">
        {PERIODS.map((p) => (
          <button
            key={p.days}
            className={`cli-stats__period-btn ${days === p.days ? "cli-stats__period-btn--active" : ""}`}
            onClick={() => load(p.days)}
            disabled={loading}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="cli-stats__summary">
        <div className="cli-stats__card">
          <span className="cli-stats__card-label">Total Cost</span>
          <span className="cli-stats__card-value">{formatCost(stats.total_cost)}</span>
        </div>
        <div className="cli-stats__card">
          <span className="cli-stats__card-label">Input Tokens</span>
          <span className="cli-stats__card-value">{formatTokens(stats.total_input_tokens)}</span>
        </div>
        <div className="cli-stats__card">
          <span className="cli-stats__card-label">Output Tokens</span>
          <span className="cli-stats__card-value">{formatTokens(stats.total_output_tokens)}</span>
        </div>
        <div className="cli-stats__card">
          <span className="cli-stats__card-label">Sessions</span>
          <span className="cli-stats__card-value">{stats.total_sessions}</span>
        </div>
      </div>

      {/* Cost per day chart */}
      {stats.by_day.length > 0 && (
        <div className="cli-stats__section">
          <h3 className="cli-stats__section-title">Cost per Day</h3>
          <CostChart data={stats.by_day} />
        </div>
      )}

      {/* By Model */}
      {stats.by_model.length > 0 && (
        <div className="cli-stats__section cli-stats__columns">
          <div className="cli-stats__col">
            <h3 className="cli-stats__section-title">By Model</h3>
            <BarList
              items={stats.by_model.map((m) => ({
                label: shortModel(m.model),
                value: m.cost,
                display: formatCost(m.cost),
              }))}
            />
          </div>

          {/* By Project */}
          <div className="cli-stats__col">
            <h3 className="cli-stats__section-title">By Project</h3>
            <BarList
              items={stats.by_project.slice(0, 10).map((p) => ({
                label: p.project,
                value: p.cost,
                display: formatCost(p.cost),
              }))}
            />
          </div>
        </div>
      )}
    </div>
  );
});

/** SVG area chart for cost per day */
const CostChart = memo(function CostChart({ data }: { data: DayStats[] }) {
  if (data.length === 0) return null;

  const W = 600;
  const H = 180;
  const PAD_LEFT = 55;
  const PAD_RIGHT = 10;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 30;
  const chartW = W - PAD_LEFT - PAD_RIGHT;
  const chartH = H - PAD_TOP - PAD_BOTTOM;

  const maxCost = Math.max(...data.map((d) => d.cost), 0.01);

  const x = (i: number) => PAD_LEFT + (i / Math.max(data.length - 1, 1)) * chartW;
  const y = (val: number) => PAD_TOP + chartH - (val / maxCost) * chartH;

  // Line path
  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.cost).toFixed(1)}`)
    .join(" ");

  // Area path
  const areaPath = `${linePath} L${x(data.length - 1).toFixed(1)},${(PAD_TOP + chartH).toFixed(1)} L${PAD_LEFT},${(PAD_TOP + chartH).toFixed(1)} Z`;

  // Y-axis labels (3 ticks)
  const yTicks = [0, maxCost / 2, maxCost];

  // X-axis labels (show ~5 dates)
  const step = Math.max(1, Math.floor(data.length / 5));
  const xLabels = data.filter((_, i) => i % step === 0 || i === data.length - 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cli-stats__chart">
      <defs>
        <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Y-axis labels */}
      {yTicks.map((tick) => (
        <g key={tick}>
          <line
            x1={PAD_LEFT}
            y1={y(tick)}
            x2={W - PAD_RIGHT}
            y2={y(tick)}
            stroke="var(--border)"
            strokeWidth="0.5"
            strokeDasharray="3,3"
          />
          <text
            x={PAD_LEFT - 6}
            y={y(tick) + 3}
            textAnchor="end"
            className="cli-stats__chart-label"
          >
            {formatCost(tick)}
          </text>
        </g>
      ))}

      {/* X-axis labels */}
      {xLabels.map((d) => {
        const i = data.indexOf(d);
        return (
          <text
            key={d.date}
            x={x(i)}
            y={H - 6}
            textAnchor="middle"
            className="cli-stats__chart-label"
          >
            {d.date.slice(5)}
          </text>
        );
      })}

      {/* Area fill */}
      <path d={areaPath} fill="url(#costGrad)" />

      {/* Line */}
      <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth="1.5" />

      {/* Dots */}
      {data.map((d, i) => (
        <circle
          key={d.date}
          cx={x(i)}
          cy={y(d.cost)}
          r="2.5"
          fill="var(--accent)"
        >
          <title>{`${d.date}: ${formatCost(d.cost)}`}</title>
        </circle>
      ))}
    </svg>
  );
});

/** Horizontal bar list */
const BarList = memo(function BarList({
  items,
}: {
  items: { label: string; value: number; display: string }[];
}) {
  const maxVal = Math.max(...items.map((i) => i.value), 0.01);

  return (
    <div className="cli-stats__bars">
      {items.map((item) => (
        <div key={item.label} className="cli-stats__bar-row">
          <span className="cli-stats__bar-label">{item.label}</span>
          <div className="cli-stats__bar-track">
            <div
              className="cli-stats__bar-fill"
              style={{ width: `${(item.value / maxVal) * 100}%` }}
            />
          </div>
          <span className="cli-stats__bar-value">{item.display}</span>
        </div>
      ))}
    </div>
  );
});
