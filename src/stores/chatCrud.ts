/**
 * Chat CRUD — list, create, load, switch, delete, rename, pin chats.
 */

import { invoke } from "../lib/transport";
import { toFileType } from "../types/chat";
import type { ChatMessage } from "../types/chat";
import {
  useChatStore,
  agentStates,
  messagesToStored,
  type ChatMeta,
} from "./chatStore";
import { useAgentStore } from "./agentStore";
import { useConductorStore } from "./conductorStore";
import { useProjectStore } from "./projectStore";
import { cancelStreamRaf } from "./chatStreamHandler";

// ── Helpers ──

function generateTitle(text: string): string {
  const max = 30;
  const singleLine = text.replace(/\n/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  const truncated = singleLine.slice(0, max);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

// ── Persistence ──

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

// Re-export for sendMessage (chatService.ts)
export { generateTitle };

// ── Switch chat ──

export async function switchChat(chatId: string) {
  const state = useChatStore.getState();
  if (state.currentChatId === chatId) return;

  cancelStreamRaf();

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
    console.error("[switchChat] Failed:", e);
    useChatStore.setState({ error: "Failed to load chat." });
  }
}

// ── New / Delete / Rename / Pin ──

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
    streamingMessage: null,
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

    // Re-read state after async gap — user may have switched chats
    const current = useChatStore.getState();
    if (current.currentChatId === chatId) {
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
      useAgentStore.getState().updateChatLock(current.agentId, null);
    }

    // Clean up agentStates entries that referenced the deleted chat
    // Skip active agent — its real state is in Zustand, not the Map snapshot
    const activeAgentId = useChatStore.getState().agentId;
    for (const [agentId, agentState] of agentStates) {
      if (agentId !== activeAgentId && agentState.chatId === chatId) {
        agentStates.delete(agentId);
      }
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
