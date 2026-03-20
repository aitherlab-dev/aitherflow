import { memo, useCallback, useEffect, useState } from "react";
import { Plus, Database } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { IndexProgress } from "./IndexProgress";
import { CreateBaseModal } from "./CreateBaseModal";
import { Tooltip } from "../shared/Tooltip";

export const BaseList = memo(function BaseList() {
  const { bases, selectedBaseId, loadBases, selectBase } = useKnowledgeStore(
    useShallow((s) => ({
      bases: s.bases,
      selectedBaseId: s.selectedBaseId,
      loadBases: s.loadBases,
      selectBase: s.selectBase,
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
          bases.map((base) => (
            <button
              key={base.id}
              className={`kb-list__item${base.id === selectedBaseId ? " kb-list__item--active" : ""}`}
              onClick={() => handleSelect(base.id)}
            >
              <div className="kb-list__item-info">
                <span className="kb-list__item-name">{base.name}</span>
                <span className="kb-list__item-meta">
                  {base.document_count} docs · {base.total_chunks} chunks
                </span>
              </div>
              <IndexProgress status={base.status} compact />
            </button>
          ))
        )}
      </div>

      <CreateBaseModal open={createModalOpen} onClose={() => setCreateModalOpen(false)} />
    </div>
  );
});
