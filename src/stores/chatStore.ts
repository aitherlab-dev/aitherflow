import { create } from "zustand";
import { invoke, listen } from "../lib/transport";
import type { CliEvent, StartSessionOptions, SendMessageOptions } from "../types/conductor";
import type { Attachment, ChatMessage, ToolActivity } from "../types/chat";
import type { AttachmentPayload } from "../types/conductor";
import { isInteractiveTool } from "../types/chat";
import { useAgentStore } from "./agentStore";
import { useConductorStore } from "./conductorStore";
import { useProjectStore } from "./projectStore";

/** Timer for delayed tool activity reset (keeps status visible briefly) */
let toolActivityTimer: ReturnType<typeof setTimeout> | null = null;

// ── Per-agent state map ──

/** State for each agent (active uses Zustand as truth, background uses this Map) */
interface AgentChatState {
  messages: ChatMessage[];
  streamingMessage: ChatMessage | null;
  chatId: string | null;
  hasSession: boolean;
  isThinking: boolean;
  planMode: boolean;
  currentToolActivity: ToolActivity | null;
  error: string | null;
}

/** Module-level map: stores state for ALL agents. Background agents updated directly by events, active agent snapshotted on switch. */
const agentStates = new Map<string, AgentChatState>();

/** Get or create a state entry for an agent */
function getOrCreateAgentState(agentId: string): AgentChatState {
  let state = agentStates.get(agentId);
  if (!state) {
    state = {
      messages: [],
      streamingMessage: null,
      chatId: null,
      hasSession: false,
      isThinking: false,
      planMode: false,
      currentToolActivity: null,
      error: null,
    };
    agentStates.set(agentId, state);
  }
  return state;
}

/** Tools that edit files and should be bridged to fileViewerStore */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

// ── Types ──

/** Chat metadata for sidebar listing (no messages) */
export interface ChatMeta {
  id: string;
  title: string;
  createdAt: number;
  sessionId: string | null;
  customTitle: string | null;
  pinned: boolean;
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
  streamingMessage: ChatMessage | null;
  hasSession: boolean;
  isThinking: boolean;
  planMode: boolean;
  currentToolActivity: ToolActivity | null;
  error: string | null;

  // Multi-agent
  thinkingAgentIds: string[];

  // Actions
  init: (agentId: string, projectPath: string, projectName: string) => Promise<void>;
  loadChatList: () => Promise<void>;
  sendMessage: (text: string, allAttachments?: Attachment[]) => Promise<void>;
  stopGeneration: () => Promise<void>;
  restartSession: () => Promise<void>;
  switchChat: (chatId: string) => Promise<void>;
  newChat: () => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
  renameChat: (chatId: string, customTitle: string) => Promise<void>;
  toggleChatPin: (chatId: string, pinned: boolean) => Promise<void>;
  switchAgent: (agentId: string, projectPath: string, projectName: string, savedChatId: string | null) => Promise<void>;
  respondToCard: (toolUseId: string, response: string) => Promise<void>;
  clearAgentState: (agentId: string) => void;
  switchPermissionMode: (mode: "default" | "plan") => Promise<void>;
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
  streamingMessage: null,
  hasSession: false,
  isThinking: false,
  planMode: false,
  currentToolActivity: null,
  error: null,
  thinkingAgentIds: [],

  init: async (agentId, projectPath, projectName) => {
    // Ensure Map entry exists for the initial agent
    getOrCreateAgentState(agentId);
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
        // Track last opened chat for welcome screen "Continue"
        useProjectStore.getState().setLastOpened(state.projectPath, chatId).catch(console.error);
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

        // Load settings to check permission mode and chrome
        let enableChrome = true;
        let settingsPermMode: string | undefined;
        try {
          const settings = await invoke<{ bypassPermissions: boolean; enableChrome: boolean }>("load_settings");
          if (settings.bypassPermissions) {
            settingsPermMode = "bypassPermissions";
          }
          enableChrome = settings.enableChrome;
        } catch (e) {
          console.error("Failed to load settings:", e);
        }

        // Get selected model, effort and permission mode from conductor store
        // bypassPermissions from settings overrides the UI toggle
        const { selectedModel, selectedEffort, selectedPermissionMode } = useConductorStore.getState();
        const permissionMode = settingsPermMode ?? (selectedPermissionMode !== "default" ? selectedPermissionMode : undefined);

        await invoke("start_session", {
          options: {
            agentId: state.agentId,
            prompt: text,
            projectPath: state.projectPath,
            model: selectedModel,
            effort: selectedEffort !== "high" ? selectedEffort : undefined,
            resumeSessionId,
            permissionMode,
            chrome: enableChrome,
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
    set({ isThinking: false, planMode: false, currentToolActivity: null });
  },

  restartSession: async () => {
    const { agentId, hasSession } = get();
    if (!hasSession) return;
    try {
      await invoke("stop_session", { agentId });
    } catch (e) {
      console.error("Failed to restart session:", e);
    }
    // processExited event will reset hasSession, isThinking, etc.
  },

  switchPermissionMode: async (mode: "default" | "plan") => {
    const conductor = useConductorStore.getState();
    conductor.setSelectedPermissionMode(mode);

    const { agentId, hasSession } = get();
    if (!hasSession) return;

    // Remember current session for resume
    const sessionId = conductor.sessionId;

    // Stop current session and wait for processExited to reset hasSession
    try {
      await invoke("stop_session", { agentId });
    } catch (e) {
      console.error("Failed to stop session for mode switch:", e);
    }

    // Wait for hasSession to become false (processExited), max 2s
    for (let i = 0; i < 20 && get().hasSession; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // Restart with resume and new permission mode
    const state = get();
    let enableChrome = true;
    try {
      const settings = await invoke<{ enableChrome: boolean }>("load_settings");
      enableChrome = settings.enableChrome;
    } catch { /* use default */ }

    const permissionMode = mode !== "default" ? mode : undefined;

    set({ planMode: mode === "plan" });

    try {
      await invoke("start_session", {
        options: {
          agentId: state.agentId,
          prompt: "",
          projectPath: state.projectPath,
          model: conductor.selectedModel,
          effort: conductor.selectedEffort !== "high" ? conductor.selectedEffort : undefined,
          resumeSessionId: sessionId ?? undefined,
          permissionMode,
          chrome: enableChrome,
        } satisfies StartSessionOptions,
      });
      // Session resumed — mark as alive (no message sent, so no "thinking")
      set({ hasSession: true });
    } catch (e) {
      set({ error: String(e) });
    }
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
        planMode: false,
        currentToolActivity: null,
        error: null,
      });

      // Update chat lock in agentStore
      useAgentStore.getState().updateChatLock(get().agentId, chatId);

      // Track last opened chat for welcome screen "Continue"
      useProjectStore.getState().setLastOpened(get().projectPath, chatId).catch(console.error);

      // Load saved usage from CLI session JSONL (so context indicator works before new messages)
      const chatMeta = get().chatList.find((c) => c.id === chatId);
      if (chatMeta?.sessionId) {
        useConductorStore
          .getState()
          .loadSavedUsage(chatMeta.sessionId, get().projectPath)
          .catch(console.error);
      } else {
        // No session — reset usage
        useConductorStore.getState().restoreUsageForAgent(get().agentId);
      }
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
      planMode: false,
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

  renameChat: async (chatId: string, customTitle: string) => {
    try {
      await invoke("rename_chat", { chatId, customTitle });
      // Update locally without full reload
      const chatList = get().chatList.map((c) =>
        c.id === chatId ? { ...c, customTitle: customTitle.trim() || null } : c,
      );
      set({ chatList });
    } catch (e) {
      console.error("Failed to rename chat:", e);
    }
  },

  toggleChatPin: async (chatId: string, pinned: boolean) => {
    try {
      await invoke("toggle_chat_pin", { chatId, pinned });
      // Reload list because sort order changes
      await get().loadChatList();
    } catch (e) {
      console.error("Failed to toggle chat pin:", e);
    }
  },

  switchAgent: async (agentId, projectPath, projectName, savedChatId) => {
    const state = get();

    // Save current chat before switching
    await persistMessages();

    // Snapshot current Zustand state → Map for the outgoing agent
    agentStates.set(state.agentId, {
      messages: state.messages,
      streamingMessage: state.streamingMessage,
      chatId: state.currentChatId,
      hasSession: state.hasSession,
      isThinking: state.isThinking,
      planMode: state.planMode,
      currentToolActivity: state.currentToolActivity,
      error: state.error,
    });

    // Save usage data for outgoing agent
    useConductorStore.getState().saveUsageForAgent(state.agentId);

    // Clear tool activity timer
    if (toolActivityTimer) {
      clearTimeout(toolActivityTimer);
      toolActivityTimer = null;
    }

    // Cancel any pending stream RAF
    cancelStreamRaf();

    // Clear file viewer on agent switch
    import("./fileViewerStore").then(({ useFileViewerStore }) => {
      useFileViewerStore.getState().clearAll();
    }).catch(console.error);

    // Restore incoming agent from Map (or start fresh)
    const target = agentStates.get(agentId);
    if (target) {
      set({
        agentId,
        projectPath,
        projectName,
        currentChatId: target.chatId,
        messages: target.messages,
        streamingMessage: target.streamingMessage,
        chatList: [],
        hasSession: target.hasSession,
        isThinking: target.isThinking,
        planMode: target.planMode,
        currentToolActivity: target.currentToolActivity,
        error: null,
      });

      // Load chats for sidebar
      await get().loadChatList();
    } else {
      // No saved state — fresh agent
      set({
        agentId,
        projectPath,
        projectName,
        currentChatId: null,
        messages: [],
        streamingMessage: null,
        chatList: [],
        hasSession: false,
        isThinking: false,
        planMode: false,
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
    }

    // Restore usage data for incoming agent
    useConductorStore.getState().restoreUsageForAgent(agentId);

    // Update thinking indicators
    syncThinkingIds();
  },

  clearAgentState: (agentId: string) => {
    agentStates.delete(agentId);
    const ids = get().thinkingAgentIds.filter((id) => id !== agentId);
    if (ids.length !== get().thinkingAgentIds.length) {
      set({ thinkingAgentIds: ids });
    }
  },

  respondToCard: async (toolUseId: string, response: string) => {
    const state = get();

    // Find the tool and its requestId
    let requestId: string | undefined;
    let toolName: string | undefined;
    let toolInput: Record<string, unknown> | undefined;
    const msgs = [...state.messages];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role === "assistant" && msg.tools?.some((t) => t.toolUseId === toolUseId)) {
        const tools = msg.tools.map((t) => {
          if (t.toolUseId === toolUseId) {
            requestId = t.requestId;
            toolName = t.toolName;
            toolInput = t.toolInput;
            return { ...t, userResponse: response };
          }
          return t;
        });
        msgs[i] = { ...msg, tools };
        break;
      }
    }
    set({ messages: msgs, isThinking: true });

    if (!requestId) {
      // Fallback: CLI didn't send control_request (e.g. permissive mode) — send as text
      try {
        await invoke("send_message", {
          options: { agentId: state.agentId, prompt: response } satisfies SendMessageOptions,
        });
      } catch (e) {
        set({ error: String(e), isThinking: false });
      }
      return;
    }

    // Build control_response payload
    let controlResponse: Record<string, unknown>;
    if (response.startsWith("__deny__")) {
      const reason = response.slice(8).trim() || "User declined";
      controlResponse = { error: reason };
    } else if (toolName === "AskUserQuestion") {
      // Build updatedInput with answers
      const input = toolInput as { questions?: Array<{ question: string }> } | undefined;
      const questions = input?.questions ?? [];
      const answers: Record<string, string> = {};
      if (questions.length > 0) {
        answers[questions[0].question] = response;
      }
      controlResponse = {
        behavior: "allow",
        updatedInput: { ...input, answers },
      };
    } else {
      // ExitPlanMode and other tools — simple allow
      controlResponse = { behavior: "allow" };
    }

    try {
      await invoke("respond_to_tool", {
        agentId: state.agentId,
        requestId,
        response: controlResponse,
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
  const existing = get().streamingMessage;

  if (!isNew && existing) {
    set({ streamingMessage: { ...existing, text }, isThinking: true });
  } else if (isNew) {
    set({
      streamingMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        text,
        timestamp: Date.now(),
        isStreaming: true,
        tools: [],
      },
      isThinking: true,
    });
  }
}

function cancelStreamRaf() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  streamBuffer = null;
  streamBufferIsNew = false;
}

/** Save agent messages to disk (works for both active and background agents) */
async function persistAgentMessages(agentId: string) {
  const isActive = agentId === useChatStore.getState().agentId;
  const messages = isActive
    ? useChatStore.getState().messages
    : agentStates.get(agentId)?.messages ?? [];
  const chatId = isActive
    ? useChatStore.getState().currentChatId
    : agentStates.get(agentId)?.chatId ?? null;

  if (!chatId || messages.length === 0) return;
  try {
    await invoke("save_chat_messages", {
      chatId,
      messages: messagesToStored(messages),
    });
  } catch (e) {
    console.error("Failed to save agent messages:", e);
  }
}

/** Update thinkingAgentIds — collects isThinking from active agent + all background agents in Map */
function syncThinkingIds() {
  const { getState: get, setState: set } = useChatStore;
  const activeId = get().agentId;
  const ids: string[] = [];

  // Active agent
  if (get().isThinking) ids.push(activeId);

  // Background agents from Map
  for (const [agentId, state] of agentStates) {
    if (agentId !== activeId && state.isThinking) {
      ids.push(agentId);
    }
  }

  // Only update if changed
  const current = get().thinkingAgentIds;
  if (ids.length !== current.length || ids.some((id, i) => id !== current[i])) {
    set({ thinkingAgentIds: ids });
  }
}

/** Process CLI events for background agents (updates Map directly, no Zustand reactivity) */
function processBackgroundEvent(agentState: AgentChatState, e: CliEvent) {
  switch (e.type) {
    case "sessionId":
      agentState.hasSession = true;
      break;

    case "streamChunk": {
      const sm = agentState.streamingMessage;
      if (sm) {
        agentState.streamingMessage = { ...sm, text: e.text };
      } else {
        agentState.streamingMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: e.text,
          timestamp: Date.now(),
          isStreaming: true,
          tools: [],
        };
      }
      break;
    }

    case "messageComplete": {
      const sm = agentState.streamingMessage;
      const completed: ChatMessage = sm
        ? { ...sm, text: e.text, isStreaming: false }
        : { id: crypto.randomUUID(), role: "assistant", text: e.text, timestamp: Date.now(), isStreaming: false };
      agentState.messages = [...agentState.messages, completed];
      agentState.streamingMessage = null;
      break;
    }

    case "toolUse": {
      const activity: ToolActivity = {
        toolUseId: e.tool_use_id,
        toolName: e.tool_name,
        toolInput: e.tool_input,
      };
      let sm = agentState.streamingMessage;
      if (sm) {
        const existing = sm.tools ?? [];
        if (existing.some((t) => t.toolUseId === activity.toolUseId)) break;
        agentState.streamingMessage = { ...sm, tools: [...existing, activity] };
      } else {
        agentState.streamingMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "",
          timestamp: Date.now(),
          isStreaming: true,
          tools: [activity],
        };
      }

      // Track plan mode transitions
      if (e.tool_name === "EnterPlanMode") agentState.planMode = true;
      if (e.tool_name === "ExitPlanMode") agentState.planMode = false;
      break;
    }

    case "toolResult": {
      const sm = agentState.streamingMessage;
      if (sm?.tools) {
        const tools = sm.tools.map((t) =>
          t.toolUseId === e.tool_use_id
            ? { ...t, result: e.output_preview, isError: e.is_error }
            : t,
        );
        agentState.streamingMessage = { ...sm, tools };
      }
      break;
    }

    case "controlRequest": {
      const sm = agentState.streamingMessage;
      if (sm?.tools?.some((t) => t.toolUseId === e.tool_use_id)) {
        const tools = sm.tools.map((t) =>
          t.toolUseId === e.tool_use_id ? { ...t, requestId: e.request_id } : t,
        );
        agentState.streamingMessage = { ...sm, tools };
      } else {
        // Tool already merged into messages (interactive tools)
        const msgs = [...agentState.messages];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i];
          if (msg.role === "assistant" && msg.tools?.some((t) => t.toolUseId === e.tool_use_id)) {
            const tools = msg.tools.map((t) =>
              t.toolUseId === e.tool_use_id ? { ...t, requestId: e.request_id } : t,
            );
            msgs[i] = { ...msg, tools };
            agentState.messages = msgs;
            break;
          }
        }
      }
      break;
    }

    case "turnComplete": {
      agentState.isThinking = false;
      agentState.currentToolActivity = null;
      if (agentState.streamingMessage) {
        agentState.messages = [...agentState.messages, { ...agentState.streamingMessage, isStreaming: false }];
        agentState.streamingMessage = null;
      }
      persistAgentMessages(e.agent_id).catch(console.error);
      break;
    }

    case "processExited": {
      agentState.hasSession = false;
      agentState.isThinking = false;
      agentState.currentToolActivity = null;
      if (agentState.streamingMessage) {
        agentState.messages = [...agentState.messages, { ...agentState.streamingMessage, isStreaming: false }];
        agentState.streamingMessage = null;
      }
      persistAgentMessages(e.agent_id).catch(console.error);
      break;
    }

    case "error":
      agentState.isThinking = false;
      agentState.error = e.message;
      break;
  }
}

// ── Single event handler for ALL agents ──

function handleCliEvent(e: CliEvent) {
  const isActive = e.agent_id === useChatStore.getState().agentId;

  // Background agent → update Map directly
  if (!isActive) {
    const agentState = agentStates.get(e.agent_id);
    if (!agentState) return;
    const wasThinking = agentState.isThinking;
    processBackgroundEvent(agentState, e);
    // Sync thinking indicator if changed
    if (wasThinking !== agentState.isThinking) syncThinkingIds();
    return;
  }

  // Active agent → update Zustand (same as before)
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
      const isNew = !state.streamingMessage;
      streamBuffer = e.text;
      if (isNew) streamBufferIsNew = true;
      if (rafId === null) {
        rafId = requestAnimationFrame(flushStreamBuffer);
      }
      break;
    }

    case "messageComplete": {
      cancelStreamRaf();
      const sm = state.streamingMessage;
      const completed: ChatMessage = sm
        ? { ...sm, text: e.text, isStreaming: false }
        : {
            id: crypto.randomUUID(),
            role: "assistant",
            text: e.text,
            timestamp: Date.now(),
            isStreaming: false,
          };
      set((prev) => ({ messages: [...prev.messages, completed], streamingMessage: null }));
      break;
    }

    case "toolUse": {
      const activity: ToolActivity = {
        toolUseId: e.tool_use_id,
        toolName: e.tool_name,
        toolInput: e.tool_input,
      };

      // Add tool to streamingMessage
      let sm = state.streamingMessage;
      if (sm) {
        const existing = sm.tools ?? [];
        if (existing.some((t) => t.toolUseId === activity.toolUseId)) break;
        sm = { ...sm, tools: [...existing, activity] };
      } else {
        sm = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "",
          timestamp: Date.now(),
          isStreaming: true,
          tools: [activity],
        };
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

      // Track plan mode transitions (sync button state with CLI)
      if (e.tool_name === "EnterPlanMode") {
        set({ planMode: true });
        useConductorStore.getState().setSelectedPermissionMode("plan");
      }
      if (e.tool_name === "ExitPlanMode") {
        set({ planMode: false });
        useConductorStore.getState().setSelectedPermissionMode("default");
      }

      // Interactive tools (AskUserQuestion, ExitPlanMode) don't show as "running" status
      if (!isInteractiveTool(e.tool_name)) {
        if (toolActivityTimer) {
          clearTimeout(toolActivityTimer);
          toolActivityTimer = null;
        }
        set({ streamingMessage: sm, currentToolActivity: activity });
      } else {
        // CLI is paused waiting for user input — merge into messages so cards render
        set((prev) => ({
          messages: [...prev.messages, { ...sm, isStreaming: false }],
          streamingMessage: null,
          isThinking: false,
        }));
        syncThinkingIds();
      }
      break;
    }

    case "toolResult": {
      // Update tool result in streamingMessage
      const sm = state.streamingMessage;
      if (sm?.tools) {
        const tools = sm.tools.map((t) =>
          t.toolUseId === e.tool_use_id
            ? { ...t, result: e.output_preview, isError: e.is_error }
            : t,
        );
        set({ streamingMessage: { ...sm, tools } });
      }

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

    case "controlRequest": {
      // CLI is asking for permission or user input — store request_id on the matching tool
      const sm = state.streamingMessage;
      if (sm?.tools?.some((t) => t.toolUseId === e.tool_use_id)) {
        const tools = sm.tools.map((t) =>
          t.toolUseId === e.tool_use_id ? { ...t, requestId: e.request_id } : t,
        );
        set({ streamingMessage: { ...sm, tools } });
      } else {
        set((prev) => {
          const msgs = [...prev.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            if (msg.role === "assistant" && msg.tools?.some((t) => t.toolUseId === e.tool_use_id)) {
              const tools = msg.tools.map((t) =>
                t.toolUseId === e.tool_use_id ? { ...t, requestId: e.request_id } : t,
              );
              msgs[i] = { ...msg, tools };
              return { messages: msgs };
            }
          }
          return {};
        });
      }
      break;
    }

    case "turnComplete": {
      cancelStreamRaf();
      set((prev) => {
        const msgs = prev.streamingMessage
          ? [...prev.messages, { ...prev.streamingMessage, isStreaming: false }]
          : prev.messages;
        return { messages: msgs, streamingMessage: null, isThinking: false, currentToolActivity: null };
      });
      // Save messages to disk after each complete turn
      persistMessages().catch(console.error);
      syncThinkingIds();
      break;
    }

    case "processExited": {
      cancelStreamRaf();
      set((prev) => {
        const msgs = prev.streamingMessage
          ? [...prev.messages, { ...prev.streamingMessage, isStreaming: false }]
          : prev.messages;
        return { messages: msgs, streamingMessage: null, hasSession: false, isThinking: false, planMode: false, currentToolActivity: null };
      });
      // Save messages when process exits
      persistMessages().catch(console.error);
      syncThinkingIds();
      break;
    }

    case "error":
      set({ error: e.message, isThinking: false });
      syncThinkingIds();
      break;
  }
}

listen<CliEvent>("cli-event", (event) => handleCliEvent(event.payload)).catch(
  console.error,
);

// ── Derived selectors (memoized outside components) ──

/** All tool activities across messages + streaming message. Use with useShallow. */
export function selectToolActivities(s: ChatState): ToolActivity[] {
  const all: ToolActivity[] = [];
  for (const msg of s.messages) {
    if (msg.tools) for (const t of msg.tools) all.push(t);
  }
  if (s.streamingMessage?.tools) {
    for (const t of s.streamingMessage.tools) all.push(t);
  }
  return all;
}

/** Total tool count across all messages + streaming. */
export function selectToolCount(s: ChatState): number {
  let count = 0;
  for (const msg of s.messages) {
    if (msg.tools) count += msg.tools.length;
  }
  if (s.streamingMessage?.tools) count += s.streamingMessage.tools.length;
  return count;
}

/** Last 2 tool activities from the latest assistant message (for InputBar). */
export function selectRecentTools(s: ChatState): ToolActivity[] {
  if (!s.isThinking) return [];
  // Check streaming message first
  if (s.streamingMessage?.role === "assistant" && s.streamingMessage.tools && s.streamingMessage.tools.length > 0) {
    return s.streamingMessage.tools.slice(-2);
  }
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const msg = s.messages[i];
    if (msg.role === "assistant" && msg.tools && msg.tools.length > 0) {
      return msg.tools.slice(-2);
    }
  }
  return [];
}
