import { memo, useCallback, useState } from "react";
import { FileUp, Globe, Video } from "lucide-react";
import { Modal } from "../Modal";
import { openDialog } from "../../lib/transport";
import { useKnowledgeStore } from "../../stores/knowledgeStore";
import type { PlaylistSummary } from "../../stores/knowledgeStore";
import { useShallow } from "zustand/react/shallow";

type TabType = "files" | "url" | "youtube";

interface AddDocumentModalProps {
  open: boolean;
  baseId: string;
  onClose: () => void;
}

export const AddDocumentModal = memo(function AddDocumentModal({ open, baseId, onClose }: AddDocumentModalProps) {
  const [tab, setTab] = useState<TabType>("files");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [summary, setSummary] = useState<PlaylistSummary | null>(null);
  const { addDocuments, addUrl, addYoutube, playlistProgress } = useKnowledgeStore(
    useShallow((s) => ({
      addDocuments: s.addDocuments,
      addUrl: s.addUrl,
      addYoutube: s.addYoutube,
      playlistProgress: s.playlistProgress,
    })),
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
    setIsAdding(true);
    setSummary(null);
    try {
      if (tab === "files") {
        if (selectedFiles.length === 0) return;
        await addDocuments(baseId, selectedFiles);
        setSelectedFiles([]);
        onClose();
      } else if (tab === "url") {
        if (!url.trim()) return;
        await addUrl(baseId, url.trim());
        setUrl("");
        onClose();
      } else {
        if (!youtubeUrl.trim()) return;
        const result = await addYoutube(baseId, youtubeUrl.trim());
        if (result?.isPlaylist) {
          // Show summary for playlists instead of auto-closing
          setSummary(result);
        } else {
          setYoutubeUrl("");
          onClose();
        }
      }
    } finally {
      setIsAdding(false);
    }
  }, [tab, selectedFiles, url, youtubeUrl, addDocuments, addUrl, addYoutube, baseId, onClose]);

  const handleClose = useCallback(() => {
    setSelectedFiles([]);
    setUrl("");
    setYoutubeUrl("");
    setSummary(null);
    onClose();
  }, [onClose]);

  const isAddDisabled =
    isAdding ||
    (tab === "files" ? selectedFiles.length === 0 :
    tab === "url" ? !url.trim() :
    !youtubeUrl.trim());

  const actions = summary
    ? [{ label: "Done", variant: "accent" as const, onClick: () => { setSummary(null); setYoutubeUrl(""); onClose(); } }]
    : [
        { label: "Cancel", onClick: handleClose },
        { label: isAdding ? "Adding…" : "Add", variant: "accent" as const, onClick: handleAdd, disabled: isAddDisabled },
      ];

  return (
    <Modal open={open} title="Add Documents" onClose={handleClose} actions={actions}>
      <div className="kb-form">
        {!isAdding && !summary && (
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
            <button
              className={`kb-tabs__tab${tab === "youtube" ? " kb-tabs__tab--active" : ""}`}
              onClick={() => setTab("youtube")}
            >
              <Video size={14} />
              <span>YouTube</span>
            </button>
          </div>
        )}

        {summary ? (
          <div className="kb-playlist-summary">
            <p>
              Added {summary.added}/{summary.total} videos
              {summary.skipped > 0 && `, ${summary.skipped} skipped (no subtitles)`}
            </p>
          </div>
        ) : isAdding && playlistProgress ? (
          <div className="kb-playlist-progress">
            <p>
              Adding videos: {playlistProgress.processed}/{playlistProgress.total}
              {playlistProgress.skipped > 0 && ` (${playlistProgress.skipped} skipped)`}
            </p>
            {playlistProgress.currentTitle && (
              <p className="kb-playlist-progress__title">{playlistProgress.currentTitle}</p>
            )}
          </div>
        ) : (
          <>
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

            {tab === "youtube" && (
              <input
                className="kb-form__input"
                type="url"
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                placeholder="https://youtube.com/watch?v=... or playlist URL"
                autoFocus
              />
            )}
          </>
        )}
      </div>
    </Modal>
  );
});
