import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useFileViewerStore } from "../../stores/fileViewerStore";
import { useShallow } from "zustand/react/shallow";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore } from "../../stores/chatStore";
import { TabBar } from "./TabBar";
import { CodeViewer } from "./CodeViewer";
import { ImageViewer } from "./ImageViewer";
import { AgentLog } from "../chat/AgentLog";
import { FileWarning, List } from "lucide-react";

const DEFAULT_LOG_HEIGHT = 200;
const MIN_LOG_HEIGHT = 80;
const MIN_CONTENT_HEIGHT = 100;

export const FileViewerPanel = memo(function FileViewerPanel() {
  const tabs = useFileViewerStore(useShallow((s) => s.tabs));
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const diffs = useFileViewerStore(useShallow((s) => s.diffs));
  const updateTabContent = useFileViewerStore((s) => s.updateTabContent);
  const saveFile = useFileViewerStore((s) => s.saveFile);
  const agentLogOpen = useLayoutStore((s) => s.agentLogOpen);
  const toggleAgentLog = useLayoutStore((s) => s.toggleAgentLog);
  const messages = useChatStore((s) => s.messages);

  let toolCount = 0;
  for (const msg of messages) {
    if (msg.tools) toolCount += msg.tools.length;
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "KeyA") {
        e.preventDefault();
        toggleAgentLog();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAgentLog]);

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

  const [logHeight, setLogHeight] = useState(DEFAULT_LOG_HEIGHT);
  const panelRef = useRef<HTMLDivElement>(null);
  const draggingLog = useRef(false);

  const handleLogResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingLog.current = true;
      document.body.classList.add("select-none");
      document.body.style.cursor = "row-resize";

      const logEl = panelRef.current?.querySelector(".agent-log") as HTMLElement | null;
      if (logEl) logEl.style.transition = "none";

      const onMove = (ev: MouseEvent) => {
        if (!draggingLog.current || !panelRef.current) return;
        const panelRect = panelRef.current.getBoundingClientRect();
        const newHeight = panelRect.bottom - ev.clientY - 26; // subtract statusbar height
        const maxHeight = panelRect.height - MIN_CONTENT_HEIGHT - 26 - 36; // subtract tabbar + statusbar
        setLogHeight(Math.max(MIN_LOG_HEIGHT, Math.min(newHeight, maxHeight)));
      };

      const onUp = () => {
        draggingLog.current = false;
        document.body.classList.remove("select-none");
        document.body.style.cursor = "";
        if (logEl) logEl.style.transition = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [],
  );

  return (
    <div className="file-viewer-panel" ref={panelRef}>
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
            snapshot={activeDiff?.snapshot ?? null}
            onLineEdit={handleLineEdit}
            onSave={handleSave}
          />
        )}
      </div>
      {agentLogOpen && (
        <>
          <div
            className="fv-log-resize-handle"
            onMouseDown={handleLogResize}
          />
          <AgentLog height={logHeight} />
        </>
      )}
      <div className="fv-statusbar">
        <button
          className={`fv-statusbar__btn ${agentLogOpen ? "fv-statusbar__btn--active" : ""}`}
          onClick={toggleAgentLog}
          title="Agent Log (Alt+A)"
          type="button"
        >
          <List size={12} />
          <span>Tasks</span>
          {toolCount > 0 && (
            <span className="fv-statusbar__badge">{toolCount}</span>
          )}
        </button>
      </div>
    </div>
  );
});
