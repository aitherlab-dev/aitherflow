import { memo, useCallback } from "react";
import { X, ChevronDown, Check, Undo2 } from "lucide-react";
import { useFileViewerStore } from "../../stores/fileViewerStore";
import { useShallow } from "zustand/react/shallow";

export const TabBar = memo(function TabBar() {
  const tabs = useFileViewerStore(useShallow((s) => s.tabs));
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const setActiveTab = useFileViewerStore((s) => s.setActiveTab);
  const closeTab = useFileViewerStore((s) => s.closeTab);
  const diffs = useFileViewerStore(useShallow((s) => s.diffs));
  const changedListOpen = useFileViewerStore((s) => s.changedListOpen);
  const toggleChangedList = useFileViewerStore((s) => s.toggleChangedList);
  const openDiffFile = useFileViewerStore((s) => s.openDiffFile);
  const acceptDiff = useFileViewerStore((s) => s.acceptDiff);
  const rejectDiff = useFileViewerStore((s) => s.rejectDiff);

  const pendingDiffs = diffs.filter((d) => d.status === "pending");
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeDiff = activeTab
    ? pendingDiffs.find((d) => d.filePath === activeTab.filePath)
    : null;

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      closeTab(tabId);
    },
    [closeTab],
  );

  return (
    <div className="fv-tabbar-container">
      <div className="fv-tabbar">
        <div className="fv-tabbar__tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`fv-tab ${tab.id === activeTabId ? "fv-tab--active" : ""} ${tab.isPreview ? "fv-tab--preview" : ""} ${tab.isModified ? "fv-tab--modified" : ""}`}
              onClick={() => setActiveTab(tab.id)}
              title={tab.filePath}
            >
              <span className="fv-tab__name">{tab.fileName}</span>
              {tab.isModified && <span className="fv-tab__dot" />}
              {!tab.isPreview && (
                <span
                  className="fv-tab__close"
                  onClick={(e) => handleClose(e, tab.id)}
                >
                  <X size={12} />
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Changed files dropdown */}
        {pendingDiffs.length > 0 && (
          <div className="fv-changed-trigger">
            <button
              className="fv-changed-btn"
              onClick={toggleChangedList}
              title="Changed files"
            >
              <ChevronDown size={14} />
              <span className="fv-changed-badge">{pendingDiffs.length}</span>
            </button>
            {changedListOpen && (
              <div className="fv-changed-list">
                {pendingDiffs.map((diff) => (
                  <button
                    key={diff.toolUseId}
                    className="fv-changed-item"
                    onClick={() => openDiffFile(diff.toolUseId)}
                  >
                    {diff.fileName}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Accept / Reject bar */}
      {activeDiff && (
        <div className="fv-diff-actions">
          <button
            className="fv-diff-btn fv-diff-btn--accept"
            onClick={() => acceptDiff(activeDiff.toolUseId)}
            title="Accept changes"
          >
            <Check size={14} />
            <span>Accept</span>
          </button>
          <button
            className="fv-diff-btn fv-diff-btn--reject"
            onClick={() => rejectDiff(activeDiff.toolUseId)}
            title="Reject changes"
          >
            <Undo2 size={14} />
            <span>Reject</span>
          </button>
        </div>
      )}
    </div>
  );
});
