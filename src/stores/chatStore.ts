/**
 * Chat store — pure state, types, shared data structures, and selectors.
 * Business logic lives in chatService.ts, event handling in chatStreamHandler.ts.
 */

import { create } from "zustand";
import type { ChatMessage, ToolActivity } from "../types/chat";

// Side-effect: registers the "cli-event" listener
import "./chatStreamHandler";

// ── Constants (shared with streamHandler) ──

/** How long to keep tool activity visible after completion (ms) */
export const TOOL_ACTIVITY_LINGER_MS = 1500;

/** Tools that edit files and should be bridged to fileViewerStore */
export const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

// ── Per-agent state map ──

/** State for each agent (active uses Zustand as truth, background uses this Map) */
export interface AgentChatState {
  messages: ChatMessage[];
  streamingMessage: ChatMessage | null;
  chatId: string | null;
  hasSession: boolean;
  isThinking: boolean;
  planMode: boolean;
  currentToolActivity: ToolActivity | null;
  toolCount: number;
  error: string | null;
}

/** Module-level map: stores state for ALL agents. Background agents updated directly by events, active agent snapshotted on switch. */
export const agentStates = new Map<string, AgentChatState>();

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

/** Chat store state (data only, no actions) */
export interface ChatState {
  agentId: string;
  projectPath: string;
  projectName: string;
  chatList: ChatMeta[];
  currentChatId: string | null;
  messages: ChatMessage[];
  streamingMessage: ChatMessage | null;
  hasSession: boolean;
  isThinking: boolean;
  planMode: boolean;
  currentToolActivity: ToolActivity | null;
  toolCount: number;
  error: string | null;
  thinkingAgentIds: string[];
}

// ── Shared helpers ──

/** Convert frontend ChatMessage[] to storable format (strip isStreaming) */
export function messagesToStored(messages: ChatMessage[]) {
  const needsClean = messages.some((m) => m.isStreaming);
  if (!needsClean) return messages;
  return messages.map((m) => {
    if (!m.isStreaming) return m;
    const { isStreaming: _, ...rest } = m;
    return rest;
  });
}

// ── Utility exports (used by UI components) ──

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

export const useChatStore = create<ChatState>(() => ({
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
  toolCount: 0,
  error: null,
  thinkingAgentIds: [],
}));

// ── Derived selectors (memoized outside components) ──

/** All tool activities across messages + streaming message. Use with useShallow. */
let _toolCache: { msgs: ChatMessage[]; stream: ChatMessage | null; result: ToolActivity[] } = { msgs: [], stream: null, result: [] };
export function selectToolActivities(s: ChatState): ToolActivity[] {
  if (s.messages === _toolCache.msgs && s.streamingMessage === _toolCache.stream) return _toolCache.result;
  const all: ToolActivity[] = [];
  for (const msg of s.messages) {
    if (msg.tools) for (const t of msg.tools) all.push(t);
  }
  if (s.streamingMessage?.tools) {
    for (const t of s.streamingMessage.tools) all.push(t);
  }
  _toolCache = { msgs: s.messages, stream: s.streamingMessage, result: all };
  return all;
}

/** Total tool count (maintained incrementally, not recomputed). */
export function selectToolCount(s: ChatState): number {
  return s.toolCount;
}

/** Last 2 tool activities from the latest assistant message (for InputBar). */
export function selectRecentTools(s: ChatState): ToolActivity[] {
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
