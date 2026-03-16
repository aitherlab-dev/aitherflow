export interface AgentEntry {
  id: string;
  projectPath: string;
  projectName: string;
  createdAt: number;
  order: number;
  /** If set, this agent is a worktree child of the given parent agent */
  parentAgentId?: string;
}

export interface AgentsConfig {
  agents: AgentEntry[];
  activeAgentId: string | null;
}
