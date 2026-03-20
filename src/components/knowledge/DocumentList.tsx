import { memo, useCallback } from "react";
import { FileText, Trash2 } from "lucide-react";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { Tooltip } from "../shared/Tooltip";

interface DocumentListProps {
  baseId: string;
}

export const DocumentList = memo(function DocumentList({ baseId }: DocumentListProps) {
  const documents = useKnowledgeStore((s) => s.documents);
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
              {doc.chunkCount} chunks · {new Date(doc.addedAt).toLocaleDateString()}
            </span>
          </div>
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
