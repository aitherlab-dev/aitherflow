import { create } from "zustand";
import { invoke } from "../lib/transport";
import type {
  Team,
  TeamAgent,
  TeamMessage,
  TeamTask,
  AgentRole,
} from "../types/team";

interface TeamState {
  teams: Team[];
  activeTeamId: string | null;
  messages: TeamMessage[];
  tasks: TeamTask[];

  setActiveTeam: (teamId: string | null) => void;

  fetchTeams: () => Promise<void>;
  createTeam: (name: string, projectPath: string) => Promise<Team>;
  addAgent: (teamId: string, role: AgentRole, branch?: string | null) => Promise<TeamAgent>;
  removeAgent: (teamId: string, agentId: string) => Promise<void>;
  startAgent: (teamId: string, agentId: string) => Promise<void>;
  stopAgent: (teamId: string, agentId: string) => Promise<void>;
  deleteTeam: (teamId: string) => Promise<void>;

  fetchAllMessages: (teamName: string) => Promise<void>;
  clearMessages: (teamName: string) => Promise<void>;
  sendMessage: (teamName: string, from: string, to: string, text: string) => Promise<void>;
  broadcastMessage: (teamName: string, from: string, text: string, agentIds: string[]) => Promise<void>;

  fetchTasks: (teamName: string) => Promise<void>;
  createTask: (teamName: string, title: string, description: string) => Promise<TeamTask>;
  claimTask: (teamName: string, taskId: string, agentId: string) => Promise<void>;
  completeTask: (teamName: string, taskId: string, agentId: string) => Promise<void>;
}

export const useTeamStore = create<TeamState>((set, get) => ({
  teams: [],
  activeTeamId: null,
  messages: [],
  tasks: [],

  setActiveTeam: (teamId) => set({ activeTeamId: teamId, messages: [], tasks: [] }),

  fetchTeams: async () => {
    try {
      const teams = await invoke<Team[]>("team_list");
      set({ teams });
    } catch (e) {
      console.error("[teamStore] fetchTeams:", e);
    }
  },

  createTeam: async (name, projectPath) => {
    const team = await invoke<Team>("team_create", { name, projectPath });
    await get().fetchTeams();
    set({ activeTeamId: team.id });
    return team;
  },

  addAgent: async (teamId, role, branch) => {
    const agent = await invoke<TeamAgent>("team_add_agent", {
      teamId,
      role,
      worktreeBranch: branch ?? null,
    });
    await get().fetchTeams();
    return agent;
  },

  removeAgent: async (teamId, agentId) => {
    await invoke("team_remove_agent", { teamId, agentId });
    await get().fetchTeams();
  },

  startAgent: async (teamId, agentId) => {
    await invoke("team_start_agent", { teamId, agentId });
    await get().fetchTeams();
  },

  stopAgent: async (teamId, agentId) => {
    await invoke("team_stop_agent", { teamId, agentId });
    await get().fetchTeams();
  },

  deleteTeam: async (teamId) => {
    await invoke("team_delete", { teamId });
    await get().fetchTeams();
    if (get().activeTeamId === teamId) {
      set({ activeTeamId: null, messages: [], tasks: [] });
    }
  },

  fetchAllMessages: async (teamName) => {
    try {
      const msgs = await invoke<TeamMessage[]>("team_read_all_messages", {
        team: teamName,
      });
      set({ messages: msgs });
    } catch (e) {
      console.error("[teamStore] fetchAllMessages:", e);
    }
  },

  sendMessage: async (teamName, from, to, text) => {
    await invoke("team_send_message", { team: teamName, from, to, text });
    invoke("team_push_message", { agentId: to, text }).catch(console.error);
    await get().fetchAllMessages(teamName);
  },

  clearMessages: async (teamName) => {
    await invoke("team_clear_messages", { team: teamName });
    set({ messages: [] });
  },

  broadcastMessage: async (teamName, from, text, agentIds) => {
    await invoke("team_broadcast", { team: teamName, from, text, agentIds });
    for (const agentId of agentIds) {
      if (agentId !== from) {
        invoke("team_push_message", { agentId, text }).catch(console.error);
      }
    }
    await get().fetchAllMessages(teamName);
  },

  fetchTasks: async (teamName) => {
    try {
      const tasks = await invoke<TeamTask[]>("team_list_tasks", { team: teamName });
      set({ tasks });
    } catch (e) {
      console.error("[teamStore] fetchTasks:", e);
    }
  },

  createTask: async (teamName, title, description) => {
    const task = await invoke<TeamTask>("team_create_task", {
      team: teamName,
      title,
      description,
      blockedBy: [],
    });
    await get().fetchTasks(teamName);
    return task;
  },

  claimTask: async (teamName, taskId, agentId) => {
    await invoke("team_claim_task", { team: teamName, taskId, agentId });
    await get().fetchTasks(teamName);
  },

  completeTask: async (teamName, taskId, agentId) => {
    await invoke("team_complete_task", { team: teamName, taskId, agentId });
    await get().fetchTasks(teamName);
  },
}));
