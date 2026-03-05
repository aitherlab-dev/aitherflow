import { useEffect } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { useChatStore } from "./stores/chatStore";
import { useProjectStore } from "./stores/projectStore";
import { useAgentStore } from "./stores/agentStore";
import { useSkillStore } from "./stores/skillStore";

export function App() {
  const initProjects = useProjectStore((s) => s.init);
  const initAgents = useAgentStore((s) => s.init);
  const loadSkills = useSkillStore((s) => s.load);
  const projectPath = useChatStore((s) => s.projectPath);

  useEffect(() => {
    // Init agents (creates default Workspace agent) — needed for welcome screen
    initAgents().catch(console.error);

    // Init projects (needed for welcome screen cards)
    initProjects().catch(console.error);
  }, [initAgents, initProjects]);

  // Reload skills when active project changes (agent switch)
  useEffect(() => {
    if (projectPath) {
      loadSkills(projectPath).catch(console.error);
    }
  }, [projectPath, loadSkills]);

  return <AppLayout />;
}
