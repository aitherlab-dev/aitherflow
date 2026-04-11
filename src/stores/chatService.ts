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

// ── injectMessage (send during streaming) ──

/** Inject a user message as a blockquote into the current streaming response and forward to CLI. */
export async function injectMessage(text: string) {
  const state = useChatStore.getState();
  if (!state.isThinking || !state.streamingMessage) return;

  // Append quoted user text into the streaming message
  const quote = `\n\n> **User:** ${text}\n\n`;
  const updated = {
    ...state.streamingMessage,
    text: state.streamingMessage.text + quote,
  };
  useChatStore.setState({ streamingMessage: updated });

  // Also update agentStates for background consistency
  const agentState = agentStates.get(state.agentId);
  if (agentState) {
    agentState.streamingMessage = updated;
  }

  // Send to CLI stdin
  try {
    await invoke("send_message", {
      options: {
        agentId: state.agentId,
        prompt: text,
      } satisfies SendMessageOptions,
    });
  } catch (e) {
    console.error("[injectMessage] Failed to send:", e);
  }
}

// ── resumeCurrentChat ──

/** Start CLI with --resume using current chat's sessionId. Does NOT send any message. */
export async function resumeCurrentChat(): Promise<void> {
  const state = useChatStore.getState();
  if (!state.currentChatId || state.hasSession) return;

  const chatMeta = state.chatList.find((c) => c.id === state.currentChatId);
  const resumeSessionId = chatMeta?.sessionId ?? undefined;
  if (!resumeSessionId) return; // Can't resume without sessionId

  let enableChrome = true;
  let settingsPermMode: "default" | "plan" | "bypassPermissions" | undefined;
  try {
    const settings = await getSettings();
    if (settings.bypassPermissions) settingsPermMode = "bypassPermissions";
    enableChrome = settings.enableChrome;
  } catch (e) {
    console.error("[resumeCurrentChat] Failed to load settings:", e);
  }

  const { selectedModel, selectedEffort, selectedPermissionMode } = useConductorStore.getState();
  const permissionMode =
    settingsPermMode ?? (selectedPermissionMode !== "default" ? selectedPermissionMode : undefined);
  const agentRole = useConductorStore.getState().getAgentRole(state.agentId);

  try {
    await invoke("start_session", {
      options: {
        agentId: state.agentId,
        prompt: "",
        projectPath: state.projectPath,
        model: selectedModel || undefined,
        effort: selectedEffort !== "high" ? selectedEffort : undefined,
        resumeSessionId,
        permissionMode,
        chrome: enableChrome,
        roleSystemPrompt: agentRole?.system_prompt ? agentRole.system_prompt : undefined,
        roleAllowedTools: agentRole?.allowed_tools.length ? agentRole.allowed_tools : undefined,
      } satisfies StartSessionOptions,
    });
  } catch (e) {
    console.error("[resumeCurrentChat] Failed:", e);
  }
}

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

// ── Plan mode helpers ──

/** Update plan mode only after user explicitly approved the tool.
 *  Called from both the !requestId (fallback) and control_response paths. */
function updatePlanModeAfterApproval(toolName: string | undefined, response: string) {
  if (response.startsWith("__deny__")) return;
  if (toolName === "ExitPlanMode") {
    useChatStore.setState({ planMode: false });
    useConductorStore.getState().setSelectedPermissionMode("default");
  } else if (toolName === "EnterPlanMode") {
    useChatStore.setState({ planMode: true });
    useConductorStore.getState().setSelectedPermissionMode("plan");
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
      // Plan mode changes are tied to user approval (no requestId = auto-approved)
      updatePlanModeAfterApproval(toolName, response);
    } catch (e) {
      console.error("[respondToCard] send_message failed:", e);
      if (isActive) useChatStore.setState({ error: "Failed to send response.", isThinking: false });
    }
    return;
  }

  let controlResponse: Record<string, unknown>;
  if (response.startsWith("__deny__")) {
    const reason = response.slice(8).trim() || "User denied";
    controlResponse = { behavior: "deny", message: reason, toolUseID: toolUseId };
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
      toolUseID: toolUseId,
    };
  } else {
    controlResponse = { behavior: "allow", updatedInput: {}, toolUseID: toolUseId };
  }

  try {
    await invoke("respond_to_tool", {
      agentId,
      requestId,
      response: controlResponse,
    });

    // Plan mode changes are tied to user approval
    updatePlanModeAfterApproval(toolName, response);
  } catch (e) {
    console.error("[respondToCard] respond_to_tool failed:", e);
    if (isActive) useChatStore.setState({ error: "Failed to process response.", isThinking: false });
  }
}
