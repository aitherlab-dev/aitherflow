import { memo } from "react";
import { useAgentStore } from "../../stores/agentStore";

export const StatusBar = memo(function StatusBar() {
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const agents = useAgentStore((s) => s.agents);
  const activeAgent = agents.find((a) => a.id === activeAgentId);

  return (
    <footer className="app-statusbar">
      <span className="statusbar-text">
        {activeAgent
          ? `${activeAgent.name} — ${activeAgent.projectPath}`
          : "Ready"}
      </span>
    </footer>
  );
});
