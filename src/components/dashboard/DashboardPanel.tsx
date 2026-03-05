import { memo, useCallback, useEffect, useState } from "react";
import { useMcpStore } from "../../stores/mcpStore";
import { useSkillStore } from "../../stores/skillStore";
import { useAgentStore } from "../../stores/agentStore";
import { TelegramCard } from "./cards/TelegramCard";
import { WebServerCard } from "./cards/WebServerCard";
import { McpCard } from "./cards/McpCard";
import { SkillsCard } from "./cards/SkillsCard";
import { AgentModeCard } from "./cards/AgentModeCard";
import { TokensCard } from "./cards/TokensCard";

export const DashboardPanel = memo(function DashboardPanel() {
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  const mcpNeedsReload = useMcpStore((s) => s.needsReload);
  const mcpLoad = useMcpStore((s) => s.load);
  const skillsLoaded = useSkillStore((s) => s.loaded);
  const skillsLoad = useSkillStore((s) => s.load);
  const activeProjectPath = useAgentStore(
    (s) => s.agents.find((a) => a.id === s.activeAgentId)?.projectPath,
  );

  // Load/reload MCP data when project changes
  useEffect(() => {
    if (mcpNeedsReload(activeProjectPath)) {
      mcpLoad(activeProjectPath).catch(console.error);
    }
  }, [activeProjectPath, mcpNeedsReload, mcpLoad]);

  useEffect(() => {
    if (!skillsLoaded) {
      const agent = useAgentStore.getState();
      const projectPath = agent.agents.find((a) => a.id === agent.activeAgentId)?.projectPath ?? "";
      skillsLoad(projectPath).catch(console.error);
    }
  }, [skillsLoaded, skillsLoad]);

  const handleToggle = useCallback((id: string) => {
    setExpandedCard((prev) => (prev === id ? null : id));
  }, []);

  return (
    <div className="dash-panel">
      <div className="dash-grid">
        <TelegramCard expanded={expandedCard === "telegram"} onToggle={handleToggle} />
        <WebServerCard expanded={expandedCard === "webserver"} onToggle={handleToggle} />
        <McpCard expanded={expandedCard === "mcp"} onToggle={handleToggle} />
        <SkillsCard expanded={expandedCard === "skills"} onToggle={handleToggle} />
        <AgentModeCard expanded={expandedCard === "agentmode"} onToggle={handleToggle} />
        <TokensCard expanded={expandedCard === "tokens"} onToggle={handleToggle} />
      </div>
    </div>
  );
});
