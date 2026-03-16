import { create } from "zustand";
import { invoke, listen } from "../lib/transport";
import type { CliEvent } from "../types/conductor";
import type { AgentRole } from "../types/team";
import { useChatStore } from "./chatStore";

/** Maximum number of raw events to keep in the log (debug only, not in store) */
const MAX_EVENT_LOG = 200;

/** Module-level event log — not in Zustand because nothing renders it */
const eventLog: CliEvent[] = [];

/** Default context window size: 0 means "not yet reported by CLI" */
const DEFAULT_CONTEXT_WINDOW = 0;

// ── Per-agent usage state (persists across agent switches) ──

interface AgentUsageState {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  contextUsed: number;
  contextMax: number;
  costUsd: number;
}

/** Module-level map: stores usage for ALL agents. Survives agent switches. */
const agentUsage = new Map<string, AgentUsageState>();

function emptyUsage(): AgentUsageState {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: 0,
    contextMax: DEFAULT_CONTEXT_WINDOW,
    costUsd: 0,
  };
}

interface ConductorState {
  // State
  sessionId: string | null;
  model: string | null;
  selectedModel: string;
  selectedEffort: string;
  selectedPermissionMode: "default" | "plan";
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  contextUsed: number;
  contextMax: number;
  costUsd: number;
  slashCommands: string[];
  /** Per-agent role selection (persists across agent switches) */
  agentRoles: Record<string, AgentRole | null>;

  // Actions
  setSelectedModel: (model: string) => void;
  setSelectedEffort: (effort: string) => void;
  setSelectedPermissionMode: (mode: "default" | "plan") => void;
  setAgentRole: (agentId: string, role: AgentRole | null) => void;
  getAgentRole: (agentId: string) => AgentRole | null;
  reset: () => void;
  saveUsageForAgent: (agentId: string) => void;
  restoreUsageForAgent: (agentId: string) => void;
  loadSavedUsage: (sessionId: string, projectPath: string) => Promise<void>;
}

export const useConductorStore = create<ConductorState>((set, get) => ({
  // Initial state
  sessionId: null,
  model: null,
  selectedModel: "opus",
  selectedEffort: "high",
  selectedPermissionMode: "default",
  error: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  contextUsed: 0,
  contextMax: DEFAULT_CONTEXT_WINDOW,
  costUsd: 0,
  slashCommands: [],
  agentRoles: {},

  setSelectedModel: (model: string) => set({ selectedModel: model }),
  setSelectedEffort: (effort: string) => set({ selectedEffort: effort }),
  setSelectedPermissionMode: (mode: "default" | "plan") => set({ selectedPermissionMode: mode }),
  setAgentRole: (agentId: string, role: AgentRole | null) =>
    set((s) => ({ agentRoles: { ...s.agentRoles, [agentId]: role } })),
  getAgentRole: (agentId: string) => get().agentRoles[agentId] ?? null,

  reset: () =>
    set({
      sessionId: null,
      model: null,
      error: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      contextUsed: 0,
      contextMax: DEFAULT_CONTEXT_WINDOW,
      costUsd: 0,
      slashCommands: [],
    }),

  saveUsageForAgent: (agentId: string) => {
    const s = get();
    agentUsage.set(agentId, {
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheCreationTokens: s.cacheCreationTokens,
      cacheReadTokens: s.cacheReadTokens,
      contextUsed: s.contextUsed,
      contextMax: s.contextMax,
      costUsd: s.costUsd,
    });
  },

  restoreUsageForAgent: (agentId: string) => {
    const saved = agentUsage.get(agentId);
    if (saved) {
      set({ ...saved });
    } else {
      const fresh = emptyUsage();
      set({ ...fresh });
    }
  },

  loadSavedUsage: async (sessionId: string, projectPath: string) => {
    // Skip if we already have usage data
    if (get().contextUsed > 0) return;
    try {
      const data = await invoke<Record<string, number> | null>(
        "get_session_usage",
        { sessionId, projectPath },
      );
      if (data && data.context_used > 0) {
        set({
          inputTokens: data.input_tokens,
          outputTokens: data.output_tokens,
          cacheCreationTokens: data.cache_creation_input_tokens,
          cacheReadTokens: data.cache_read_input_tokens,
          contextUsed: data.context_used,
          costUsd: data.cost_usd ?? 0,
          ...(data.context_window ? { contextMax: data.context_window } : {}),
        });
      }
    } catch (e) {
      console.error("Failed to load saved usage:", e);
    }
  },
}));

// ── Module-level event listener (singleton, lives for app lifetime) ──

listen<CliEvent>("cli-event", (event) => {
  const e = event.payload;
  const activeAgentId = useChatStore.getState().agentId;


  // contextInfo: real context size from assistant event (per-turn)
  if (e.type === "contextInfo") {
    const existing = agentUsage.get(e.agent_id) ?? emptyUsage();
    existing.contextUsed = e.context_used;
    existing.outputTokens = e.output_tokens;
    agentUsage.set(e.agent_id, { ...existing });

    if (e.agent_id === activeAgentId) {
      useConductorStore.setState({
        contextUsed: e.context_used,
        outputTokens: e.output_tokens,
      });
    }
    return;
  }

  // usageInfo: cumulative session totals from result event (for cost tracking, context window size)
  if (e.type === "usageInfo") {
    console.log(`[DEBUG] usageInfo agent=${e.agent_id} context_window=${e.context_window}`);
    const existing = agentUsage.get(e.agent_id) ?? emptyUsage();
    const contextMax =
      e.context_window > 0
        ? e.context_window
        : existing.contextMax;

    existing.inputTokens = e.input_tokens;
    existing.cacheCreationTokens = e.cache_creation_input_tokens;
    existing.cacheReadTokens = e.cache_read_input_tokens;
    existing.contextMax = contextMax;
    existing.costUsd = e.cost_usd;
    agentUsage.set(e.agent_id, { ...existing });

    if (e.agent_id === activeAgentId) {
      useConductorStore.setState({
        inputTokens: e.input_tokens,
        cacheCreationTokens: e.cache_creation_input_tokens,
        cacheReadTokens: e.cache_read_input_tokens,
        contextMax,
        costUsd: e.cost_usd,
      });
    }
    return;
  }

  // All other events: only process for active agent
  if (e.agent_id !== activeAgentId) return;

  const { setState: set } = useConductorStore;

  // Keep event log capped (module-level, not in store — nothing renders it)
  if (eventLog.length >= MAX_EVENT_LOG) eventLog.shift();
  eventLog.push(e);

  switch (e.type) {
    case "sessionId":
      set({ sessionId: e.session_id });
      break;
    case "modelInfo":
      set({ model: e.model });
      break;
    case "slashCommands":
      set({ slashCommands: e.commands });
      break;
    case "error":
      set({ error: e.message });
      break;
  }
}).catch(console.error);
