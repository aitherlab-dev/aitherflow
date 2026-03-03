import { memo, useEffect, useCallback } from "react";
import { List } from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore } from "../../stores/chatStore";

export const StatusBar = memo(function StatusBar() {
  const agentLogOpen = useLayoutStore((s) => s.agentLogOpen);
  const toggleAgentLog = useLayoutStore((s) => s.toggleAgentLog);
  const messages = useChatStore((s) => s.messages);

  let toolCount = 0;
  for (const msg of messages) {
    if (msg.tools) toolCount += msg.tools.length;
  }

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.altKey && e.code === "KeyA") {
        e.preventDefault();
        toggleAgentLog();
      }
    },
    [toggleAgentLog],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <footer className="app-statusbar">
      <button
        className={`statusbar-btn ${agentLogOpen ? "statusbar-btn--active" : ""}`}
        onClick={toggleAgentLog}
        title="Agent Log (Alt+A)"
        type="button"
      >
        <List size={13} />
        <span>Tasks</span>
        {toolCount > 0 && (
          <span className="statusbar-badge">{toolCount}</span>
        )}
      </button>
    </footer>
  );
});
