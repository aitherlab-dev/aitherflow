import { memo, useCallback, useEffect } from "react";
import { BookOpen, Settings } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useKnowledgeStore } from "../../../stores/knowledgeStore";
import { useLayoutStore } from "../../../stores/layoutStore";
import { DashboardCard } from "../DashboardCard";
import { Tooltip } from "../../shared/Tooltip";

export const KnowledgeCard = memo(function KnowledgeCard({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { bases, loadBases } = useKnowledgeStore(
    useShallow((s) => ({ bases: s.bases, loadBases: s.loadBases })),
  );

  useEffect(() => {
    if (expanded) {
      loadBases().catch(console.error);
    }
  }, [expanded, loadBases]);

  const totalDocs = bases.reduce((sum, b) => sum + b.documentCount, 0);

  const handleOpenSettings = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    useLayoutStore.getState().openSettings("knowledge");
  }, []);

  const settingsBtn = (
    <Tooltip text="Manage knowledge bases">
      <button className="dash-card__action" onClick={handleOpenSettings}>
        <Settings size={12} />
      </button>
    </Tooltip>
  );

  return (
    <DashboardCard
      id="knowledge"
      icon={BookOpen}
      title="Knowledge"
      statusText={String(bases.length)}
      statusColor={bases.length > 0 ? "green" : "gray"}
      expanded={expanded}
      onToggle={onToggle}
      headerExtra={settingsBtn}
    >
      <div className="dash-card__details">
        {bases.length > 0 ? (
          <>
            <div className="dash-card__row">
              <span className="dash-card__label">Total</span>
              <span>{bases.length} bases · {totalDocs} docs</span>
            </div>
            {bases.map((b) => (
              <div key={b.id} className="dash-card__row dash-card__row--sub">
                <span className="dash-card__label">{b.name}</span>
                <span>{b.documentCount} docs</span>
              </div>
            ))}
          </>
        ) : (
          <div className="dash-card__row">
            <span className="dash-card__label">No knowledge bases</span>
          </div>
        )}
      </div>
    </DashboardCard>
  );
});
