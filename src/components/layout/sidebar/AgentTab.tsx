import { memo, useCallback } from "react";
import { Loader, X } from "lucide-react";
import { Tooltip } from "../../shared/Tooltip";

export const AgentTab = memo(function AgentTab({
  agentId,
  projectName,
  isActive,
  isThinking,
  isBackgroundThinking,
  onActivate,
  onClose,
}: {
  agentId: string;
  projectName: string;
  isActive: boolean;
  isThinking: boolean;
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
    <div className="sidebar-project-wrapper">
      <button
        className={`sidebar-project ${isActive ? "sidebar-project--active" : ""}`}
        onClick={handleClick}
      >
        <span className="sidebar-project__name">{projectName}</span>
        {isBackgroundThinking && !isActive && (
          <Loader size={14} className="sidebar-project__bg-spinner" />
        )}
        {isThinking && isActive && (
          <Loader size={14} className="sidebar-project__bg-spinner" />
        )}
      </button>
      <Tooltip text="Close agent">
        <button
          className="sidebar-project__close"
          onClick={handleClose}
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  );
});
