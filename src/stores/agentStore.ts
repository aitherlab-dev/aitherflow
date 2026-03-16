import { create } from "zustand";
import { invoke } from "../lib/transport";
import type { AgentEntry, AgentsConfig } from "../types/agents";
import { useChatStore } from "./chatStore";
import { switchAgent, clearAgentState } from "./chatService";
import { useProjectStore } from "./projectStore";

interface AgentState {
  agents: AgentEntry[];
  activeAgentId: string | null;

  /** Maps agentId → currentChatId (tracks which chat each agent has open) */
  chatLocks: Record<string, string | null>;

  /** Load agents from disk */
  init: () => Promise<void>;

  /** Create a new agent bound to a project */
  createAgent: (projectPath: string, projectName: string) => Promise<void>;

  /** Remove an agent from sidebar (chats stay on disk) */
  removeAgent: (agentId: string) => Promise<void>;

  /** Switch to another agent */
  setActiveAgent: (agentId: string) => Promise<void>;

  /** Get the currently active agent entry */
  getActiveAgent: () => AgentEntry | undefined;

  /** Get chat IDs locked by other agents (excluding the given one) */
  getLockedChatIds: (excludeAgentId: string) => string[];

  /** Update chatLock for the active agent (called by chatStore on chat switch) */
  updateChatLock: (agentId: string, chatId: string | null) => void;

  /** Create a worktree child agent under a parent */
  createWorktreeAgent: (parentAgentId: string, worktreePath: string, branchName: string) => Promise<void>;

  /** Move agent from one index to another */
  reorderAgent: (fromIndex: number, toIndex: number) => Promise<void>;

  /** Update projectName for all agents bound to a given project path */
  renameProjectInAgents: (projectPath: string, newName: string) => Promise<void>;

  /** Remove agent from store without stopping CLI (session already killed externally) */
  unregisterAgent: (agentId: string) => Promise<void>;
}

/** Agent IDs currently being removed — CLI events for these should be ignored */
export const removingAgentIds = new Set<string>();

/** Persist current agents state to disk (worktree children are excluded) */
async function persist(agents: AgentEntry[], activeAgentId: string | null) {
  const diskAgents = agents.filter((a) => !a.parentAgentId);
  const diskActive = diskAgents.find((a) => a.id === activeAgentId)
    ? activeAgentId
    : diskAgents[0]?.id ?? null;
  await invoke("save_agents", { agents: diskAgents, activeAgentId: diskActive });
}

function saveChatLock(
  get: () => AgentState,
  set: (partial: Partial<AgentState>) => void,
) {
  const { activeAgentId, chatLocks } = get();
  if (activeAgentId) {
    const currentChatId = useChatStore.getState().currentChatId;
    set({ chatLocks: { ...chatLocks, [activeAgentId]: currentChatId } });
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  activeAgentId: null,
  chatLocks: {},

  init: async () => {
    try {
      // Rust already resets agents.json to Workspace-only on startup
      const config = await invoke<AgentsConfig>("load_agents");
      set({
        agents: config.agents,
        activeAgentId: config.activeAgentId,
      });
    } catch (e) {
      console.error("Failed to init agentStore:", e);
    }
  },

  createAgent: async (projectPath, projectName) => {
    const { agents } = get();
    const newAgent: AgentEntry = {
      id: crypto.randomUUID(),
      projectPath,
      projectName,
      createdAt: Date.now(),
      order: agents.length,
    };

    saveChatLock(get, set);

    const updated = [...agents, newAgent];
    set({ agents: updated, activeAgentId: newAgent.id });
    await persist(updated, newAgent.id);

    // Switch chatStore to the new agent
    await switchAgent(newAgent.id, newAgent.projectPath, newAgent.projectName, null);

    // Track last opened project
    useProjectStore.getState().setLastOpened(projectPath, null).catch(console.error);
  },

  createWorktreeAgent: async (parentAgentId, worktreePath, branchName) => {
    const { agents } = get();
    const parent = agents.find((a) => a.id === parentAgentId);
    if (!parent) return;

    // Count existing agents for this worktree to generate unique name
    const siblings = agents.filter(
      (a) => a.parentAgentId === parentAgentId && a.projectPath === worktreePath,
    );
    const displayName = siblings.length === 0 ? branchName : `${branchName}-${siblings.length + 1}`;

    const newAgent: AgentEntry = {
      id: crypto.randomUUID(),
      projectPath: worktreePath,
      projectName: displayName,
      createdAt: Date.now(),
      order: agents.length,
      parentAgentId,
    };

    saveChatLock(get, set);

    const updated = [...agents, newAgent];
    set({ agents: updated, activeAgentId: newAgent.id });
    await persist(updated, newAgent.id);

    await switchAgent(newAgent.id, newAgent.projectPath, newAgent.projectName, null);
  },

  removeAgent: async (agentId) => {
    const { agents, activeAgentId, chatLocks } = get();

    // Collect this agent + any worktree children
    const idsToRemove = new Set([agentId]);
    for (const a of agents) {
      if (a.parentAgentId === agentId) idsToRemove.add(a.id);
    }

    // Mark agents as removing BEFORE stop_session so event handler ignores late events
    for (const id of idsToRemove) removingAgentIds.add(id);

    // Stop CLI and clean up for all removed agents
    const remainingLocks = { ...chatLocks };
    for (const id of idsToRemove) {
      try {
        await invoke("stop_session", { agentId: id });
      } catch (e) {
        console.error(`[agentStore] stop_session for ${id}:`, e);
      }
      await clearAgentState(id);
      delete remainingLocks[id];
    }

    for (const id of idsToRemove) removingAgentIds.delete(id);

    const updated = agents.filter((a) => !idsToRemove.has(a.id));
    let newActiveId = activeAgentId;

    set({ chatLocks: remainingLocks });

    // If removing the active agent, switch to first available
    if (activeAgentId && idsToRemove.has(activeAgentId)) {
      newActiveId = updated[0]?.id ?? null;
    }

    set({ agents: updated, activeAgentId: newActiveId });
    await persist(updated, newActiveId);

    // If we changed active agent, tell chatStore
    if (activeAgentId && idsToRemove.has(activeAgentId) && newActiveId) {
      const newAgent = updated.find((a) => a.id === newActiveId);
      if (newAgent) {
        const savedChatId = remainingLocks[newActiveId] ?? null;
        await switchAgent(newAgent.id, newAgent.projectPath, newAgent.projectName, savedChatId);
      }
    }
  },

  setActiveAgent: async (agentId) => {
    const { agents, activeAgentId, chatLocks } = get();
    if (agentId === activeAgentId) return;

    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;

    saveChatLock(get, set);

    set({ activeAgentId: agentId });
    await persist(agents, agentId);

    // Restore saved chat position for the new agent
    const savedChatId = chatLocks[agentId] ?? null;

    // Tell chatStore to switch context
    await switchAgent(agent.id, agent.projectPath, agent.projectName, savedChatId);

    // Track last opened project
    useProjectStore.getState().setLastOpened(agent.projectPath, savedChatId).catch(console.error);
  },

  getActiveAgent: () => {
    const { agents, activeAgentId } = get();
    return agents.find((a) => a.id === activeAgentId);
  },

  getLockedChatIds: (excludeAgentId) => {
    const { chatLocks } = get();
    const locked: string[] = [];
    for (const [aid, chatId] of Object.entries(chatLocks)) {
      if (aid !== excludeAgentId && chatId) {
        locked.push(chatId);
      }
    }
    return locked;
  },

  updateChatLock: (agentId, chatId) => {
    const { chatLocks } = get();
    set({ chatLocks: { ...chatLocks, [agentId]: chatId } });
  },

  reorderAgent: async (fromIndex, toIndex) => {
    const { agents, activeAgentId } = get();
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || toIndex < 0) return;
    if (fromIndex >= agents.length || toIndex >= agents.length) return;

    const updated = [...agents];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);

    set({ agents: updated });
    await persist(updated, activeAgentId);
  },

  renameProjectInAgents: async (projectPath, newName) => {
    const { agents, activeAgentId } = get();
    const updated = agents.map((a) =>
      a.projectPath === projectPath ? { ...a, projectName: newName } : a,
    );
    set({ agents: updated });
    await persist(updated, activeAgentId);
  },

  unregisterAgent: async (agentId) => {
    const { agents, activeAgentId, chatLocks } = get();

    const remainingLocks = { ...chatLocks };
    await clearAgentState(agentId);
    delete remainingLocks[agentId];

    const updated = agents.filter((a) => a.id !== agentId);
    let newActiveId = activeAgentId;

    set({ chatLocks: remainingLocks });

    if (activeAgentId === agentId) {
      newActiveId = updated[0]?.id ?? null;
    }

    set({ agents: updated, activeAgentId: newActiveId });
    await persist(updated, newActiveId);

    if (activeAgentId === agentId && newActiveId) {
      const newAgent = updated.find((a) => a.id === newActiveId);
      if (newAgent) {
        const savedChatId = remainingLocks[newActiveId] ?? null;
        await switchAgent(newAgent.id, newAgent.projectPath, newAgent.projectName, savedChatId);
      }
    }
  },

}));
