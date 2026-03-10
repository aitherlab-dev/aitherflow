import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { AppLayout } from "./components/layout/AppLayout";
import { useProjectStore } from "./stores/projectStore";
import { useAgentStore } from "./stores/agentStore";
import { useSkillStore } from "./stores/skillStore";

export function App() {
  const initProjects = useProjectStore((s) => s.init);
  const projects = useProjectStore(useShallow((s) => s.projects));
  const initAgents = useAgentStore((s) => s.init);
  const loadSkills = useSkillStore((s) => s.load);

  useEffect(() => {
    initAgents().catch(console.error);
    initProjects().catch(console.error);
  }, [initAgents, initProjects]);

  // Reload skills when projects list changes
  useEffect(() => {
    if (projects.length > 0) {
      loadSkills(projects.map((p) => ({ path: p.path, name: p.name }))).catch(console.error);
    }
  }, [projects, loadSkills]);

  return <AppLayout />;
}
