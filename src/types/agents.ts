export interface AgentEntry {
  id: string;
  projectPath: string;
  projectName: string;
  createdAt: number;
  order: number;
}

export interface AgentsConfig {
  agents: AgentEntry[];
  activeAgentId: string | null;
}
