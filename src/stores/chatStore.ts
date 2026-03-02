import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CliEvent, StartSessionOptions, SendMessageOptions } from "../types/conductor";
import type { ChatMessage, ToolActivity } from "../types/chat";
import { useAgentStore } from "./agentStore";

/** Timer for delayed tool activity reset (keeps status visible briefly) */
let toolActivityTimer: ReturnType<typeof setTimeout> | null = null;

// ── Types ──

/** Chat metadata for sidebar listing (no messages) */
export interface ChatMeta {
  id: string;
  title: string;
  createdAt: number;
  sessionId: string | null;
}

interface ChatState {
  // Agent context
  agentId: string;
  projectPath: string;
  projectName: string;

  // Chat list (sidebar)
  chatList: ChatMeta[];
  currentChatId: string | null;

  // Current chat data
  messages: ChatMessage[];
  hasSession: boolean;
  isThinking: boolean;
  currentToolActivity: ToolActivity | null;
  error: string | null;

  // Actions
  init: (agentId: string, projectPath: string, projectName: string) => Promise<void>;
  loadChatList: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  stopGeneration: () => Promise<void>;
  switchChat: (chatId: string) => Promise<void>;
  newChat: () => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  switchAgent: (agentId: string, projectPath: string, projectName: string, savedChatId: string | null) => Promise<void>;
}

// ── Helpers ──

/** Truncate text to ~30 chars at word boundary */
function generateTitle(text: string): string {
  const max = 30;
  const singleLine = text.replace(/\n/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  const truncated = singleLine.slice(0, max);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

/** Convert frontend ChatMessage[] to storable format (strip isStreaming) */
function messagesToStored(messages: ChatMessage[]) {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    timestamp: m.timestamp,
    tools: (m.tools ?? []).map((t) => ({
      toolUseId: t.toolUseId,
      toolName: t.toolName,
      toolInput: t.toolInput,
      result: t.result ?? null,
      isError: t.isError ?? null,
    })),
  }));
}

/** Save current chat messages to disk */
async function persistMessages() {
  const { currentChatId, messages } = useChatStore.getState();
  if (!currentChatId || messages.length === 0) return;
  try {
    await invoke("save_chat_messages", {
      chatId: currentChatId,
      messages: messagesToStored(messages),
    });
  } catch (e) {
    console.error("Failed to save messages:", e);
  }
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

/** Get a human-readable label for the current tool activity */
export function getToolLabel(activity: ToolActivity): string {
  return toolLabel(activity.toolName, activity.toolInput);
}

// ── Store ──

export const useChatStore = create<ChatState>((set, get) => ({
  agentId: "",
  projectPath: "",
  projectName: "Workspace",
  chatList: [],
  currentChatId: null,
  messages: [],
  hasSession: false,
  isThinking: false,
  currentToolActivity: null,
  error: null,

  init: async (agentId, projectPath, projectName) => {
    set({ agentId, projectPath, projectName });
    await get().loadChatList();
  },

  loadChatList: async () => {
    const { projectPath } = get();
    if (!projectPath) return;
    try {
      const list = await invoke<ChatMeta[]>("list_chats", { projectPath });
      set({ chatList: list });
    } catch (e) {
      console.error("Failed to load chat list:", e);
    }
  },

  sendMessage: async (text: string) => {
    const state = get();
    let chatId = state.currentChatId;

    // Add user message immediately
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      timestamp: Date.now(),
    };
    set({ messages: [...state.messages, userMsg], error: null, isThinking: true });

    try {
      // Lazy chat creation: create on first message
      if (!chatId) {
        const title = generateTitle(text);
        const chat = await invoke<ChatMeta>("create_chat", {
          projectPath: state.projectPath,
          agentId: state.agentId,
          title,
        });
        chatId = chat.id;
        set({ currentChatId: chatId });
        // Update chat lock
        useAgentStore.getState().updateChatLock(state.agentId, chatId);
        // Refresh sidebar
        get().loadChatList().catch(console.error);
      }

      if (state.hasSession) {
        // Existing live CLI process — send follow-up
        await invoke("send_message", {
          options: { agentId: state.agentId, prompt: text } satisfies SendMessageOptions,
        });
      } else {
        // Find if this chat has a session to resume
        const chatMeta = get().chatList.find((c) => c.id === chatId);
        const resumeSessionId = chatMeta?.sessionId ?? undefined;

        await invoke("start_session", {
          options: {
            agentId: state.agentId,
            prompt: text,
            projectPath: state.projectPath,
            resumeSessionId,
          } satisfies StartSessionOptions,
        });
      }
    } catch (e) {
      set({ error: String(e), isThinking: false });
    }
  },

  stopGeneration: async () => {
    const { agentId } = get();
    try {
      await invoke("stop_session", { agentId });
    } catch (e) {
      set({ error: String(e) });
    }
    set({ isThinking: false, currentToolActivity: null });
  },

  switchChat: async (chatId: string) => {
    const state = get();
    if (state.isThinking) return; // LOCKED
    if (state.currentChatId === chatId) return;

    // Save current chat before switching
    await persistMessages();

    // Kill current CLI process if alive
    if (state.hasSession) {
      try {
        await invoke("stop_session", { agentId: state.agentId });
      } catch (e) {
        console.error("Failed to stop session:", e);
      }
    }

    // Load new chat from disk
    try {
      const chat = await invoke<{
        id: string;
        messages: Array<{
          id: string;
          role: string;
          text: string;
          timestamp: number;
          tools: Array<{
            toolUseId: string;
            toolName: string;
            toolInput: Record<string, unknown>;
            result?: string;
            isError?: boolean;
          }>;
        }>;
      }>("load_chat", { chatId });

      const messages: ChatMessage[] = chat.messages.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        text: m.text,
        timestamp: m.timestamp,
        isStreaming: false,
        tools: m.tools && m.tools.length > 0 ? m.tools : undefined,
      }));

      set({
        currentChatId: chatId,
        messages,
        hasSession: false,
        isThinking: false,
        currentToolActivity: null,
        error: null,
      });

      // Update chat lock in agentStore
      useAgentStore.getState().updateChatLock(get().agentId, chatId);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  newChat: async () => {
    const state = get();
    if (state.isThinking) return; // LOCKED

    // Save current chat before starting new
    await persistMessages();

    // Kill current CLI process if alive
    if (state.hasSession) {
      try {
        await invoke("stop_session", { agentId: state.agentId });
      } catch (e) {
        console.error("Failed to stop session:", e);
      }
    }

    set({
      currentChatId: null,
      messages: [],
      hasSession: false,
      isThinking: false,
      currentToolActivity: null,
      error: null,
    });

    // Clear chat lock
    useAgentStore.getState().updateChatLock(get().agentId, null);
  },

  deleteChat: async (chatId: string) => {
    const state = get();
    if (state.isThinking) return; // LOCKED

    try {
      await invoke("delete_chat", { chatId });

      // If deleting current chat, clear it
      if (state.currentChatId === chatId) {
        set({
          currentChatId: null,
          messages: [],
          hasSession: false,
          currentToolActivity: null,
          error: null,
        });
        useAgentStore.getState().updateChatLock(state.agentId, null);
      }

      // Refresh sidebar
      await get().loadChatList();
    } catch (e) {
      console.error("Failed to delete chat:", e);
    }
  },

  switchAgent: async (agentId, projectPath, projectName, savedChatId) => {
    const state = get();

    // Save current chat before switching
    await persistMessages();

    // Kill current CLI process if alive
    if (state.hasSession) {
      try {
        await invoke("stop_session", { agentId: state.agentId });
      } catch (e) {
        console.error("Failed to stop session on agent switch:", e);
      }
    }

    // Clear tool activity timer
    if (toolActivityTimer) {
      clearTimeout(toolActivityTimer);
      toolActivityTimer = null;
    }

    // Switch context
    set({
      agentId,
      projectPath,
      projectName,
      currentChatId: null,
      messages: [],
      chatList: [],
      hasSession: false,
      isThinking: false,
      currentToolActivity: null,
      error: null,
    });

    // Load chats for the new agent's project
    await get().loadChatList();

    // Restore saved chat position if available
    if (savedChatId) {
      const exists = get().chatList.some((c) => c.id === savedChatId);
      if (exists) {
        await get().switchChat(savedChatId);
      }
    }
  },
}));

// ── Module-level event listener (singleton, lives for app lifetime) ──

function handleCliEvent(e: CliEvent) {
  // Only process events for the currently active agent
  if (e.agent_id !== useChatStore.getState().agentId) return;

  const { getState: get, setState: set } = useChatStore;
  const state = get();

  switch (e.type) {
    case "sessionId": {
      set({ hasSession: true });
      // Save CLI session ID to chat on disk
      const chatId = state.currentChatId;
      if (chatId) {
        invoke("update_chat_session", { chatId, sessionId: e.session_id }).catch(console.error);
        // Update local chatList entry too
        const chatList = state.chatList.map((c) =>
          c.id === chatId ? { ...c, sessionId: e.session_id } : c,
        );
        set({ chatList });
      }
      break;
    }

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
      if (toolActivityTimer) {
        clearTimeout(toolActivityTimer);
        toolActivityTimer = null;
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
      set({ messages: msgs });
      // Delay clearing tool activity so it stays visible briefly
      if (toolActivityTimer) clearTimeout(toolActivityTimer);
      toolActivityTimer = setTimeout(() => {
        toolActivityTimer = null;
        if (get().currentToolActivity?.toolUseId === e.tool_use_id) {
          set({ currentToolActivity: null });
        }
      }, 1500);
      break;
    }

    case "turnComplete":
      set({ isThinking: false, currentToolActivity: null });
      {
        const msgs = [...state.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.isStreaming) {
          msgs[msgs.length - 1] = { ...last, isStreaming: false };
          set({ messages: msgs });
        }
      }
      // Save messages to disk after each complete turn
      persistMessages().catch(console.error);
      break;

    case "processExited":
      set({ hasSession: false, isThinking: false, currentToolActivity: null });
      {
        const msgs = [...state.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant" && last.isStreaming) {
          msgs[msgs.length - 1] = { ...last, isStreaming: false };
          set({ messages: msgs });
        }
      }
      // Save messages when process exits
      persistMessages().catch(console.error);
      break;

    case "error":
      set({ error: e.message, isThinking: false });
      break;
  }
}

listen<CliEvent>("cli-event", (event) => handleCliEvent(event.payload)).catch(
  console.error,
);
