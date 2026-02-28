import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CliEvent, StartSessionOptions, SendMessageOptions } from "../types/conductor";
import type { ChatMessage, ToolActivity } from "../types/chat";
// NOTE: circular import (agentStore also imports chatStore).
// Safe because cross-store calls happen only at runtime inside functions,
// never at module-evaluation time.
import { useAgentStore } from "./agentStore";

const AGENT_ID = "workspace";

/** Timer for delayed tool activity reset (keeps status visible briefly) */
let toolActivityTimer: ReturnType<typeof setTimeout> | null = null;

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

interface ChatState {
  // Data
  activeChatId: string | null;
  chatMessages: Record<string, ChatMessage[]>;
  messages: ChatMessage[]; // mirror of chatMessages[activeChatId]
  hasSession: boolean;
  isThinking: boolean;
  currentToolActivity: ToolActivity | null;
  error: string | null;

  // Actions
  setActiveChatId: (chatId: string) => void;
  sendMessage: (text: string) => Promise<void>;
  stopGeneration: () => Promise<void>;
  clearChat: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  activeChatId: null,
  chatMessages: {},
  messages: [],
  hasSession: false,
  isThinking: false,
  currentToolActivity: null,
  error: null,

  setActiveChatId: (chatId: string) => {
    const state = get();
    set({
      activeChatId: chatId,
      messages: state.chatMessages[chatId] ?? [],
      error: null,
    });
  },

  sendMessage: async (text: string) => {
    const state = get();
    const chatId = state.activeChatId;
    if (!chatId) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      timestamp: Date.now(),
    };

    const newMsgs = [...(state.chatMessages[chatId] ?? []), userMsg];
    set({
      chatMessages: { ...state.chatMessages, [chatId]: newMsgs },
      messages: newMsgs,
      error: null,
      isThinking: true,
    });

    try {
      if (state.hasSession) {
        await invoke("send_message", {
          options: { agentId: AGENT_ID, prompt: text } satisfies SendMessageOptions,
        });
      } else {
        const agentState = useAgentStore.getState();
        const activeAgent = agentState.agents.find((a) => a.id === agentState.activeAgentId);
        await invoke("start_session", {
          options: {
            agentId: AGENT_ID,
            prompt: text,
            projectPath: activeAgent?.projectPath,
          } satisfies StartSessionOptions,
        });
      }
    } catch (e) {
      set({ error: String(e), isThinking: false });
    }
  },

  stopGeneration: async () => {
    try {
      await invoke("stop_session", { agentId: AGENT_ID });
    } catch (e) {
      set({ error: String(e) });
    }
    set({ isThinking: false, currentToolActivity: null });
  },

  clearChat: () => {
    const state = get();
    const chatId = state.activeChatId;
    if (!chatId) return;
    set({
      chatMessages: { ...state.chatMessages, [chatId]: [] },
      messages: [],
      hasSession: false,
      isThinking: false,
      currentToolActivity: null,
      error: null,
    });
  },
}));

/** Get a human-readable label for the current tool activity */
export function getToolLabel(activity: ToolActivity): string {
  return toolLabel(activity.toolName, activity.toolInput);
}

// ── Helper: update messages for a specific chat ──

function updateMessages(chatId: string, msgs: ChatMessage[], extra?: Record<string, unknown>) {
  const state = useChatStore.getState();
  const update: Record<string, unknown> = {
    chatMessages: { ...state.chatMessages, [chatId]: msgs },
    ...extra,
  };
  // Only update the mirror field if this is the active chat
  if (chatId === state.activeChatId) {
    update.messages = msgs;
  }
  useChatStore.setState(update);
}

// ── Module-level event listener (singleton, lives for app lifetime) ──

function handleCliEvent(e: CliEvent) {
  if (e.agent_id !== AGENT_ID) return;

  const state = useChatStore.getState();
  const chatId = state.activeChatId;
  if (!chatId) return;

  const currentMsgs = state.chatMessages[chatId] ?? [];

  switch (e.type) {
    case "sessionId":
      useChatStore.setState({ hasSession: true });
      break;

    case "streamChunk": {
      const msgs = [...currentMsgs];
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
      updateMessages(chatId, msgs, { isThinking: true });
      break;
    }

    case "messageComplete": {
      const msgs = [...currentMsgs];
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
      updateMessages(chatId, msgs);
      break;
    }

    case "toolUse": {
      const activity: ToolActivity = {
        toolUseId: e.tool_use_id,
        toolName: e.tool_name,
        toolInput: e.tool_input,
      };
      const msgs = [...currentMsgs];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        const tools = [...(last.tools ?? []), activity];
        msgs[msgs.length - 1] = { ...last, tools };
      }
      if (toolActivityTimer) {
        clearTimeout(toolActivityTimer);
        toolActivityTimer = null;
      }
      updateMessages(chatId, msgs, { currentToolActivity: activity });
      break;
    }

    case "toolResult": {
      const msgs = [...currentMsgs];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && last.tools) {
        const tools = last.tools.map((t) =>
          t.toolUseId === e.tool_use_id
            ? { ...t, result: e.output_preview, isError: e.is_error }
            : t,
        );
        msgs[msgs.length - 1] = { ...last, tools };
      }
      updateMessages(chatId, msgs);
      // Delay clearing tool activity so it stays visible briefly
      if (toolActivityTimer) clearTimeout(toolActivityTimer);
      toolActivityTimer = setTimeout(() => {
        toolActivityTimer = null;
        if (useChatStore.getState().currentToolActivity?.toolUseId === e.tool_use_id) {
          useChatStore.setState({ currentToolActivity: null });
        }
      }, 1500);
      break;
    }

    case "turnComplete":
      useChatStore.setState({ isThinking: false, currentToolActivity: null });
      {
        const msgs = [...currentMsgs];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.isStreaming) {
          msgs[msgs.length - 1] = { ...last, isStreaming: false };
          updateMessages(chatId, msgs);
        }
      }
      break;

    case "processExited":
      useChatStore.setState({ hasSession: false, isThinking: false, currentToolActivity: null });
      {
        const msgs = [...currentMsgs];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.isStreaming) {
          msgs[msgs.length - 1] = { ...last, isStreaming: false };
          updateMessages(chatId, msgs);
        }
      }
      break;

    case "error":
      useChatStore.setState({ error: e.message, isThinking: false });
      break;
  }
}

listen<CliEvent>("cli-event", (event) => handleCliEvent(event.payload)).catch(
  console.error,
);
