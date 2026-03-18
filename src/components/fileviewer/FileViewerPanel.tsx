import { memo, useCallback, useState, useEffect } from "react";
import { useFileViewerStore } from "../../stores/fileViewerStore";
import { useShallow } from "zustand/react/shallow";
import { TabBar } from "./TabBar";
import { CodeEditor } from "./CodeEditor";
import { DiffViewer } from "./DiffViewer";
import { ImageViewer } from "./ImageViewer";
import { MarkdownPreview } from "./MarkdownPreview";
import { FileWarning } from "lucide-react";

export const FileViewerPanel = memo(function FileViewerPanel() {
  const tabs = useFileViewerStore(useShallow((s) => s.tabs));
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const diffs = useFileViewerStore(useShallow((s) => s.diffs));
  const updateTabContent = useFileViewerStore((s) => s.updateTabContent);
  const saveFile = useFileViewerStore((s) => s.saveFile);

  const [editing, setEditing] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Reset editing mode when switching tabs
  useEffect(() => {
    setEditing(false);
  }, [activeTabId]);

  // Find pending diff for the active file
  const activeDiff = activeTab
    ? diffs.find(
        (d) => d.filePath === activeTab.filePath && d.status === "pending",
      )
    : null;

  const isMarkdownPreview =
    activeTab &&
    !activeTab.isPreview &&
    activeTab.language === "markdown" &&
    activeTab.content !== null &&
    !activeDiff &&
    !editing;

  const handleSave = useCallback(() => {
    if (!activeTab) return;
    saveFile(activeTab.id)
      .then(() => setEditing(false))
      .catch(console.error);
  }, [activeTab, saveFile]);

  return (
    <div className="file-viewer-panel">
      <TabBar />
      <div className="fv-content">
        {!activeTab ? (
          <div className="fv-empty">No file open</div>
        ) : activeTab.isImage ? (
          <ImageViewer filePath={activeTab.filePath} />
        ) : activeTab.content === null ? (
          <div className="fv-empty">
            <FileWarning size={32} className="fv-empty__icon" />
            <span>Binary file — cannot preview</span>
          </div>
        ) : activeDiff ? (
          <DiffViewer
            content={activeTab.content}
            diffEdits={activeDiff.edits}
            snapshot={activeDiff.snapshot ?? null}
          />
        ) : isMarkdownPreview ? (
          <MarkdownPreview
            content={activeTab.content}
            onDoubleClick={() => setEditing(true)}
          />
        ) : (
          <CodeEditor
            content={activeTab.content}
            language={activeTab.language}
            readOnly={false}
            onChange={(newContent) => updateTabContent(activeTab.id, newContent)}
            onSave={handleSave}
          />
        )}
      </div>
    </div>
  );
});
