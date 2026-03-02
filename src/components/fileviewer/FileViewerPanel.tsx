import { memo, useCallback } from "react";
import { useFileViewerStore } from "../../stores/fileViewerStore";
import { useShallow } from "zustand/react/shallow";
import { TabBar } from "./TabBar";
import { CodeViewer } from "./CodeViewer";
import { ImageViewer } from "./ImageViewer";
import { FileWarning } from "lucide-react";

export const FileViewerPanel = memo(function FileViewerPanel() {
  const tabs = useFileViewerStore(useShallow((s) => s.tabs));
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const diffs = useFileViewerStore(useShallow((s) => s.diffs));
  const updateTabContent = useFileViewerStore((s) => s.updateTabContent);
  const saveFile = useFileViewerStore((s) => s.saveFile);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Find pending diff for the active file
  const activeDiff = activeTab
    ? diffs.find(
        (d) => d.filePath === activeTab.filePath && d.status === "pending",
      )
    : null;

  const handleLineEdit = useCallback(
    (lineIndex: number, newText: string) => {
      if (!activeTab?.content) return;
      const lines = activeTab.content.split("\n");
      lines[lineIndex] = newText;
      updateTabContent(activeTab.id, lines.join("\n"));
    },
    [activeTab, updateTabContent],
  );

  const handleSave = useCallback(() => {
    if (!activeTab) return;
    saveFile(activeTab.id).catch(console.error);
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
        ) : (
          <CodeViewer
            content={activeTab.content}
            language={activeTab.language}
            diffEdits={activeDiff?.edits}
            onLineEdit={handleLineEdit}
            onSave={handleSave}
          />
        )}
      </div>
    </div>
  );
});
