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
  streamingText: string;
  model: string | null;
  selectedModel: string;
  selectedEffort: string;
  isThinking: boolean;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  contextUsed: number;
  contextMax: number;
  costUsd: number;
  events: CliEvent[];

  // Actions
  setSelectedModel: (model: string) => void;
  setSelectedEffort: (effort: string) => void;
  startSession: (prompt: string) => Promise<void>;
  sendFollowup: (prompt: string) => Promise<void>;
  stopSession: () => Promise<void>;
  clearError: () => void;
  reset: () => void;
  saveUsageForAgent: (agentId: string) => void;
  restoreUsageForAgent: (agentId: string) => void;
}

export const useConductorStore = create<ConductorState>((set, get) => ({
  // Initial state
  sessionId: null,
  streamingText: "",
  model: null,
  selectedModel: "opus",
  selectedEffort: "high",
  isThinking: false,
  error: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  contextUsed: 0,
  contextMax: DEFAULT_CONTEXT_WINDOW,
  costUsd: 0,
  events: [],

  setSelectedModel: (model: string) => set({ selectedModel: model }),
  setSelectedEffort: (effort: string) => set({ selectedEffort: effort }),

  startSession: async (prompt: string) => {
    set({
      error: null,
      isThinking: true,
      streamingText: "",
    });
    try {
      await invoke("start_session", {
        options: {
          agentId: currentAgentId(),
          prompt,
        } satisfies StartSessionOptions,
      });
    } catch (e) {
      set({ error: String(e), isThinking: false });
    }
  },

  sendFollowup: async (prompt: string) => {
    set({ error: null, isThinking: true });
    try {
      await invoke("send_message", {
        options: {
          agentId: currentAgentId(),
          prompt,
        } satisfies SendMessageOptions,
      });
    } catch (e) {
      set({ error: String(e), isThinking: false });
    }
  },

  stopSession: async () => {
    try {
      await invoke("stop_session", { agentId: currentAgentId() });
    } catch (e) {
      set({ error: String(e) });
    }
    set({ isThinking: false });
  },

  clearError: () => set({ error: null }),

  reset: () =>
    set({
      sessionId: null,
      streamingText: "",
      model: null,
      isThinking: false,
      error: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      contextUsed: 0,
      contextMax: DEFAULT_CONTEXT_WINDOW,
      costUsd: 0,
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
}));

// ── Module-level event listener (singleton, lives for app lifetime) ──

listen<CliEvent>("cli-event", (event) => {
  const e = event.payload;
  const activeAgentId = useChatStore.getState().agentId;

  // For usageInfo: always update the per-agent Map (even for background agents)
  if (e.type === "usageInfo") {
    const contextUsed =
      e.input_tokens + e.cache_creation_input_tokens + e.cache_read_input_tokens;
    const existing = agentUsage.get(e.agent_id);
    const contextMax =
      e.context_window > 0
        ? e.context_window
        : existing?.contextMax ?? DEFAULT_CONTEXT_WINDOW;

    const usage: AgentUsageState = {
      inputTokens: e.input_tokens,
      outputTokens: e.output_tokens,
      cacheCreationTokens: e.cache_creation_input_tokens,
      cacheReadTokens: e.cache_read_input_tokens,
      contextUsed,
      contextMax,
      costUsd: e.cost_usd,
    };
    agentUsage.set(e.agent_id, usage);

    // Update Zustand only if this is the active agent
    if (e.agent_id === activeAgentId) {
      useConductorStore.setState(usage);
    }
    return;
  }

  // All other events: only process for active agent
  if (e.agent_id !== activeAgentId) return;

  const { setState: set, getState: get } = useConductorStore;

  // Keep event log capped
  set({ events: [...get().events.slice(-MAX_EVENT_LOG), e] });

  switch (e.type) {
    case "sessionId":
      set({ sessionId: e.session_id });
      break;
    case "streamChunk":
      set({ streamingText: e.text, isThinking: true });
      break;
    case "messageComplete":
      set({ streamingText: e.text });
      break;
    case "modelInfo":
      set({ model: e.model });
      break;
    case "turnComplete":
      set({ isThinking: false });
      break;
    case "processExited":
      set({ isThinking: false });
      break;
    case "error":
      set({ error: e.message, isThinking: false });
      break;
  }
}).catch(console.error);
