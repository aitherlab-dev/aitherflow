import { memo, useCallback, useState } from "react";
import { FileUp } from "lucide-react";
import { Modal } from "../Modal";
import { openDialog } from "../../lib/transport";
import { useKnowledgeStore } from "../../stores/knowledgeStore";

interface AddDocumentModalProps {
  open: boolean;
  baseId: string;
  onClose: () => void;
}

export const AddDocumentModal = memo(function AddDocumentModal({ open, baseId, onClose }: AddDocumentModalProps) {
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const addDocuments = useKnowledgeStore((s) => s.addDocuments);

  const handlePickFiles = useCallback(async () => {
    try {
      const result = await openDialog({
        multiple: true,
        title: "Select documents",
        filters: [
          { name: "Documents", extensions: ["txt", "md", "pdf", "json", "csv", "html"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (result) {
        const paths = Array.isArray(result) ? result : [result];
        setSelectedFiles(paths);
      }
    } catch (e) {
      console.error("Failed to open file dialog:", e);
    }
  }, []);

  const handleAdd = useCallback(async () => {
    if (selectedFiles.length === 0) return;
    await addDocuments(baseId, selectedFiles);
    setSelectedFiles([]);
    onClose();
  }, [selectedFiles, addDocuments, baseId, onClose]);

  const handleClose = useCallback(() => {
    setSelectedFiles([]);
    onClose();
  }, [onClose]);

  const actions = [
    { label: "Cancel", onClick: handleClose },
    { label: "Add", variant: "accent" as const, onClick: handleAdd, disabled: selectedFiles.length === 0 },
  ];

  return (
    <Modal open={open} title="Add Documents" onClose={handleClose} actions={actions}>
      <div className="kb-form">
        <button className="kb-file-picker" onClick={handlePickFiles}>
          <FileUp size={18} />
          <span>Choose files…</span>
        </button>
        {selectedFiles.length > 0 && (
          <div className="kb-file-list">
            {selectedFiles.map((f) => (
              <div key={f} className="kb-file-list__item">
                {f.split("/").pop()}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
});
