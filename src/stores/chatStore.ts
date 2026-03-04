import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CliEvent, StartSessionOptions, SendMessageOptions } from "../types/conductor";
import type { Attachment, ChatMessage, ToolActivity } from "../types/chat";
import type { AttachmentPayload } from "../types/conductor";
import { isInteractiveTool } from "../types/chat";
import { useAgentStore } from "./agentStore";
import { useConductorStore } from "./conductorStore";

/** Timer for delayed tool activity reset (keeps status visible briefly) */
let toolActivityTimer: ReturnType<typeof setTimeout> | null = null;

/** Tools that edit files and should be bridged to fileViewerStore */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

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
  sendMessage: (text: string, allAttachments?: Attachment[]) => Promise<void>;
  stopGeneration: () => Promise<void>;
  switchChat: (chatId: string) => Promise<void>;
  newChat: () => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  switchAgent: (agentId: string, projectPath: string, projectName: string, savedChatId: string | null) => Promise<void>;
  respondToCard: (toolUseId: string, response: string) => Promise<void>;
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
      userResponse: t.userResponse ?? null,
    })),
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      content: a.content,
      size: a.size,
      fileType: a.fileType,
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
    case "AskUserQuestion":
      return "Asking question";
    case "ExitPlanMode":
      return "Awaiting plan approval";
    default:
      return toolName;
  }
}

/** Get a human-readable label for the current tool activity */
export function getToolLabel(activity: ToolActivity): string {
  return toolLabel(activity.toolName, activity.toolInput);
}

/** Longer summary for Agent Log cards (path, command, query) */
export function summarizeToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  const filePath = typeof toolInput.file_path === "string"
    ? toolInput.file_path
    : typeof toolInput.path === "string"
      ? toolInput.path
      : null;

  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
    case "NotebookRead":
      return filePath ?? "";
    case "Bash": {
      const cmd = typeof toolInput.command === "string" ? toolInput.command : "";
      return cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
    }
    case "Glob":
      return typeof toolInput.pattern === "string" ? toolInput.pattern : "";
    case "Grep":
      return typeof toolInput.pattern === "string" ? toolInput.pattern : "";
    case "WebSearch":
      return typeof toolInput.query === "string" ? toolInput.query : "";
    case "WebFetch":
      return typeof toolInput.url === "string" ? toolInput.url : "";
    case "TodoWrite":
      return "Updating tasks";
    case "Task":
    case "Agent":
      return typeof toolInput.description === "string" ? toolInput.description : "Running subagent";
    default:
      return "";
  }
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

  sendMessage: async (text: string, allAttachments?: Attachment[]) => {
    const state = get();
    let chatId = state.currentChatId;

    // Auto-accept all pending diffs when user sends a new message
    import("./fileViewerStore").then(({ useFileViewerStore }) => {
      useFileViewerStore.getState().acceptAllPending();
    }).catch(console.error);

    // Add user message immediately (with all attachments for display)
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      timestamp: Date.now(),
      attachments: allAttachments && allAttachments.length > 0 ? allAttachments : undefined,
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

      // Convert image attachments to payload format for Rust (text is already in prompt)
      const imageAtts = allAttachments?.filter((a) => a.fileType === "image");
      const attachmentPayloads: AttachmentPayload[] | undefined =
        imageAtts && imageAtts.length > 0
          ? imageAtts.map((a) => ({
              name: a.name,
              content: a.content,
              fileType: a.fileType,
            }))
          : undefined;

      if (state.hasSession) {
        // Existing live CLI process — send follow-up
        await invoke("send_message", {
          options: {
            agentId: state.agentId,
            prompt: text,
            attachments: attachmentPayloads,
          } satisfies SendMessageOptions,
        });
      } else {
        // Find if this chat has a session to resume
        const chatMeta = get().chatList.find((c) => c.id === chatId);
        const resumeSessionId = chatMeta?.sessionId ?? undefined;

        // Load settings to check permission mode
        let permissionMode: string | undefined;
        try {
          const settings = await invoke<{ bypassPermissions: boolean }>("load_settings");
          if (settings.bypassPermissions) {
            permissionMode = "bypassPermissions";
          }
        } catch (e) {
          console.error("Failed to load settings:", e);
        }

        // Get selected model and effort from conductor store
        const { selectedModel, selectedEffort } = useConductorStore.getState();

        await invoke("start_session", {
          options: {
            agentId: state.agentId,
            prompt: text,
            projectPath: state.projectPath,
            model: selectedModel,
            effort: selectedEffort !== "high" ? selectedEffort : undefined,
            resumeSessionId,
            permissionMode,
            attachments: attachmentPayloads,
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
            userResponse?: string;
          }>;
          attachments?: Array<{
            id: string;
            name: string;
            content: string;
            size: number;
            fileType: string;
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
        attachments: m.attachments && m.attachments.length > 0
          ? m.attachments.map((a) => ({
              id: a.id,
              name: a.name,
              content: a.content,
              size: a.size,
              fileType: a.fileType as "image" | "text",
            }))
          : undefined,
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

    // Clear file viewer on agent switch
    import("./fileViewerStore").then(({ useFileViewerStore }) => {
      useFileViewerStore.getState().clearAll();
    }).catch(console.error);

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

  respondToCard: async (toolUseId: string, response: string) => {
    const state = get();

    // Mark the tool as answered (search all messages, not just the last one)
    const msgs = [...state.messages];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role === "assistant" && msg.tools?.some((t) => t.toolUseId === toolUseId)) {
        const tools = msg.tools.map((t) =>
          t.toolUseId === toolUseId ? { ...t, userResponse: response } : t,
        );
        msgs[i] = { ...msg, tools };
        break;
      }
    }
    set({ messages: msgs, isThinking: true });

    // Send response to CLI via stdin
    try {
      await invoke("send_message", {
        options: { agentId: state.agentId, prompt: response } satisfies SendMessageOptions,
      });
    } catch (e) {
      set({ error: String(e), isThinking: false });
    }
  },
}));

// ── Module-level event listener (singleton, lives for app lifetime) ──

// RAF batching for stream chunks: buffer latest text, flush at ~60fps
let streamBuffer: string | null = null;
let streamBufferIsNew = false; // true when buffer holds first chunk (no existing streaming msg)
let rafId: number | null = null;

function flushStreamBuffer() {
  rafId = null;
  if (streamBuffer === null) return;

  const text = streamBuffer;
  const isNew = streamBufferIsNew;
  streamBuffer = null;
  streamBufferIsNew = false;

  const { getState: get, setState: set } = useChatStore;
  const state = get();
  const msgs = [...state.messages];
  const last = msgs[msgs.length - 1];

  if (!isNew && last && last.role === "assistant" && last.isStreaming) {
    msgs[msgs.length - 1] = { ...last, text };
  } else if (isNew) {
    msgs.push({
      id: crypto.randomUUID(),
      role: "assistant",
      text,
      timestamp: Date.now(),
      isStreaming: true,
      tools: [],
    });
  }
  set({ messages: msgs, isThinking: true });
}

function cancelStreamRaf() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  streamBuffer = null;
  streamBufferIsNew = false;
}

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
      const last = state.messages[state.messages.length - 1];
      const isNew = !(last && last.role === "assistant" && last.isStreaming);
      streamBuffer = e.text;
      if (isNew) streamBufferIsNew = true;
      if (rafId === null) {
        rafId = requestAnimationFrame(flushStreamBuffer);
      }
      break;
    }

    case "messageComplete": {
      cancelStreamRaf();
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
        const existing = last.tools ?? [];
        if (existing.some((t) => t.toolUseId === activity.toolUseId)) break;
        const tools = [...existing, activity];
        msgs[msgs.length - 1] = { ...last, tools };
      } else {
        msgs.push({
          id: crypto.randomUUID(),
          role: "assistant",
          text: "",
          timestamp: Date.now(),
          isStreaming: true,
          tools: [activity],
        });
      }

      // Bridge to file viewer for file-editing tools
      if (FILE_EDIT_TOOLS.has(e.tool_name)) {
        import("./fileViewerStore").then(({ useFileViewerStore }) => {
          useFileViewerStore
            .getState()
            .addDiffFromToolUse(e.tool_use_id, e.tool_name, e.tool_input)
            .catch(console.error);
        }).catch(console.error);
      }
      // Open preview for Read tool
      if (e.tool_name === "Read") {
        const filePath =
          typeof e.tool_input.file_path === "string"
            ? e.tool_input.file_path
            : typeof e.tool_input.path === "string"
              ? e.tool_input.path
              : null;
        if (filePath) {
          import("./fileViewerStore").then(({ useFileViewerStore }) => {
            useFileViewerStore
              .getState()
              .openPreview(filePath)
              .catch(console.error);
          }).catch(console.error);
        }
      }

      // Interactive tools (AskUserQuestion, ExitPlanMode) don't show as "running" status
      if (!isInteractiveTool(e.tool_name)) {
        if (toolActivityTimer) {
          clearTimeout(toolActivityTimer);
          toolActivityTimer = null;
        }
        set({ messages: msgs, currentToolActivity: activity });
      } else {
        // CLI is paused waiting for user input — stop streaming so cards render
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "assistant" && lastMsg.isStreaming) {
          msgs[msgs.length - 1] = { ...lastMsg, isStreaming: false };
        }

        // Auto-approve ExitPlanMode (workaround for CLI bug #16712 —
        // can't send tool_result, so CLI hangs waiting. Auto-send "yes"
        // and show card as already approved. Remove when #16712 is fixed.)
        if (e.tool_name === "ExitPlanMode") {
          // Mark as auto-approved in the message
          const lm = msgs[msgs.length - 1];
          if (lm && lm.role === "assistant" && lm.tools) {
            const tools = lm.tools.map((t) =>
              t.toolUseId === e.tool_use_id ? { ...t, userResponse: "Auto-approved" } : t,
            );
            msgs[msgs.length - 1] = { ...lm, tools };
          }
          set({ messages: msgs, isThinking: true });
          // Send "yes" to CLI
          invoke("send_message", {
            options: { agentId: state.agentId, prompt: "yes" } satisfies SendMessageOptions,
          }).catch(console.error);
        } else {
          set({ messages: msgs, isThinking: false });
        }
      }
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

      // Refresh file viewer after file-editing tool completes
      import("./fileViewerStore").then(({ useFileViewerStore }) => {
        useFileViewerStore
          .getState()
          .refreshAfterToolResult(e.tool_use_id)
          .catch(console.error);
      }).catch(console.error);
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
      cancelStreamRaf();
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
      cancelStreamRaf();
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
