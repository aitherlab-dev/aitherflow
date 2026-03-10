import { memo, type CSSProperties, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export interface DashboardCardProps {
  id: string;
  icon: LucideIcon;
  title: string;
  /** Short status text shown in compact mode */
  statusText: string;
  /** Status dot color */
  statusColor?: "green" | "red" | "gray" | "orange" | "blue" | "dim";
  /** Inline style for status text */
  statusTextStyle?: CSSProperties;
  expanded: boolean;
  onToggle: (id: string) => void;
  /** Extra element in header (e.g. settings button) */
  headerExtra?: ReactNode;
  /** Expanded content */
  children?: ReactNode;
}

export const DashboardCard = memo(function DashboardCard({
  id,
  icon: Icon,
  title,
  statusText,
  statusColor,
  statusTextStyle,
  expanded,
  onToggle,
  headerExtra,
  children,
}: DashboardCardProps) {
  return (
    <div
      className={`dash-card ${expanded ? "dash-card--expanded" : ""}`}
      onClick={(e) => { if (!e.shiftKey) onToggle(id); }}
    >
      <div className="dash-card__header">
        <Icon size={14} className="dash-card__icon" />
        <span className="dash-card__title">{title}</span>
        <span className="dash-card__status">
          {statusColor && <span className={`dash-card__dot dash-card__dot--${statusColor}`} />}
          <span className="dash-card__status-text" style={statusTextStyle}>{statusText}</span>
        </span>
        {headerExtra}
      </div>
      {children && (
        <div className={`dash-card__collapse ${expanded ? "dash-card__collapse--open" : ""}`}>
          <div className="dash-card__body" onClick={(e) => e.stopPropagation()}>
            {children}
          </div>
        </div>
      )}
    </div>
  );
});
