import { create } from "zustand";
import { invoke, listen } from "../lib/transport";
import type {
  CliEvent,
  StartSessionOptions,
  SendMessageOptions,
} from "../types/conductor";
import { useChatStore } from "./chatStore";

/** Get the current active agentId from chatStore */
function currentAgentId(): string {
  return useChatStore.getState().agentId;
}

/** Maximum number of raw events to keep in the log */
const MAX_EVENT_LOG = 200;

/** Default context window size (fallback when CLI doesn't report it) */
const DEFAULT_CONTEXT_WINDOW = 200_000;

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
  events: CliEvent[];

  // Actions
  setSelectedModel: (model: string) => void;
  setSelectedEffort: (effort: string) => void;
  setSelectedPermissionMode: (mode: "default" | "plan") => void;
  startSession: (prompt: string) => Promise<void>;
  sendFollowup: (prompt: string) => Promise<void>;
  stopSession: () => Promise<void>;
  clearError: () => void;
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
  events: [],

  setSelectedModel: (model: string) => set({ selectedModel: model }),
  setSelectedEffort: (effort: string) => set({ selectedEffort: effort }),
  setSelectedPermissionMode: (mode: "default" | "plan") => set({ selectedPermissionMode: mode }),

  startSession: async (prompt: string) => {
    set({ error: null });
    try {
      await invoke("start_session", {
        options: {
          agentId: currentAgentId(),
          prompt,
        } satisfies StartSessionOptions,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  sendFollowup: async (prompt: string) => {
    set({ error: null });
    try {
      await invoke("send_message", {
        options: {
          agentId: currentAgentId(),
          prompt,
        } satisfies SendMessageOptions,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  stopSession: async () => {
    try {
      await invoke("stop_session", { agentId: currentAgentId() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  clearError: () => set({ error: null }),

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
      events: [],
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

  const { setState: set, getState: get } = useConductorStore;

  // Keep event log capped — mutate-then-replace to avoid O(N) spread
  const events = get().events;
  if (events.length >= MAX_EVENT_LOG) events.shift();
  events.push(e);
  set({ events: [...events] });

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
