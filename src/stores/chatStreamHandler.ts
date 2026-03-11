/**
 * CLI event handler — processes stream-json events from Claude CLI.
 * RAF batching for stream chunks, background agent event processing.
 *
 * Side-effect module: importing this file registers the "cli-event" listener.
 */

import { listen, invoke } from "../lib/transport";
import { persistMessages } from "./chatService";
import type { CliEvent } from "../types/conductor";
import type { ChatMessage, ToolActivity } from "../types/chat";
import { isInteractiveTool } from "../types/chat";
import {
  useChatStore,
  agentStates,
  TOOL_ACTIVITY_LINGER_MS,
  FILE_EDIT_TOOLS,
  messagesToStored,
  type AgentChatState,
} from "./chatStore";
import { useConductorStore } from "./conductorStore";

// ── RAF batching for stream chunks: buffer latest text, flush at ~60fps ──

let streamBuffer: string | null = null;
let streamBufferIsNew = false;
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

export function cancelStreamRaf() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  // Flush any pending buffer before discarding, so streamingMessage stays up-to-date
  if (streamBuffer !== null) {
    flushStreamBuffer();
  }
  streamBuffer = null;
  streamBufferIsNew = false;
}

// ── Tool activity timer ──

let toolActivityTimer: ReturnType<typeof setTimeout> | null = null;

export function clearToolActivityTimer() {
  if (toolActivityTimer) {
    clearTimeout(toolActivityTimer);
    toolActivityTimer = null;
  }
}

// ── Persistence helpers ──

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

// ── Thinking indicator sync ──

export function syncThinkingIds() {
  const { getState: get, setState: set } = useChatStore;
  const activeId = get().agentId;
  const ids: string[] = [];

  if (get().isThinking) ids.push(activeId);

  for (const [agentId, state] of agentStates) {
    if (agentId !== activeId && state.isThinking) {
      ids.push(agentId);
    }
  }

  const current = get().thinkingAgentIds;
  if (ids.length !== current.length || ids.some((id, i) => id !== current[i])) {
    set({ thinkingAgentIds: ids });
  }
}

// ── Background agent event processor (updates Map directly, no Zustand reactivity) ──

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
      const sm = agentState.streamingMessage;
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
    if (wasThinking !== agentState.isThinking) syncThinkingIds();
    return;
  }

  // Active agent → update Zustand
  const { getState: get, setState: set } = useChatStore;
  const state = get();

  switch (e.type) {
    case "sessionId": {
      set({ hasSession: true });
      const chatId = get().currentChatId;
      if (chatId) {
        invoke("update_chat_session", { chatId, sessionId: e.session_id }).catch(console.error);
        set((prev) => ({
          chatList: prev.chatList.map((c) =>
            c.id === chatId ? { ...c, sessionId: e.session_id } : c,
          ),
        }));
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
        set({ isThinking: true });
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

      // Track plan mode transitions
      if (e.tool_name === "EnterPlanMode") {
        set({ planMode: true });
        useConductorStore.getState().setSelectedPermissionMode("plan");
      }
      if (e.tool_name === "ExitPlanMode") {
        set({ planMode: false });
        useConductorStore.getState().setSelectedPermissionMode("default");
      }

      // Interactive tools merge into messages so cards render
      if (!isInteractiveTool(e.tool_name)) {
        if (toolActivityTimer) {
          clearTimeout(toolActivityTimer);
          toolActivityTimer = null;
        }
        set({ streamingMessage: sm, currentToolActivity: activity });
      } else {
        if (sm) {
          set((prev) => ({
            messages: [...prev.messages, { ...sm, isStreaming: false }],
            streamingMessage: null,
            isThinking: false,
          }));
        }
        syncThinkingIds();
      }
      break;
    }

    case "toolResult": {
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
      }, TOOL_ACTIVITY_LINGER_MS);
      break;
    }

    case "controlRequest": {
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

// ── Register listener (singleton, lives for app lifetime) ──

listen<CliEvent>("cli-event", (event) => handleCliEvent(event.payload)).catch(
  console.error,
);
