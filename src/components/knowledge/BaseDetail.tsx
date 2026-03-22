import { memo, useCallback, useMemo, useState } from "react";
import { Plus, Trash2, Database, X, RefreshCw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { DocumentList } from "./DocumentList";
import { SearchPanel } from "./SearchPanel";
import { AddDocumentModal } from "./AddDocumentModal";
import { Modal } from "../Modal";
import { Tooltip } from "../shared/Tooltip";

export const BaseDetail = memo(function BaseDetail() {
  const { bases, selectedBaseId, deleteBase, reindexBase, bgOperation, bgResult, clearBgResult, error, clearError } = useKnowledgeStore(
    useShallow((s) => ({
      bases: s.bases,
      selectedBaseId: s.selectedBaseId,
      deleteBase: s.deleteBase,
      reindexBase: s.reindexBase,
      bgOperation: s.bgOperation,
      bgResult: s.bgResult,
      clearBgResult: s.clearBgResult,
      error: s.error,
      clearError: s.clearError,
    })),
  );

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [reindexConfirmOpen, setReindexConfirmOpen] = useState(false);

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

  const handleReindexConfirm = useCallback(() => {
    if (!base) return;
    setReindexConfirmOpen(false);
    reindexBase(base.id);
  }, [base, reindexBase]);

  // Is any bg operation running for this base?
  const isBusy = bgOperation !== null && bgOperation.baseId === base?.id;
  const isReindexing = isBusy && bgOperation?.type === "reindex";
  // Show result only for current base
  const visibleResult = bgResult && base && bgResult.baseId === base.id ? bgResult : null;

  // Progress bar percentage
  const progressPct = bgOperation && bgOperation.total > 0
    ? Math.round((bgOperation.processed / bgOperation.total) * 100)
    : 0;

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
      {error && (
        <div className="kb-error">
          <span className="kb-error__text">{error}</span>
          <button className="kb-error__close" onClick={clearError}>
            <X size={14} />
          </button>
        </div>
      )}

      {visibleResult && (
        <div className="kb-progress-banner kb-progress-banner--done">
          <span>{visibleResult.message}</span>
          <button className="kb-progress-banner__close" onClick={clearBgResult}>
            <X size={14} />
          </button>
        </div>
      )}

      {isBusy && (
        <div className="kb-progress-banner">
          <div className="kb-progress-banner__info">
            <span className="kb-progress-banner__label">{bgOperation.label}</span>
            {bgOperation.total > 1 && (
              <span className="kb-progress-banner__count">
                {bgOperation.processed}/{bgOperation.total}
              </span>
            )}
          </div>
          <div className="kb-progress-bar">
            <div
              className={`kb-progress-bar__fill${bgOperation.total === 0 ? " kb-progress-bar__fill--indeterminate" : ""}`}
              style={bgOperation.total > 0 ? { width: `${progressPct}%` } : undefined}
            />
          </div>
        </div>
      )}

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
            <button className="kb-btn kb-btn--accent" onClick={() => setAddModalOpen(true)} disabled={isBusy}>
              <Plus size={14} />
              <span>Add Documents</span>
            </button>
          </Tooltip>
          <Tooltip text="Reindex all documents">
            <button
              className="kb-btn kb-btn--secondary"
              onClick={() => setReindexConfirmOpen(true)}
              disabled={isBusy || base.documentCount === 0}
            >
              <RefreshCw size={14} className={isReindexing ? "kb-spin" : ""} />
              <span>{isReindexing ? "Reindexing…" : "Reindex All"}</span>
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

      <Modal
        open={reindexConfirmOpen}
        title="Reindex All Documents"
        onClose={() => setReindexConfirmOpen(false)}
        actions={[
          { label: "Cancel", onClick: () => setReindexConfirmOpen(false) },
          { label: "Reindex", variant: "accent", onClick: handleReindexConfirm },
        ]}
      >
        <p>Reindex all documents in &ldquo;{base.name}&rdquo;? This will re-parse, re-chunk, and re-embed all local documents. Web and YouTube sources will be skipped. This may take a while.</p>
      </Modal>
    </div>
  );
});
