/** Agent — a workspace with its own CLI session */
export interface AgentInfo {
  id: string;
  name: string;
  projectPath: string;
  expanded: boolean;
}

/** A chat belonging to an agent */
export interface ChatInfo {
  id: string;
  agentId: string;
  title: string;
  createdAt: number;
}
