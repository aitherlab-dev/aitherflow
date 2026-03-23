import { create } from "zustand";
import { invoke } from "../lib/transport";
import type { AgentEntry, AgentsConfig } from "../types/agents";
import { useChatStore, agentStates } from "./chatStore";
import { switchAgent, clearAgentState } from "./chatService";
import { useProjectStore } from "./projectStore";
import { resetTelegramState } from "../services/telegramService";

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

  /** Register agents launched externally (e.g. launch_team) — no CLI start */
  registerAgents: (entries: AgentEntry[]) => Promise<void>;

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
    try {
      for (const id of idsToRemove) {
        try {
          await invoke("stop_session", { agentId: id });
        } catch (e) {
          console.error(`[agentStore] stop_session for ${id}:`, e);
        }
        await clearAgentState(id);
        delete remainingLocks[id];
      }
    } finally {
      for (const id of idsToRemove) removingAgentIds.delete(id);
    }

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
    resetTelegramState();
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

  registerAgents: async (entries) => {
    if (entries.length === 0) return;
    const { agents } = get();

    saveChatLock(get, set);

    const updated = [...agents, ...entries];
    const activeId = entries[0].id;
    set({ agents: updated, activeAgentId: activeId });
    await persist(updated, activeId);

    // Switch chat context to the first new agent
    const first = entries[0];
    await switchAgent(first.id, first.projectPath, first.projectName, null);

    // Track last opened project
    useProjectStore.getState().setLastOpened(first.projectPath, null).catch(console.error);
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

/**
 * Launch a team via backend, register agents in stores, set roles.
 * Shared by PresetManagerModal and WelcomeScreen preset cards.
 */
export async function launchTeam(
  projectPath: string,
  roles: string[],
  models?: string[],
): Promise<string[]> {
  const agentIds = await invoke<string[]>("launch_team", {
    projectPath,
    roles,
    models: models?.length ? models : undefined,
  });

  const projectName = useProjectStore.getState().projects.find((p) => p.path === projectPath)?.name
    ?? projectPath.split("/").pop() ?? projectPath;

  const currentAgents = useAgentStore.getState().agents;
  const newAgents: AgentEntry[] = agentIds.map((id, i) => ({
    id,
    projectPath,
    projectName,
    createdAt: Date.now(),
    order: currentAgents.length + i,
  }));
  await useAgentStore.getState().registerAgents(newAgents);

  // Set roles in conductorStore (lazy import to avoid circular deps)
  const { useConductorStore } = await import("./conductorStore");
  const { setAgentRole } = useConductorStore.getState();
  const roleEntries = await invoke<Array<{ name: string; system_prompt: string; allowed_tools: string[]; can_manage: boolean; is_default: boolean; start_message?: string }>>("roles_list");
  for (let i = 0; i < agentIds.length; i++) {
    const match = roleEntries.find((r) => r.name === roles[i]);
    if (match) {
      setAgentRole(agentIds[i], match);

      // Add start_message as user message in agent chat history
      const startMsg = match.start_message;
      if (startMsg) {
        const userMsg = { id: crypto.randomUUID(), role: "user" as const, text: startMsg, timestamp: Date.now() };
        const existing = agentStates.get(agentIds[i]);
        if (existing) {
          existing.messages = [...existing.messages, userMsg];
        } else {
          agentStates.set(agentIds[i], {
            messages: [userMsg],
            streamingMessage: null,
            chatId: null,
            hasSession: false,
            isThinking: false,
            planMode: false,
            currentToolActivity: null,
            toolCount: 0,
            error: null,
          });
        }
        // Also update active agent's Zustand store if it's the current one
        if (useChatStore.getState().agentId === agentIds[i]) {
          useChatStore.setState((prev) => ({
            messages: [
              ...prev.messages,
              { id: crypto.randomUUID(), role: "user", text: startMsg, timestamp: Date.now() },
            ],
          }));
        }
      }
    }
  }

  return agentIds;
}
