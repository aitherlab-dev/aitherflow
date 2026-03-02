import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AgentEntry, AgentsConfig } from "../types/agents";
import { useChatStore } from "./chatStore";

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
}

/** Persist current agents state to disk */
async function persist(agents: AgentEntry[], activeAgentId: string | null) {
  await invoke("save_agents", { agents, activeAgentId });
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
    const { agents, activeAgentId } = get();
    const newAgent: AgentEntry = {
      id: crypto.randomUUID(),
      projectPath,
      projectName,
      createdAt: Date.now(),
      order: agents.length,
    };

    const updated = [...agents, newAgent];
    set({ agents: updated });
    await persist(updated, activeAgentId);
  },

  removeAgent: async (agentId) => {
    const { agents, activeAgentId, chatLocks } = get();

    // Don't remove the last agent
    if (agents.length <= 1) return;

    // Stop CLI for this agent
    try {
      await invoke("stop_session", { agentId });
    } catch {
      // Ignore — may not have an active session
    }

    const updated = agents.filter((a) => a.id !== agentId);
    let newActiveId = activeAgentId;

    // Clean up chat lock for removed agent
    const { [agentId]: _, ...remainingLocks } = chatLocks;
    set({ chatLocks: remainingLocks });

    // If removing the active agent, switch to first available
    if (activeAgentId === agentId) {
      newActiveId = updated[0]?.id ?? null;
    }

    set({ agents: updated, activeAgentId: newActiveId });
    await persist(updated, newActiveId);

    // If we changed active agent, tell chatStore
    if (activeAgentId === agentId && newActiveId) {
      const newAgent = updated.find((a) => a.id === newActiveId);
      if (newAgent) {
        const savedChatId = remainingLocks[newActiveId] ?? null;
        await useChatStore
          .getState()
          .switchAgent(newAgent.id, newAgent.projectPath, newAgent.projectName, savedChatId);
      }
    }
  },

  setActiveAgent: async (agentId) => {
    const { agents, activeAgentId, chatLocks } = get();
    if (agentId === activeAgentId) return;

    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;

    // Save current chat position for the old agent
    if (activeAgentId) {
      const currentChatId = useChatStore.getState().currentChatId;
      set({
        chatLocks: { ...chatLocks, [activeAgentId]: currentChatId },
      });
    }

    set({ activeAgentId: agentId });
    await persist(agents, agentId);

    // Restore saved chat position for the new agent
    const savedChatId = chatLocks[agentId] ?? null;

    // Tell chatStore to switch context
    await useChatStore
      .getState()
      .switchAgent(agent.id, agent.projectPath, agent.projectName, savedChatId);
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
}));
