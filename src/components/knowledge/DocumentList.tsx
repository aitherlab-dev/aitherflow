import { memo, useCallback } from "react";
import { FileText, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { IndexProgress } from "./IndexProgress";
import { Tooltip } from "../shared/Tooltip";

interface DocumentListProps {
  baseId: string;
}

export const DocumentList = memo(function DocumentList({ baseId }: DocumentListProps) {
  const documents = useKnowledgeStore(useShallow((s) => s.documents));
  const removeDocument = useKnowledgeStore((s) => s.removeDocument);

  const handleRemove = useCallback(
    (docId: string) => {
      removeDocument(baseId, docId).catch(console.error);
    },
    [baseId, removeDocument],
  );

  if (documents.length === 0) {
    return <div className="kb-empty">No documents yet. Add some files to get started.</div>;
  }

  return (
    <div className="kb-doc-list">
      {documents.map((doc) => (
        <div key={doc.id} className="kb-doc-item">
          <FileText size={14} className="kb-doc-item__icon" />
          <div className="kb-doc-item__info">
            <span className="kb-doc-item__name">{doc.filename}</span>
            <span className="kb-doc-item__meta">
              {doc.chunk_count} chunks · {new Date(doc.added_at).toLocaleDateString()}
            </span>
          </div>
          <IndexProgress status={doc.status} compact />
          <Tooltip text="Remove document">
            <button className="kb-doc-item__remove" onClick={() => handleRemove(doc.id)}>
              <Trash2 size={14} />
            </button>
          </Tooltip>
        </div>
      ))}
    </div>
  );
});
