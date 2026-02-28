import { memo } from "react";
import { useChatStore, getToolLabel } from "../../stores/chatStore";

export const ToolStatus = memo(function ToolStatus() {
  const activity = useChatStore((s) => s.currentToolActivity);

  if (!activity) return null;

  return (
    <div className="tool-status">
      <span className="tool-status-dot" />
      <span className="tool-status-text">{getToolLabel(activity)}</span>
    </div>
  );
});
