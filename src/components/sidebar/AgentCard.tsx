import { memo, useCallback } from "react";
import { ChevronRight, X } from "lucide-react";
import { useAgentStore } from "../../stores/agentStore";
import { ChatList } from "./ChatList";
import type { AgentInfo } from "../../types/agent";

function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
}

interface AgentCardProps {
  agent: AgentInfo;
}

export const AgentCard = memo(function AgentCard({ agent }: AgentCardProps) {
  const toggleExpanded = useAgentStore((s) => s.toggleExpanded);
  const removeProject = useAgentStore((s) => s.removeProject);
  const agentCount = useAgentStore((s) => s.agents.length);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    removeProject(agent.id);
  }, [removeProject, agent.id]);

  return (
    <div className="agent-card">
      <button
        className="agent-card-header"
        onClick={() => toggleExpanded(agent.id)}
      >
        <ChevronRight
          size={14}
          className={`agent-card-chevron ${agent.expanded ? "agent-card-chevron-open" : ""}`}
        />
        <div className="agent-card-title">
          <span className="agent-card-name">{agent.name}</span>
          <span className="agent-card-path">
            {agent.id === "workspace" ? "(default)" : shortenPath(agent.projectPath)}
          </span>
        </div>
        {agentCount > 1 && (
          <span
            role="button"
            tabIndex={0}
            className="agent-card-close"
            onClick={handleClose}
          >
            <X size={14} />
          </span>
        )}
      </button>
      <div
        className={`agent-card-body ${agent.expanded ? "agent-card-body-open" : ""}`}
      >
        <div className="agent-card-body-inner">
          <ChatList agentId={agent.id} />
        </div>
      </div>
    </div>
  );
});
