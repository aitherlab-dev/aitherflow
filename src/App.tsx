import { useEffect } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { useChatStore } from "./stores/chatStore";
import { useProjectStore } from "./stores/projectStore";
import { useAgentStore } from "./stores/agentStore";
import { useSkillStore } from "./stores/skillStore";

export function App() {
  const initChat = useChatStore((s) => s.init);
  const initProjects = useProjectStore((s) => s.init);
  const initAgents = useAgentStore((s) => s.init);
  const getActiveAgent = useAgentStore((s) => s.getActiveAgent);
  const loadSkills = useSkillStore((s) => s.load);

  useEffect(() => {
    // Agents must init before chat (chat needs agentId and projectPath)
    initAgents()
      .then(() => {
        const agent = getActiveAgent();
        if (agent) {
          loadSkills(agent.projectPath).catch(console.error);
          return initChat(agent.id, agent.projectPath, agent.projectName);
        }
      })
      .catch(console.error);

    // Projects init is independent
    initProjects().catch(console.error);
  }, [initAgents, initChat, initProjects, getActiveAgent, loadSkills]);

  return <AppLayout />;
}
