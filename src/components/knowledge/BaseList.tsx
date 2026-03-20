import { memo, useCallback, useEffect, useState } from "react";
import { Plus, Database, Link, Unlink } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { CreateBaseModal } from "./CreateBaseModal";
import { Tooltip } from "../shared/Tooltip";

export const BaseList = memo(function BaseList() {
  const { bases, selectedBaseId, attachedBaseIds, loadBases, selectBase, toggleAttachBase } = useKnowledgeStore(
    useShallow((s) => ({
      bases: s.bases,
      selectedBaseId: s.selectedBaseId,
      attachedBaseIds: s.attachedBaseIds,
      loadBases: s.loadBases,
      selectBase: s.selectBase,
      toggleAttachBase: s.toggleAttachBase,
    })),
  );

  const [createModalOpen, setCreateModalOpen] = useState(false);

  useEffect(() => {
    loadBases().catch(console.error);
  }, [loadBases]);

  const handleSelect = useCallback(
    (baseId: string) => {
      selectBase(baseId === selectedBaseId ? null : baseId);
    },
    [selectedBaseId, selectBase],
  );

  const handleToggleAttach = useCallback(
    (e: React.MouseEvent, baseId: string) => {
      e.stopPropagation();
      toggleAttachBase(baseId);
    },
    [toggleAttachBase],
  );

  return (
    <div className="kb-list">
      <div className="kb-list__header">
        <h3 className="kb-list__title">Knowledge Bases</h3>
        <Tooltip text="Create new base">
          <button className="kb-list__add-btn" onClick={() => setCreateModalOpen(true)}>
            <Plus size={16} />
          </button>
        </Tooltip>
      </div>

      <div className="kb-list__items">
        {bases.length === 0 ? (
          <div className="kb-empty">
            <Database size={24} className="kb-empty__icon" />
            <p>No knowledge bases yet</p>
          </div>
        ) : (
          bases.map((base) => {
            const isAttached = attachedBaseIds.includes(base.id);
            return (
              <button
                key={base.id}
                className={`kb-list__item${base.id === selectedBaseId ? " kb-list__item--active" : ""}${isAttached ? " kb-list__item--attached" : ""}`}
                onClick={() => handleSelect(base.id)}
              >
                <div className="kb-list__item-info">
                  <span className="kb-list__item-name">{base.name}</span>
                  <span className="kb-list__item-meta">
                    {base.documentCount} docs{isAttached ? " · attached" : ""}
                  </span>
                </div>
                <Tooltip text={isAttached ? "Detach from chat" : "Attach to chat"}>
                  <span
                    className={`kb-list__attach${isAttached ? " kb-list__attach--active" : ""}`}
                    onClick={(e) => handleToggleAttach(e, base.id)}
                  >
                    {isAttached ? <Link size={14} /> : <Unlink size={14} />}
                  </span>
                </Tooltip>
              </button>
            );
          })
        )}
      </div>

      <CreateBaseModal open={createModalOpen} onClose={() => setCreateModalOpen(false)} />
    </div>
  );
});
