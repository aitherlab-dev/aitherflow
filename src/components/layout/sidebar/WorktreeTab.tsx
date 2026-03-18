import { memo, useCallback } from "react";
import { GitBranch, Loader, X } from "lucide-react";
import { Tooltip } from "../../shared/Tooltip";

export const WorktreeTab = memo(function WorktreeTab({
  agentId,
  branchName,
  isActive,
  isBackgroundThinking,
  onActivate,
  onClose,
}: {
  agentId: string;
  branchName: string;
  isActive: boolean;
  isBackgroundThinking: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const handleClick = useCallback(() => {
    if (!isActive) onActivate(agentId);
  }, [isActive, agentId, onActivate]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose(agentId);
    },
    [agentId, onClose],
  );

  return (
    <div className="sidebar-project-wrapper sidebar-worktree-wrapper">
      <button
        className={`sidebar-worktree ${isActive ? "sidebar-worktree--active" : ""}`}
        onClick={handleClick}
      >
        <GitBranch size={13} className="sidebar-worktree__icon" />
        <span className="sidebar-worktree__name">{branchName}</span>
        {isBackgroundThinking && !isActive && (
          <Loader size={12} className="sidebar-project__bg-spinner" />
        )}
      </button>
      <Tooltip text="Close worktree">
        <button
          className="sidebar-project__close"
          onClick={handleClose}
        >
          <X size={12} />
        </button>
      </Tooltip>
    </div>
  );
});
