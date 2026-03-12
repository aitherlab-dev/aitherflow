import { memo, useCallback, useState } from "react";
import { X, ChevronDown, Check, Undo2, Save } from "lucide-react";
import { useFileViewerStore } from "../../stores/fileViewerStore";
import { useShallow } from "zustand/react/shallow";

export const TabBar = memo(function TabBar() {
  const tabs = useFileViewerStore(useShallow((s) => s.tabs));
  const activeTabId = useFileViewerStore((s) => s.activeTabId);
  const setActiveTab = useFileViewerStore((s) => s.setActiveTab);
  const closeTab = useFileViewerStore((s) => s.closeTab);
  const saveFile = useFileViewerStore((s) => s.saveFile);
  const diffs = useFileViewerStore(useShallow((s) => s.diffs));
  const changedListOpen = useFileViewerStore((s) => s.changedListOpen);
  const toggleChangedList = useFileViewerStore((s) => s.toggleChangedList);
  const openDiffFile = useFileViewerStore((s) => s.openDiffFile);
  const acceptDiff = useFileViewerStore((s) => s.acceptDiff);
  const rejectDiff = useFileViewerStore((s) => s.rejectDiff);

  const [confirmClose, setConfirmClose] = useState<string | null>(null);

  const pendingDiffs = diffs.filter((d) => d.status === "pending");
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeDiff = activeTab
    ? pendingDiffs.find((d) => d.filePath === activeTab.filePath)
    : null;

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.isModified) {
        setConfirmClose(tabId);
      } else {
        closeTab(tabId);
      }
    },
    [closeTab, tabs],
  );

  const handleSave = useCallback(() => {
    if (!activeTab) return;
    saveFile(activeTab.id).catch(console.error);
  }, [activeTab, saveFile]);

  const handleConfirmSave = useCallback(() => {
    if (!confirmClose) return;
    saveFile(confirmClose)
      .then(() => {
        closeTab(confirmClose);
        setConfirmClose(null);
      })
      .catch(console.error);
  }, [confirmClose, saveFile, closeTab]);

  const handleConfirmDiscard = useCallback(() => {
    if (!confirmClose) return;
    closeTab(confirmClose);
    setConfirmClose(null);
  }, [confirmClose, closeTab]);

  const confirmTab = confirmClose
    ? tabs.find((t) => t.id === confirmClose)
    : null;

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

        {/* Save button */}
        {activeTab?.isModified && (
          <button
            className="fv-save-btn"
            onClick={handleSave}
            title="Save (Ctrl+S)"
          >
            <Save size={14} />
          </button>
        )}

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
      {/* Unsaved changes modal */}
      {confirmTab && (
        <div className="fv-confirm-overlay" onClick={() => setConfirmClose(null)}>
          <div className="fv-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="fv-confirm-text">
              Save changes to <strong>{confirmTab.fileName}</strong>?
            </p>
            <div className="fv-confirm-actions">
              <button className="fv-confirm-btn fv-confirm-btn--save" onClick={handleConfirmSave}>
                Save
              </button>
              <button className="fv-confirm-btn fv-confirm-btn--discard" onClick={handleConfirmDiscard}>
                Discard
              </button>
              <button className="fv-confirm-btn" onClick={() => setConfirmClose(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
