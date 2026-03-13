export interface AgentEntry {
  id: string;
  projectPath: string;
  projectName: string;
  createdAt: number;
  order: number;
  /** If set, this agent is a worktree child of the given parent agent */
  parentAgentId?: string;
  /** If set, this agent belongs to a team (not persisted to disk) */
  teamId?: string;
  /** Role within the team */
  teamRole?: "coder" | "reviewer" | "architect";
}

export interface AgentsConfig {
  agents: AgentEntry[];
  activeAgentId: string | null;
}
