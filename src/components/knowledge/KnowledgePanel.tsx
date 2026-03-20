import { memo, useCallback, useEffect } from "react";
import { Link, Unlink, Database } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { Tooltip } from "../shared/Tooltip";

export const KnowledgePanel = memo(function KnowledgePanel() {
  const { bases, attachedBaseIds, loadBases, toggleAttachBase } = useKnowledgeStore(
    useShallow((s) => ({
      bases: s.bases,
      attachedBaseIds: s.attachedBaseIds,
      loadBases: s.loadBases,
      toggleAttachBase: s.toggleAttachBase,
    })),
  );

  useEffect(() => {
    loadBases().catch(console.error);
  }, [loadBases]);

  const handleToggle = useCallback(
    (e: React.MouseEvent, baseId: string) => {
      e.stopPropagation();
      toggleAttachBase(baseId);
    },
    [toggleAttachBase],
  );

  if (bases.length === 0) {
    return (
      <div className="kb-sidebar-empty">
        <Database size={16} />
        <span>No knowledge bases</span>
      </div>
    );
  }

  return (
    <div className="kb-sidebar-list">
      {bases.map((base) => {
        const isAttached = attachedBaseIds.includes(base.id);
        return (
          <div
            key={base.id}
            className={`kb-sidebar-item${isAttached ? " kb-sidebar-item--attached" : ""}`}
          >
            <span className="kb-sidebar-item__name">{base.name}</span>
            <Tooltip text={isAttached ? "Detach from chat" : "Attach to chat"}>
              <button
                className={`kb-sidebar-item__toggle${isAttached ? " kb-sidebar-item__toggle--active" : ""}`}
                onClick={(e) => handleToggle(e, base.id)}
              >
                {isAttached ? <Link size={12} /> : <Unlink size={12} />}
              </button>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
});
