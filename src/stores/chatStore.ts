import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CliEvent, StartSessionOptions, SendMessageOptions } from "../types/conductor";
import type { ChatMessage, ToolActivity } from "../types/chat";
// NOTE: circular import (agentStore also imports chatStore).
// Safe because cross-store calls happen only at runtime inside functions,
// never at module-evaluation time.
import { useAgentStore } from "./agentStore";

/** Timer for delayed tool activity reset (keeps status visible briefly) */
let toolActivityTimer: ReturnType<typeof setTimeout> | null = null;

/** Get the active agent ID from agentStore */
function getActiveAgentId(): string {
  return useAgentStore.getState().activeAgentId ?? "workspace";
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

interface ChatState {
  // Data
  activeChatId: string | null;
  chatMessages: Record<string, ChatMessage[]>;
  messages: ChatMessage[]; // mirror of chatMessages[activeChatId]
  /** Per-agent session tracking: agentId → has active CLI session */
  sessionByAgent: Record<string, boolean>;
  isThinking: boolean;
  currentToolActivity: ToolActivity | null;
  error: string | null;

  // Actions
  setActiveChatId: (chatId: string) => void;
  switchToAgent: (agentId: string, chatId: string) => void;
  sendMessage: (text: string) => Promise<void>;
  stopGeneration: () => Promise<void>;
  clearChat: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  activeChatId: null,
  chatMessages: {},
  messages: [],
  sessionByAgent: {},
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

  switchToAgent: (agentId: string, chatId: string) => {
    const state = get();
    const hasSession = state.sessionByAgent[agentId] ?? false;
    set({
      activeChatId: chatId,
      messages: state.chatMessages[chatId] ?? [],
      isThinking: false,
      currentToolActivity: null,
      error: null,
    });
    // If the agent has no active session, ensure isThinking is false
    if (!hasSession) {
      set({ isThinking: false });
    }
  },

  sendMessage: async (text: string) => {
    const state = get();
    const chatId = state.activeChatId;
    if (!chatId) return;

    const agentId = getActiveAgentId();

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
      const hasSession = state.sessionByAgent[agentId] ?? false;
      if (hasSession) {
        await invoke("send_message", {
          options: { agentId, prompt: text } satisfies SendMessageOptions,
        });
      } else {
        const agentState = useAgentStore.getState();
        const activeAgent = agentState.agents.find((a) => a.id === agentId);
        await invoke("start_session", {
          options: {
            agentId,
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
    const agentId = getActiveAgentId();
    try {
      await invoke("stop_session", { agentId });
    } catch (e) {
      set({ error: String(e) });
    }
    set({ isThinking: false, currentToolActivity: null });
  },

  clearChat: () => {
    const state = get();
    const chatId = state.activeChatId;
    if (!chatId) return;

    const agentId = getActiveAgentId();

    set({
      chatMessages: { ...state.chatMessages, [chatId]: [] },
      messages: [],
      sessionByAgent: { ...state.sessionByAgent, [agentId]: false },
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
  // Route events to the correct chat via activeChatByAgent mapping
  const agentState = useAgentStore.getState();
  const chatId = agentState.activeChatByAgent[e.agent_id];
  if (!chatId) return;

  const state = useChatStore.getState();
  const isActiveChat = chatId === state.activeChatId;
  const currentMsgs = state.chatMessages[chatId] ?? [];

  switch (e.type) {
    case "sessionId":
      useChatStore.setState({
        sessionByAgent: { ...state.sessionByAgent, [e.agent_id]: true },
      });
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
      updateMessages(chatId, msgs, isActiveChat ? { isThinking: true } : undefined);
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
      updateMessages(chatId, msgs, isActiveChat ? { currentToolActivity: activity } : undefined);
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
      if (isActiveChat) {
        if (toolActivityTimer) clearTimeout(toolActivityTimer);
        toolActivityTimer = setTimeout(() => {
          toolActivityTimer = null;
          if (useChatStore.getState().currentToolActivity?.toolUseId === e.tool_use_id) {
            useChatStore.setState({ currentToolActivity: null });
          }
        }, 1500);
      }
      break;
    }

    case "turnComplete":
      if (isActiveChat) {
        useChatStore.setState({ isThinking: false, currentToolActivity: null });
      }
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
      useChatStore.setState({
        sessionByAgent: { ...useChatStore.getState().sessionByAgent, [e.agent_id]: false },
      });
      if (isActiveChat) {
        useChatStore.setState({ isThinking: false, currentToolActivity: null });
      }
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
      if (isActiveChat) {
        useChatStore.setState({ error: e.message, isThinking: false });
      }
      break;
  }
}

listen<CliEvent>("cli-event", (event) => handleCliEvent(event.payload)).catch(
  console.error,
);
