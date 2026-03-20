import { memo, useCallback, useMemo, useState } from "react";
import { Plus, Trash2, Database } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { DocumentList } from "./DocumentList";
import { SearchPanel } from "./SearchPanel";
import { AddDocumentModal } from "./AddDocumentModal";
import { Modal } from "../Modal";
import { Tooltip } from "../shared/Tooltip";

export const BaseDetail = memo(function BaseDetail() {
  const { bases, selectedBaseId, deleteBase } = useKnowledgeStore(
    useShallow((s) => ({
      bases: s.bases,
      selectedBaseId: s.selectedBaseId,
      deleteBase: s.deleteBase,
    })),
  );

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const base = useMemo(
    () => bases.find((b) => b.id === selectedBaseId) ?? null,
    [bases, selectedBaseId],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (base) {
      deleteBase(base.id).catch(console.error);
      setDeleteConfirmOpen(false);
    }
  }, [base, deleteBase]);

  if (!base) {
    return (
      <div className="kb-detail-empty">
        <Database size={48} className="kb-detail-empty__icon" />
        <p>Select a knowledge base to view details</p>
      </div>
    );
  }

  return (
    <div className="kb-detail">
      <div className="kb-detail__header">
        <div className="kb-detail__title-row">
          <h2 className="kb-detail__title">{base.name}</h2>
        </div>
        {base.description && <p className="kb-detail__desc">{base.description}</p>}
        <div className="kb-detail__stats">
          <span>{base.documentCount} documents</span>
        </div>
        <div className="kb-detail__actions">
          <Tooltip text="Add documents">
            <button className="kb-btn kb-btn--accent" onClick={() => setAddModalOpen(true)}>
              <Plus size={14} />
              <span>Add Documents</span>
            </button>
          </Tooltip>
          <Tooltip text="Delete knowledge base">
            <button className="kb-btn kb-btn--danger" onClick={() => setDeleteConfirmOpen(true)}>
              <Trash2 size={14} />
              <span>Delete</span>
            </button>
          </Tooltip>
        </div>
      </div>

      <SearchPanel baseId={base.id} />
      <DocumentList baseId={base.id} />

      <AddDocumentModal open={addModalOpen} baseId={base.id} onClose={() => setAddModalOpen(false)} />

      <Modal
        open={deleteConfirmOpen}
        title="Delete Knowledge Base"
        onClose={() => setDeleteConfirmOpen(false)}
        actions={[
          { label: "Cancel", onClick: () => setDeleteConfirmOpen(false) },
          { label: "Delete", variant: "danger", onClick: handleDeleteConfirm },
        ]}
      >
        <p>Are you sure you want to delete &ldquo;{base.name}&rdquo;? This will remove all documents and indexed data. This action cannot be undone.</p>
      </Modal>
    </div>
  );
});
