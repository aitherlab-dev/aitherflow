import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "./chatStore";
import type { AgentInfo, ChatInfo } from "../types/agent";

interface AgentState {
  agents: AgentInfo[];
  activeAgentId: string | null;
  chats: ChatInfo[];
  initialized: boolean;

  init: () => Promise<void>;
  createChat: (agentId: string) => string;
  switchChat: (chatId: string) => void;
  toggleExpanded: (agentId: string) => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  activeAgentId: null,
  chats: [],
  initialized: false,

  init: async () => {
    if (get().initialized) return;

    let projectPath = "~/.config/aither-flow/workspace";
    try {
      projectPath = await invoke<string>("ensure_default_workspace");
    } catch (e) {
      console.error("[agentStore] ensure_default_workspace failed:", e);
    }

    const agentId = "workspace";
    const agent: AgentInfo = {
      id: agentId,
      name: "workspace",
      projectPath,
      expanded: true,
    };

    // Create first chat
    const chatId = crypto.randomUUID();
    const chat: ChatInfo = {
      id: chatId,
      agentId,
      title: "New Chat",
      createdAt: Date.now(),
    };

    set({
      agents: [agent],
      activeAgentId: agentId,
      chats: [chat],
      initialized: true,
    });

    // Sync to chatStore via getState — no React hooks!
    useChatStore.getState().setActiveChatId(chatId);
  },

  createChat: (agentId: string) => {
    const chatId = crypto.randomUUID();
    const chat: ChatInfo = {
      id: chatId,
      agentId,
      title: "New Chat",
      createdAt: Date.now(),
    };

    set((s) => ({
      chats: [...s.chats, chat],
    }));

    // Sync to chatStore via getState — no React hooks!
    useChatStore.getState().setActiveChatId(chatId);

    return chatId;
  },

  switchChat: (chatId: string) => {
    // Sync to chatStore via getState — no React hooks!
    useChatStore.getState().setActiveChatId(chatId);
  },

  toggleExpanded: (agentId: string) => {
    set((s) => ({
      agents: s.agents.map((a) =>
        a.id === agentId ? { ...a, expanded: !a.expanded } : a,
      ),
    }));
  },
}));
