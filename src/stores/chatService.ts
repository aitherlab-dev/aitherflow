/**
 * Chat business logic — sendMessage & respondToCard orchestrators,
 * plus re-exports from split modules so consumers keep a single import path.
 */

import { invoke } from "../lib/transport";
import type { StartSessionOptions, SendMessageOptions } from "../types/conductor";
import type { Attachment, ChatMessage } from "../types/chat";
import type { AttachmentPayload } from "../types/conductor";
import {
  useChatStore,
  agentStates,
  type ChatMeta,
} from "./chatStore";
import { useAgentStore } from "./agentStore";
import { useConductorStore } from "./conductorStore";
import { useProjectStore } from "./projectStore";
import { syncThinkingIds } from "./chatStreamHandler";
import { getSettings } from "./sessionManager";
import { loadChatList, generateTitle } from "./chatCrud";

// ── Re-exports (keep single import path for all consumers) ──

export { invalidateSettingsCache, stopGeneration, restartSession, switchPermissionMode, switchModel } from "./sessionManager";
export { persistMessages, loadChatList, switchChat, newChat, deleteChat, renameChat, toggleChatPin } from "./chatCrud";
export { switchAgent, clearAgentState } from "./agentSwitcher";

// ── sendMessage ──

/** Guard to prevent duplicate chat creation on double-click Send */
let isCreatingChat = false;

export async function sendMessage(text: string, allAttachments?: Attachment[]) {
  const state = useChatStore.getState();
  let chatId = state.currentChatId;

  // Auto-accept all pending diffs when user sends a new message (before state change)
  try {
    const { useFileViewerStore } = await import("./fileViewerStore");
    useFileViewerStore.getState().acceptAllPending();
  } catch (e) {
    console.error("[sendMessage] Failed to accept pending diffs:", e);
  }

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
  useChatStore.setState((prev) => ({ messages: [...prev.messages, userMsg], error: null, isThinking: true }));

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

    // Re-read state after awaits — user may have switched chat
    const freshState = useChatStore.getState();
    if (freshState.currentChatId !== chatId) {
      useChatStore.setState({ isThinking: false });
      return;
    }

    if (freshState.hasSession) {
      await invoke("send_message", {
        options: {
          agentId: freshState.agentId,
          prompt: text,
          attachments: attachmentPayloads,
        } satisfies SendMessageOptions,
      });
    } else {
      const chatMeta = useChatStore.getState().chatList.find((c) => c.id === chatId);
      const resumeSessionId = chatMeta?.sessionId ?? undefined;

      let enableChrome = true;
      let settingsPermMode: "default" | "plan" | "bypassPermissions" | undefined;
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

      // Get standalone role for this agent
      const agentRole = useConductorStore.getState().getAgentRole(state.agentId);

      await invoke("start_session", {
        options: {
          agentId: state.agentId,
          prompt: text,
          projectPath: state.projectPath,
          model: selectedModel || undefined,
          effort: selectedEffort !== "high" ? selectedEffort : undefined,
          resumeSessionId,
          permissionMode,
          chrome: enableChrome,
          attachments: attachmentPayloads,
          roleSystemPrompt: agentRole?.system_prompt ? agentRole.system_prompt : undefined,
          roleAllowedTools: agentRole?.allowed_tools.length ? agentRole.allowed_tools : undefined,
        } satisfies StartSessionOptions,
      });
    }
  } catch (e) {
    console.error("[sendMessage] Failed:", e);
    useChatStore.setState({ error: "Failed to send message. Please try again.", isThinking: false });
  }
}

// ── respondToCard ──

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
      console.error("[respondToCard] send_message failed:", e);
      if (isActive) useChatStore.setState({ error: "Failed to send response.", isThinking: false });
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
    console.error("[respondToCard] respond_to_tool failed:", e);
    if (isActive) useChatStore.setState({ error: "Failed to process response.", isThinking: false });
  }
}
