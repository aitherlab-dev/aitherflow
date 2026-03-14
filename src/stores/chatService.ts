/**
 * Chat business logic — standalone functions that orchestrate
 * chatStore state, CLI invocations, and cross-store coordination.
 */

import { invoke } from "../lib/transport";
import type { StartSessionOptions, SendMessageOptions } from "../types/conductor";
import { toFileType } from "../types/chat";
import type { Attachment, ChatMessage } from "../types/chat";
import type { AttachmentPayload } from "../types/conductor";
import {
  useChatStore,
  agentStates,
  messagesToStored,
  type ChatMeta,
} from "./chatStore";
import { useAgentStore } from "./agentStore";
import { useConductorStore } from "./conductorStore";
import { useProjectStore } from "./projectStore";
import { cancelStreamRaf, clearToolActivityTimer, syncThinkingIds } from "./chatStreamHandler";

// Cached settings to avoid re-reading on every new session
let cachedSettings: { bypassPermissions: boolean; enableChrome: boolean } | null = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 10_000; // 10 seconds

async function getSettings() {
  if (!cachedSettings || Date.now() - settingsCacheTime > SETTINGS_CACHE_TTL) {
    cachedSettings = await invoke<{ bypassPermissions: boolean; enableChrome: boolean }>("load_settings");
    settingsCacheTime = Date.now();
  }
  return cachedSettings;
}

// ── Helpers ──

/** Guard to prevent duplicate chat creation on double-click Send */
let isCreatingChat = false;

function generateTitle(text: string): string {
  const max = 30;
  const singleLine = text.replace(/\n/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  const truncated = singleLine.slice(0, max);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

export async function persistMessages() {
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

// ── Actions ──

export async function loadChatList() {
  const { projectPath } = useChatStore.getState();
  if (!projectPath) return;
  try {
    const list = await invoke<ChatMeta[]>("list_chats", { projectPath });
    useChatStore.setState({ chatList: list });
  } catch (e) {
    console.error("Failed to load chat list:", e);
  }
}

export async function sendMessage(text: string, allAttachments?: Attachment[]) {
  const state = useChatStore.getState();
  let chatId = state.currentChatId;

  // Auto-accept all pending diffs when user sends a new message
  import("./fileViewerStore").then(({ useFileViewerStore }) => {
    useFileViewerStore.getState().acceptAllPending();
  }).catch(console.error);

  // Guard against double-click during chat creation
  if (!chatId && isCreatingChat) return;

  // Add user message immediately
  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    text,
    timestamp: Date.now(),
    attachments: allAttachments && allAttachments.length > 0 ? allAttachments : undefined,
  };
  useChatStore.setState({ messages: [...state.messages, userMsg], error: null, isThinking: true });

  try {
    // Lazy chat creation: create on first message (guard against double-click)
    if (!chatId) {
      isCreatingChat = true;
      try {
        const title = generateTitle(text);
        const chat = await invoke<ChatMeta>("create_chat", {
          projectPath: state.projectPath,
          agentId: state.agentId,
          title,
        });
        chatId = chat.id;
        useChatStore.setState({ currentChatId: chatId });
        useAgentStore.getState().updateChatLock(state.agentId, chatId);
        useProjectStore.getState().setLastOpened(state.projectPath, chatId).catch(console.error);
        loadChatList().catch(console.error);
      } finally {
        isCreatingChat = false;
      }
    }

    // Convert image attachments to payload format for Rust
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
      await invoke("send_message", {
        options: {
          agentId: state.agentId,
          prompt: text,
          attachments: attachmentPayloads,
        } satisfies SendMessageOptions,
      });
    } else {
      const chatMeta = useChatStore.getState().chatList.find((c) => c.id === chatId);
      const resumeSessionId = chatMeta?.sessionId ?? undefined;

      let enableChrome = true;
      let settingsPermMode: string | undefined;
      try {
        const settings = await getSettings();
        if (settings.bypassPermissions) {
          settingsPermMode = "bypassPermissions";
        }
        enableChrome = settings.enableChrome;
      } catch (e) {
        console.error("Failed to load settings:", e);
      }

      const { selectedModel, selectedEffort, selectedPermissionMode } = useConductorStore.getState();
      const permissionMode = settingsPermMode ?? (selectedPermissionMode !== "default" ? selectedPermissionMode : undefined);

      // If this agent belongs to a team, pass teamId so the backend
      // creates MCP config and registers the agent in the teamwork server.
      const activeAgent = useAgentStore.getState().agents.find((a) => a.id === state.agentId);
      const teamId = activeAgent?.teamId;

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
          teamId,
        } satisfies StartSessionOptions,
      });
    }
  } catch (e) {
    useChatStore.setState({ error: String(e), isThinking: false });
  }
}

export async function stopGeneration() {
  const { agentId } = useChatStore.getState();
  try {
    await invoke("stop_session", { agentId });
  } catch (e) {
    useChatStore.setState({ error: String(e) });
  }
  useChatStore.setState({ isThinking: false, planMode: false, currentToolActivity: null });
}

export async function restartSession() {
  const { agentId, hasSession } = useChatStore.getState();
  if (!hasSession) return;
  try {
    await invoke("stop_session", { agentId });
  } catch (e) {
    console.error("Failed to restart session:", e);
  }
}

export async function switchPermissionMode(mode: "default" | "plan") {
  const conductor = useConductorStore.getState();
  conductor.setSelectedPermissionMode(mode);

  const { agentId, hasSession } = useChatStore.getState();
  if (!hasSession) return;

  const sessionId = conductor.sessionId;

  try {
    await invoke("stop_session", { agentId });
  } catch (e) {
    console.error("Failed to stop session for mode switch:", e);
  }

  // Wait for hasSession to become false (processExited), max 5s
  if (useChatStore.getState().hasSession) {
    await new Promise<void>((resolve) => {
      const unsub = useChatStore.subscribe((s) => {
        if (!s.hasSession) {
          clearTimeout(timeout);
          unsub();
          resolve();
        }
      });
      const timeout = setTimeout(() => {
        unsub();
        console.warn("[chatService] CLI process did not exit within 5s, force-clearing session state");
        useChatStore.setState({ hasSession: false });
        resolve();
      }, 5000);
    });
  }

  const state = useChatStore.getState();
  let enableChrome = true;
  try {
    const settings = await invoke<{ enableChrome: boolean }>("load_settings");
    enableChrome = settings.enableChrome;
  } catch { /* use default */ }

  const permissionMode = mode !== "default" ? mode : undefined;

  useChatStore.setState({ planMode: mode === "plan" });

  const permAgent = useAgentStore.getState().agents.find((a) => a.id === state.agentId);

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
        teamId: permAgent?.teamId,
      } satisfies StartSessionOptions,
    });
    useChatStore.setState({ hasSession: true });
  } catch (e) {
    useChatStore.setState({ error: String(e) });
  }
}

export async function switchChat(chatId: string) {
  const state = useChatStore.getState();
  if (state.currentChatId === chatId) return;

  if (state.isThinking) {
    useChatStore.setState({ isThinking: false, currentToolActivity: null });
  }

  await persistMessages();

  if (state.hasSession) {
    try {
      await invoke("stop_session", { agentId: state.agentId });
    } catch (e) {
      console.error("Failed to stop session:", e);
    }
  }

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
            fileType: toFileType(a.fileType),
          }))
        : undefined,
    }));

    useChatStore.setState({
      currentChatId: chatId,
      messages,
      hasSession: false,
      isThinking: false,
      planMode: false,
      currentToolActivity: null,
      toolCount: messages.reduce((n, m) => n + (m.tools?.length ?? 0), 0),
      error: null,
    });

    useAgentStore.getState().updateChatLock(useChatStore.getState().agentId, chatId);
    useProjectStore.getState().setLastOpened(useChatStore.getState().projectPath, chatId).catch(console.error);

    const chatMeta = useChatStore.getState().chatList.find((c) => c.id === chatId);
    if (chatMeta?.sessionId) {
      useConductorStore
        .getState()
        .loadSavedUsage(chatMeta.sessionId, useChatStore.getState().projectPath)
        .catch(console.error);
    } else {
      useConductorStore.getState().restoreUsageForAgent(useChatStore.getState().agentId);
    }
  } catch (e) {
    useChatStore.setState({ error: String(e) });
  }
}

export async function newChat() {
  const state = useChatStore.getState();
  if (state.isThinking) return;

  await persistMessages();

  if (state.hasSession) {
    try {
      await invoke("stop_session", { agentId: state.agentId });
    } catch (e) {
      console.error("Failed to stop session:", e);
    }
  }

  useChatStore.setState({
    currentChatId: null,
    messages: [],
    hasSession: false,
    isThinking: false,
    planMode: false,
    currentToolActivity: null,
    toolCount: 0,
    error: null,
  });

  useAgentStore.getState().updateChatLock(useChatStore.getState().agentId, null);
}

export async function deleteChat(chatId: string) {
  const state = useChatStore.getState();
  if (state.isThinking) return;

  try {
    await invoke("delete_chat", { chatId });

    if (state.currentChatId === chatId) {
      useChatStore.setState({
        currentChatId: null,
        messages: [],
        streamingMessage: null,
        hasSession: false,
        planMode: false,
        currentToolActivity: null,
        toolCount: 0,
        error: null,
      });
      useAgentStore.getState().updateChatLock(state.agentId, null);
    }

    await loadChatList();
  } catch (e) {
    console.error("Failed to delete chat:", e);
  }
}

export async function renameChat(chatId: string, customTitle: string) {
  try {
    await invoke("rename_chat", { chatId, customTitle });
    const chatList = useChatStore.getState().chatList.map((c) =>
      c.id === chatId ? { ...c, customTitle: customTitle.trim() || null } : c,
    );
    useChatStore.setState({ chatList });
  } catch (e) {
    console.error("Failed to rename chat:", e);
  }
}

export async function toggleChatPin(chatId: string, pinned: boolean) {
  try {
    await invoke("toggle_chat_pin", { chatId, pinned });
    await loadChatList();
  } catch (e) {
    console.error("Failed to toggle chat pin:", e);
  }
}

let switchAgentLock: Promise<void> | null = null;

export async function switchAgent(
  agentId: string,
  projectPath: string,
  projectName: string,
  savedChatId: string | null,
) {
  // Serialize concurrent switchAgent calls to prevent race conditions
  while (switchAgentLock) await switchAgentLock;
  let unlock: () => void;
  switchAgentLock = new Promise((r) => { unlock = r; });
  try {
    await switchAgentInner(agentId, projectPath, projectName, savedChatId);
  } catch (e) {
    console.error("[switchAgent] Failed:", e);
    throw e;
  } finally {
    unlock!();
    switchAgentLock = null;
  }
}

async function switchAgentInner(
  agentId: string,
  projectPath: string,
  projectName: string,
  savedChatId: string | null,
) {
  const state = useChatStore.getState();

  // Snapshot BEFORE any async work to prevent race with event handlers
  agentStates.set(state.agentId, {
    messages: state.messages,
    streamingMessage: state.streamingMessage,
    chatId: state.currentChatId,
    hasSession: state.hasSession,
    isThinking: state.isThinking,
    planMode: state.planMode,
    currentToolActivity: state.currentToolActivity,
    toolCount: state.toolCount,
    error: state.error,
  });

  await persistMessages();

  useConductorStore.getState().saveUsageForAgent(state.agentId);

  clearToolActivityTimer();
  cancelStreamRaf();

  // Reset telegram state on agent switch
  import("../services/telegramService").then(({ resetTelegramState }) => {
    resetTelegramState();
  }).catch(console.error);

  // Clear file viewer on agent switch
  import("./fileViewerStore").then(({ useFileViewerStore }) => {
    useFileViewerStore.getState().clearAll();
  }).catch(console.error);

  // Restore incoming agent from Map (or start fresh)
  const target = agentStates.get(agentId);
  if (target) {
    useChatStore.setState({
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
      toolCount: target.messages.reduce((n: number, m: ChatMessage) => n + (m.tools?.length ?? 0), 0),
      error: null,
    });

    await loadChatList();
  } else {
    useChatStore.setState({
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
      toolCount: 0,
      error: null,
    });

    await loadChatList();

    if (savedChatId) {
      const exists = useChatStore.getState().chatList.some((c) => c.id === savedChatId);
      if (exists) {
        await switchChat(savedChatId);
      }
    }
  }

  useConductorStore.getState().restoreUsageForAgent(agentId);
  syncThinkingIds();
}

export function clearAgentState(agentId: string) {
  // Save background agent messages before discarding state
  const state = agentStates.get(agentId);
  if (state?.chatId && state.messages.length > 0) {
    invoke("save_chat_messages", {
      chatId: state.chatId,
      messages: messagesToStored(state.messages),
    }).catch(console.error);
  }
  agentStates.delete(agentId);
  const { thinkingAgentIds } = useChatStore.getState();
  const ids = thinkingAgentIds.filter((id) => id !== agentId);
  if (ids.length !== thinkingAgentIds.length) {
    useChatStore.setState({ thinkingAgentIds: ids });
  }
}

export async function respondToCard(agentId: string, toolUseId: string, response: string) {
  const activeAgentId = useChatStore.getState().agentId;
  const isActive = agentId === activeAgentId;

  // Find messages in the correct store (Zustand for active, Map for background)
  const sourceMsgs = isActive
    ? useChatStore.getState().messages
    : agentStates.get(agentId)?.messages ?? [];

  let requestId: string | undefined;
  let toolName: string | undefined;
  let toolInput: Record<string, unknown> | undefined;
  const msgs = [...sourceMsgs];
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

  // Update the correct store
  if (isActive) {
    const tc = msgs.reduce((n, m) => n + (m.tools?.length ?? 0), 0);
    useChatStore.setState({ messages: msgs, isThinking: true, toolCount: tc });
  } else {
    const bgState = agentStates.get(agentId);
    if (bgState) {
      bgState.messages = msgs;
      bgState.isThinking = true;
    }
    syncThinkingIds();
  }

  if (!requestId) {
    try {
      await invoke("send_message", {
        options: { agentId, prompt: response } satisfies SendMessageOptions,
      });
    } catch (e) {
      if (isActive) useChatStore.setState({ error: String(e), isThinking: false });
    }
    return;
  }

  let controlResponse: Record<string, unknown>;
  if (response.startsWith("__deny__")) {
    const reason = response.slice(8).trim() || "User declined";
    controlResponse = { error: reason };
  } else if (toolName === "AskUserQuestion") {
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
    controlResponse = { behavior: "allow" };
  }

  try {
    await invoke("respond_to_tool", {
      agentId,
      requestId,
      response: controlResponse,
    });
  } catch (e) {
    if (isActive) useChatStore.setState({ error: String(e), isThinking: false });
  }
}
