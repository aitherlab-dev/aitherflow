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
}

export const useConductorStore = create<ConductorState>((set) => ({
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
      costUsd: 0,
      events: [],
    }),
}));

// ── Module-level event listener (singleton, lives for app lifetime) ──

listen<CliEvent>("cli-event", (event) => {
  const e = event.payload;
  if (e.agent_id !== useChatStore.getState().agentId) return;

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
    case "usageInfo":
      set({
        inputTokens: e.input_tokens,
        outputTokens: e.output_tokens,
        costUsd: e.cost_usd,
      });
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
