export interface AgentRole {
  name: string;
  system_prompt: string;
  allowed_tools: string[];
  can_manage: boolean;
}

export interface RoleEntry extends AgentRole {
  is_default: boolean;
}

