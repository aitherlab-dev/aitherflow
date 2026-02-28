import { memo } from "react";
import { ChevronRight } from "lucide-react";
import { useAgentStore } from "../../stores/agentStore";
import { ChatList } from "./ChatList";
import type { AgentInfo } from "../../types/agent";

interface AgentCardProps {
  agent: AgentInfo;
}

export const AgentCard = memo(function AgentCard({ agent }: AgentCardProps) {
  const toggleExpanded = useAgentStore((s) => s.toggleExpanded);

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
        <span className="agent-card-name">{agent.name}</span>
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
