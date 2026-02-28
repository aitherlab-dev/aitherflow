import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CliEvent, StartSessionOptions, SendMessageOptions } from "../types/conductor";
import type { ChatMessage, ToolActivity } from "../types/chat";

const DEFAULT_AGENT_ID = "default";

interface ChatState {
  // Data
  messages: ChatMessage[];
  hasSession: boolean;
  isThinking: boolean;
  currentToolActivity: ToolActivity | null;
  error: string | null;

  // Actions
  sendMessage: (text: string) => Promise<void>;
  stopGeneration: () => Promise<void>;
  clearChat: () => void;

  // Listener management
  _unlisten: UnlistenFn | null;
  initListener: () => Promise<void>;
  destroyListener: () => void;
}

/** Human-readable label for a tool name */
function toolLabel(toolName: string, toolInput: Record<string, unknown>): string {
  const file = typeof toolInput.file_path === "string"
    ? toolInput.file_path.split("/").pop()
    : typeof toolInput.path === "string"
      ? toolInput.path.split("/").pop()
      : null;

  switch (toolName) {
    case "Read":
      return file ? `Reading ${file}` : "Reading file";
    case "Edit":
      return file ? `Editing ${file}` : "Editing file";
    case "Write":
      return file ? `Writing ${file}` : "Writing file";
    case "Bash":
      return "Running command";
    case "Glob":
      return "Searching files";
    case "Grep":
      return "Searching code";
    case "TodoWrite":
      return "Updating tasks";
    case "Task":
      return "Running subagent";
    case "WebSearch":
      return "Searching web";
    case "WebFetch":
      return "Fetching page";
    default:
      return toolName;
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  hasSession: false,
  isThinking: false,
  currentToolActivity: null,
  error: null,
  _unlisten: null,

  initListener: async () => {
    if (get()._unlisten) return;

    const unlisten = await listen<CliEvent>("cli-event", (event) => {
      const e = event.payload;
      if (e.agent_id !== DEFAULT_AGENT_ID) return;

      const state = get();

      switch (e.type) {
        case "sessionId":
          set({ hasSession: true });
          break;

        case "streamChunk": {
          const msgs = [...state.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant" && last.isStreaming) {
            msgs[msgs.length - 1] = { ...last, text: e.text };
          } else {
            msgs.push({
              id: crypto.randomUUID(),
              role: "assistant",
              text: e.text,
              timestamp: Date.now(),
              isStreaming: true,
              tools: [],
            });
          }
          set({ messages: msgs, isThinking: true });
          break;
        }

        case "messageComplete": {
          const msgs = [...state.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant" && last.isStreaming) {
            msgs[msgs.length - 1] = { ...last, text: e.text, isStreaming: false };
          } else {
            msgs.push({
              id: crypto.randomUUID(),
              role: "assistant",
              text: e.text,
              timestamp: Date.now(),
              isStreaming: false,
            });
          }
          set({ messages: msgs });
          break;
        }

        case "toolUse": {
          const activity: ToolActivity = {
            toolUseId: e.tool_use_id,
            toolName: e.tool_name,
            toolInput: e.tool_input,
          };
          const msgs = [...state.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant") {
            const tools = [...(last.tools ?? []), activity];
            msgs[msgs.length - 1] = { ...last, tools };
          }
          set({ messages: msgs, currentToolActivity: activity });
          break;
        }

        case "toolResult": {
          const msgs = [...state.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant" && last.tools) {
            const tools = last.tools.map((t) =>
              t.toolUseId === e.tool_use_id
                ? { ...t, result: e.output_preview, isError: e.is_error }
                : t,
            );
            msgs[msgs.length - 1] = { ...last, tools };
          }
          set({ messages: msgs, currentToolActivity: null });
          break;
        }

        case "turnComplete":
          set({ isThinking: false, currentToolActivity: null });
          // Finalize any streaming message
          {
            const msgs = [...state.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant" && last.isStreaming) {
              msgs[msgs.length - 1] = { ...last, isStreaming: false };
              set({ messages: msgs });
            }
          }
          break;

        case "processExited":
          set({ hasSession: false, isThinking: false, currentToolActivity: null });
          // Finalize any streaming message
          {
            const msgs = [...state.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === "assistant" && last.isStreaming) {
              msgs[msgs.length - 1] = { ...last, isStreaming: false };
              set({ messages: msgs });
            }
          }
          break;

        case "error":
          set({ error: e.message, isThinking: false });
          break;
      }
    });

    set({ _unlisten: unlisten });
  },

  destroyListener: () => {
    const unlisten = get()._unlisten;
    if (unlisten) {
      unlisten();
      set({ _unlisten: null });
    }
  },

  sendMessage: async (text: string) => {
    const state = get();

    // Add user message
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      timestamp: Date.now(),
    };
    set({ messages: [...state.messages, userMsg], error: null, isThinking: true });

    try {
      if (state.hasSession) {
        await invoke("send_message", {
          options: { agentId: DEFAULT_AGENT_ID, prompt: text } satisfies SendMessageOptions,
        });
      } else {
        await invoke("start_session", {
          options: { agentId: DEFAULT_AGENT_ID, prompt: text } satisfies StartSessionOptions,
        });
      }
    } catch (e) {
      set({ error: String(e), isThinking: false });
    }
  },

  stopGeneration: async () => {
    try {
      await invoke("stop_session", { agentId: DEFAULT_AGENT_ID });
    } catch (e) {
      set({ error: String(e) });
    }
    set({ isThinking: false, currentToolActivity: null });
  },

  clearChat: () =>
    set({
      messages: [],
      hasSession: false,
      isThinking: false,
      currentToolActivity: null,
      error: null,
    }),
}));

/** Get a human-readable label for the current tool activity */
export function getToolLabel(activity: ToolActivity): string {
  return toolLabel(activity.toolName, activity.toolInput);
}
