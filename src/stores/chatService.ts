/**
 * Chat business logic — standalone functions that orchestrate
 * chatStore state, CLI invocations, and cross-store coordination.
 */

import { invoke } from "../lib/transport";
import type { StartSessionOptions, SendMessageOptions } from "../types/conductor";
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
      if (isCreatingChat) return;
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
        const settings = await invoke<{ bypassPermissions: boolean; enableChrome: boolean }>("load_settings");
        if (settings.bypassPermissions) {
          settingsPermMode = "bypassPermissions";
        }
        enableChrome = settings.enableChrome;
      } catch (e) {
        console.error("Failed to load settings:", e);
      }

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
        // Force-clear session state if CLI didn't exit in time
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
    useChatStore.setState({ hasSession: true });
  } catch (e) {
    useChatStore.setState({ error: String(e) });
  }
}

export async function switchChat(chatId: string) {
  const state = useChatStore.getState();
  if (state.isThinking) return;
  if (state.currentChatId === chatId) return;

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
            fileType: a.fileType as "image" | "text",
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

export async function switchAgent(
  agentId: string,
  projectPath: string,
  projectName: string,
  savedChatId: string | null,
) {
  const state = useChatStore.getState();

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

  useConductorStore.getState().saveUsageForAgent(state.agentId);

  clearToolActivityTimer();
  cancelStreamRaf();

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
    useChatStore.setState({ messages: msgs, isThinking: true });
  } else {
    const bgState = agentStates.get(agentId);
    if (bgState) bgState.messages = msgs;
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
