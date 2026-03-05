import { memo } from "react";
import { Sparkles } from "lucide-react";
import { useSkillStore } from "../../../stores/skillStore";
import { DashboardCard } from "../DashboardCard";

export const SkillsCard = memo(function SkillsCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const globalCount = useSkillStore((s) => s.global.length);
  const projectCount = useSkillStore((s) => s.project.length);
  const pluginCount = useSkillStore((s) =>
    s.plugins.reduce((acc, p) => acc + p.skills.length, 0),
  );
  const total = globalCount + projectCount + pluginCount;

  return (
    <DashboardCard
      id="skills"
      icon={Sparkles}
      title="Skills"
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
        {pluginCount > 0 && (
          <div className="dash-card__row">
            <span className="dash-card__label">Plugins</span>
            <span>{pluginCount}</span>
          </div>
        )}
      </div>
    </DashboardCard>
  );
});
