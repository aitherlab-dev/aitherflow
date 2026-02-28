import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CliEvent,
  StartSessionOptions,
  SendMessageOptions,
} from "../types/conductor";

const DEFAULT_AGENT_ID = "default";

/** Maximum number of raw events to keep in the log */
const MAX_EVENT_LOG = 200;

interface ConductorState {
  // State
  sessionId: string | null;
  streamingText: string;
  model: string | null;
  isThinking: boolean;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  events: CliEvent[];

  // Actions
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
  isThinking: false,
  error: null,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  events: [],

  startSession: async (prompt: string) => {
    set({
      error: null,
      isThinking: true,
      streamingText: "",
    });
    try {
      await invoke("start_session", {
        options: {
          agentId: DEFAULT_AGENT_ID,
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
          agentId: DEFAULT_AGENT_ID,
          prompt,
        } satisfies SendMessageOptions,
      });
    } catch (e) {
      set({ error: String(e), isThinking: false });
    }
  },

  stopSession: async () => {
    try {
      await invoke("stop_session", { agentId: DEFAULT_AGENT_ID });
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
  if (e.agent_id !== DEFAULT_AGENT_ID) return;

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
