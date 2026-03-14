export interface AgentRole {
  name: string;
  system_prompt: string;
  allowed_tools: string[];
  can_manage: boolean;
}

export interface RoleEntry extends AgentRole {
  is_builtin: boolean;
}

export type AgentStatus = "idle" | "running" | "stopped";
export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TeamAgent {
  agent_id: string;
  role: AgentRole;
  worktree_branch: string | null;
  status: AgentStatus;
}

export interface Team {
  id: string;
  name: string;
  project_path: string;
  agents: TeamAgent[];
  created_at: string;
}

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  read: boolean;
  broadcast_id?: string;
}

export interface TeamTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blocked_by: string[];
  created_at: string;
  completed_at: string | null;
}
