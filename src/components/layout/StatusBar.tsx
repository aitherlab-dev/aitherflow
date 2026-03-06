import { memo } from "react";
import { List } from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore, selectToolCount } from "../../stores/chatStore";
import { useHotkeyStore, bindingToString } from "../../stores/hotkeyStore";

export const StatusBar = memo(function StatusBar() {
  const agentLogOpen = useLayoutStore((s) => s.agentLogOpen);
  const toggleAgentLog = useLayoutStore((s) => s.toggleAgentLog);
  const toolCount = useChatStore(selectToolCount);
  const agentLogBinding = useHotkeyStore((s) => s.bindings.toggleAgentLog);

  return (
    <footer className="app-statusbar">
      <button
        className={`statusbar-btn ${agentLogOpen ? "statusbar-btn--active" : ""}`}
        onClick={toggleAgentLog}
        title={`Agent Log (${bindingToString(agentLogBinding)})`}
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
