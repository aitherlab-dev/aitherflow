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

const STORAGE_KEY = "aitherflow:dashboard:expanded";

function loadExpandedCards(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function saveExpandedCards(cards: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...cards]));
}

export const DashboardPanel = memo(function DashboardPanel() {
  const [expandedCards, setExpandedCards] = useState<Set<string>>(loadExpandedCards);

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
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveExpandedCards(next);
      return next;
    });
  }, []);

  return (
    <div className="dash-panel">
      <div className="dash-grid">
        <TelegramCard expanded={expandedCards.has("telegram")} onToggle={handleToggle} />
        <WebServerCard expanded={expandedCards.has("webserver")} onToggle={handleToggle} />
        <McpCard expanded={expandedCards.has("mcp")} onToggle={handleToggle} />
        <SkillsCard expanded={expandedCards.has("skills")} onToggle={handleToggle} />
        <AgentModeCard expanded={expandedCards.has("agentmode")} onToggle={handleToggle} />
        <TokensCard expanded={expandedCards.has("tokens")} onToggle={handleToggle} />
      </div>
    </div>
  );
});
