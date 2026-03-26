/**
 * Agent switching — save/restore agent state snapshots,
 * serialized through the shared session chain.
 */

import { invoke } from "../lib/transport";
import type { ChatMessage } from "../types/chat";
import {
  useChatStore,
  agentStates,
  messagesToStored,
} from "./chatStore";
import { useConductorStore } from "./conductorStore";
import { cancelStreamRaf, clearToolActivityTimer, syncThinkingIds } from "./chatStreamHandler";
import { enqueueSession } from "./sessionManager";
import { persistMessages, loadChatList, switchChat } from "./chatCrud";

// ── Switch agent ──

export function switchAgent(
  agentId: string,
  projectPath: string,
  projectName: string,
  savedChatId: string | null,
) {
  return enqueueSession(async () => {
    try {
      await switchAgentInner(agentId, projectPath, projectName, savedChatId);
    } catch (e) {
      console.error("[switchAgent] Failed:", e);
      throw e;
    }
  });
}

async function switchAgentInner(
  agentId: string,
  projectPath: string,
  projectName: string,
  savedChatId: string | null,
) {
  const state = useChatStore.getState();

  // Flush RAF buffer BEFORE snapshotting so no buffered text is lost
  clearToolActivityTimer();
  cancelStreamRaf();

  // Snapshot BEFORE any async work to prevent race with event handlers
  const fresh = useChatStore.getState();
  agentStates.set(state.agentId, {
    messages: fresh.messages,
    streamingMessage: fresh.streamingMessage,
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

  // Reset telegram state on agent switch (await to complete before restoring new agent)
  try {
    const { resetTelegramState } = await import("../services/telegramService");
    resetTelegramState();
  } catch (e) {
    console.error("[switchAgentInner] Failed to reset telegram state:", e);
  }

  // Clear file viewer on agent switch (await to complete before restoring new agent)
  try {
    const { useFileViewerStore } = await import("./fileViewerStore");
    useFileViewerStore.getState().clearAll();
  } catch (e) {
    console.error("[switchAgentInner] Failed to clear file viewer:", e);
  }

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

// ── Clear agent state ──

export async function clearAgentState(agentId: string) {
  // Save background agent messages before discarding state
  const state = agentStates.get(agentId);
  if (state?.chatId && state.messages.length > 0) {
    try {
      await invoke("save_chat_messages", {
        chatId: state.chatId,
        messages: messagesToStored(state.messages),
      });
    } catch (e) {
      console.error("[clearAgentState] Failed to save messages:", e);
    }
  }
  agentStates.delete(agentId);
  const { thinkingAgentIds } = useChatStore.getState();
  const ids = thinkingAgentIds.filter((id) => id !== agentId);
  if (ids.length !== thinkingAgentIds.length) {
    useChatStore.setState({ thinkingAgentIds: ids });
  }
}
