import { memo, useRef, useEffect } from "react";
import { List } from "lucide-react";
import { useChatStore, getToolLabel, selectRecentTools, selectToolActivities, selectToolCount } from "../../stores/chatStore";
import { useShallow } from "zustand/react/shallow";
import { useLayoutStore } from "../../stores/layoutStore";
import { ToolCard } from "./ToolCard";

export const TaskBar = memo(function TaskBar() {
  const recentTools = useChatStore(useShallow(selectRecentTools));
  const activities = useChatStore(useShallow(selectToolActivities));
  const toolCount = useChatStore(selectToolCount);
  const runningId = useChatStore((s) => s.currentToolActivity?.toolUseId ?? null);
  const agentLogOpen = useLayoutStore((s) => s.agentLogOpen);

  const scrollRef = useRef<HTMLDivElement>(null);
  const count = activities.length;

  useEffect(() => {
    if (agentLogOpen) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [count, agentLogOpen]);

  if (recentTools.length === 0 && toolCount === 0) return null;

  return (
    <div className="taskbar">
      {/* Header row: Agent Log title + Tasks toggle */}
      <div className="taskbar__header">
        <div className="taskbar__title">
          <span className={`taskbar__dot ${runningId ? "taskbar__dot--active" : ""}`} />
          <span className="taskbar__label">Agent Log</span>
          <span className="taskbar__count">{count} actions</span>
        </div>
        <button
          className={`taskbar__toggle ${agentLogOpen ? "taskbar__toggle--active" : ""}`}
          onClick={() => useLayoutStore.getState().toggleAgentLog()}
          title="Agent Log (Alt+L)"
        >
          <List size={12} />
          <span>Tasks</span>
          {toolCount > 0 && (
            <span className="taskbar__badge">{toolCount}</span>
          )}
        </button>
      </div>

      {/* Always visible: last 2 tasks */}
      <div className="taskbar__recent">
        {recentTools.map((tool) => (
          <div
            key={tool.toolUseId}
            className={`tool-status ${tool.result !== undefined ? "tool-status--done" : ""}`}
          >
            <span className="tool-status-dot" />
            <span className="tool-status-text">{getToolLabel(tool)}</span>
          </div>
        ))}
      </div>

      {/* Expanded: full task list */}
      {agentLogOpen && (
        <div className="taskbar__list" ref={scrollRef}>
          {activities.map((a) => (
            <ToolCard
              key={a.toolUseId}
              activity={a}
              isRunning={a.toolUseId === runningId}
            />
          ))}
        </div>
      )}
    </div>
  );
});
