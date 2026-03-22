export interface AgentRole {
  name: string;
  system_prompt: string;
  allowed_tools: string[];
  can_manage: boolean;
  start_message?: string;
}

export interface RoleEntry extends AgentRole {
  is_default: boolean;
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

