import { useEffect } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { useChatStore } from "./stores/chatStore";
import { useProjectStore } from "./stores/projectStore";
import { useAgentStore } from "./stores/agentStore";

export function App() {
  const initChat = useChatStore((s) => s.init);
  const initProjects = useProjectStore((s) => s.init);
  const initAgents = useAgentStore((s) => s.init);
  const getActiveAgent = useAgentStore((s) => s.getActiveAgent);

  useEffect(() => {
    // Agents must init before chat (chat needs agentId and projectPath)
    initAgents()
      .then(() => {
        const agent = getActiveAgent();
        if (agent) {
          return initChat(agent.id, agent.projectPath, agent.projectName);
        }
      })
      .catch(console.error);

    // Projects init is independent
    initProjects().catch(console.error);
  }, [initAgents, initChat, initProjects, getActiveAgent]);

  return <AppLayout />;
}
