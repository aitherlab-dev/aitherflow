import { memo, useRef, useEffect } from "react";
import { useChatStore, selectToolActivities } from "../../stores/chatStore";
import { useShallow } from "zustand/react/shallow";
import { ToolCard } from "./ToolCard";

export const AgentLog = memo(function AgentLog({ height }: { height?: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activities = useChatStore(useShallow(selectToolActivities));
  const runningId = useChatStore((s) => s.currentToolActivity?.toolUseId ?? null);

  const count = activities.length;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  return (
    <div className="agent-log" style={height ? { height } : undefined}>
      <div className="agent-log-header">
        <span className={`agent-log-dot ${runningId ? "agent-log-dot--active" : ""}`} />
        <span className="agent-log-title">Agent Log</span>
        <span className="agent-log-count">{count} actions</span>
      </div>
      <div className="agent-log-body" ref={scrollRef}>
        {count === 0 ? (
          <div className="agent-log-empty">No actions yet</div>
        ) : (
          activities.map((a) => (
            <ToolCard
              key={a.toolUseId}
              activity={a}
              isRunning={a.toolUseId === runningId}
            />
          ))
        )}
      </div>
    </div>
  );
});
