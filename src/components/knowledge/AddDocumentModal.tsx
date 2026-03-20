import { memo, useCallback, useState } from "react";
import { FileUp, Globe } from "lucide-react";
import { Modal } from "../Modal";
import { openDialog } from "../../lib/transport";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import { useShallow } from "zustand/react/shallow";

type TabType = "files" | "url";

interface AddDocumentModalProps {
  open: boolean;
  baseId: string;
  onClose: () => void;
}

export const AddDocumentModal = memo(function AddDocumentModal({ open, baseId, onClose }: AddDocumentModalProps) {
  const [tab, setTab] = useState<TabType>("files");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const { addDocuments, addUrl } = useKnowledgeStore(
    useShallow((s) => ({ addDocuments: s.addDocuments, addUrl: s.addUrl })),
  );

  const handlePickFiles = useCallback(async () => {
    try {
      const result = await openDialog({
        multiple: true,
        title: "Select documents",
        filters: [
          { name: "Documents", extensions: ["txt", "md", "pdf", "epub", "json", "csv", "html"] },
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
    if (tab === "files") {
      if (selectedFiles.length === 0) return;
      await addDocuments(baseId, selectedFiles);
      setSelectedFiles([]);
    } else {
      if (!url.trim()) return;
      await addUrl(baseId, url.trim());
      setUrl("");
    }
    onClose();
  }, [tab, selectedFiles, url, addDocuments, addUrl, baseId, onClose]);

  const handleClose = useCallback(() => {
    setSelectedFiles([]);
    setUrl("");
    onClose();
  }, [onClose]);

  const isAddDisabled = tab === "files" ? selectedFiles.length === 0 : !url.trim();

  const actions = [
    { label: "Cancel", onClick: handleClose },
    { label: "Add", variant: "accent" as const, onClick: handleAdd, disabled: isAddDisabled },
  ];

  return (
    <Modal open={open} title="Add Documents" onClose={handleClose} actions={actions}>
      <div className="kb-form">
        <div className="kb-tabs">
          <button
            className={`kb-tabs__tab${tab === "files" ? " kb-tabs__tab--active" : ""}`}
            onClick={() => setTab("files")}
          >
            <FileUp size={14} />
            <span>Files</span>
          </button>
          <button
            className={`kb-tabs__tab${tab === "url" ? " kb-tabs__tab--active" : ""}`}
            onClick={() => setTab("url")}
          >
            <Globe size={14} />
            <span>URL</span>
          </button>
        </div>

        {tab === "files" && (
          <>
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
          </>
        )}

        {tab === "url" && (
          <input
            className="kb-form__input"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/article"
            autoFocus
          />
        )}
      </div>
    </Modal>
  );
});
