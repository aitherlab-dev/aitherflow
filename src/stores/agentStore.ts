import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "./chatStore";
import type { AgentInfo, ChatInfo } from "../types/agent";

/** Project entry as stored in projects.json (matches Rust struct) */
interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  addedAt: number;
}

/** Bookmark shown in the dropdown (workspace + saved projects) */
export interface ProjectBookmark {
  id: string;
  name: string;
  path: string;
}

interface AgentState {
  agents: AgentInfo[];
  activeAgentId: string | null;
  chats: ChatInfo[];
  /** Maps agentId → its currently active chatId */
  activeChatByAgent: Record<string, string>;
  /** All bookmarked projects (always includes workspace). Persists independently of agents. */
  bookmarks: ProjectBookmark[];
  initialized: boolean;

  init: () => Promise<void>;
  addProject: (folderPath: string) => Promise<void>;
  openProject: (bookmarkId: string) => void;
  switchAgent: (agentId: string) => void;
  removeProject: (agentId: string) => void;
  createChat: (agentId: string) => string;
  switchChat: (chatId: string) => void;
  toggleExpanded: (agentId: string) => void;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  activeAgentId: null,
  chats: [],
  activeChatByAgent: {},
  bookmarks: [],
  initialized: false,

  init: async () => {
    if (get().initialized) return;

    // Ensure default workspace exists
    let workspacePath = "~/.config/aither-flow/workspace";
    try {
      workspacePath = await invoke<string>("ensure_default_workspace");
    } catch (e) {
      console.error("[agentStore] ensure_default_workspace failed:", e);
    }

    // Load saved projects
    let savedProjects: ProjectEntry[] = [];
    try {
      savedProjects = await invoke<ProjectEntry[]>("load_projects");
    } catch (e) {
      console.error("[agentStore] load_projects failed:", e);
    }

    // Build bookmarks: workspace (always first) + saved projects
    const bookmarks: ProjectBookmark[] = [
      { id: "workspace", name: "workspace", path: workspacePath },
      ...savedProjects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
    ];

    // Only workspace agent is open on start.
    // Saved projects are bookmarks in dropdown — not open agents.
    const agents: AgentInfo[] = [{
      id: "workspace",
      name: "workspace",
      projectPath: workspacePath,
      expanded: false,
    }];
    const workspaceChatId = crypto.randomUUID();
    const chats: ChatInfo[] = [{
      id: workspaceChatId,
      agentId: "workspace",
      title: "New Chat",
      createdAt: Date.now(),
    }];
    const activeChatByAgent: Record<string, string> = {
      workspace: workspaceChatId,
    };

    set({
      agents,
      activeAgentId: "workspace",
      chats,
      activeChatByAgent,
      bookmarks,
      initialized: true,
    });

    // Sync to chatStore
    useChatStore.getState().setActiveChatId(workspaceChatId);
  },

  addProject: async (folderPath: string) => {
    const state = get();

    // Check if bookmark with this path already exists
    const existingBookmark = state.bookmarks.find((b) => b.path === folderPath);
    if (existingBookmark) {
      // Open it (creates agent if needed, or switches to existing)
      get().openProject(existingBookmark.id);
      return;
    }

    // Generate ID and name
    const agentId = crypto.randomUUID();
    const name = folderPath.split("/").pop() ?? folderPath;

    // Add bookmark
    const bookmark: ProjectBookmark = { id: agentId, name, path: folderPath };
    const bookmarks = [...state.bookmarks, bookmark];

    // Create agent
    const agent: AgentInfo = {
      id: agentId,
      name,
      projectPath: folderPath,
      expanded: false,
    };

    // Create first chat
    const chatId = crypto.randomUUID();
    const chat: ChatInfo = {
      id: chatId,
      agentId,
      title: "New Chat",
      createdAt: Date.now(),
    };

    const agents = [...state.agents, agent];
    const activeChatByAgent = { ...state.activeChatByAgent, [agentId]: chatId };

    set({
      agents,
      activeAgentId: agentId,
      chats: [...state.chats, chat],
      activeChatByAgent,
      bookmarks,
    });

    // Sync to chatStore
    useChatStore.getState().switchToAgent(agentId, chatId);

    // Save bookmarks (exclude workspace)
    const projects: ProjectEntry[] = bookmarks
      .filter((b) => b.id !== "workspace")
      .map((b) => ({
        id: b.id,
        name: b.name,
        path: b.path,
        addedAt: Date.now(),
      }));
    invoke("save_projects", { projects }).catch(console.error);
  },

  openProject: (bookmarkId: string) => {
    const state = get();

    // If agent already open, just switch to it
    const existingAgent = state.agents.find((a) => a.id === bookmarkId);
    if (existingAgent) {
      get().switchAgent(bookmarkId);
      return;
    }

    // Agent was closed — reopen from bookmark
    const bookmark = state.bookmarks.find((b) => b.id === bookmarkId);
    if (!bookmark) return;

    const agent: AgentInfo = {
      id: bookmark.id,
      name: bookmark.name,
      projectPath: bookmark.path,
      expanded: false,
    };

    const chatId = crypto.randomUUID();
    const chat: ChatInfo = {
      id: chatId,
      agentId: bookmark.id,
      title: "New Chat",
      createdAt: Date.now(),
    };

    const agents = [...state.agents, agent];
    const activeChatByAgent = { ...state.activeChatByAgent, [bookmark.id]: chatId };

    set({
      agents,
      activeAgentId: bookmark.id,
      chats: [...state.chats, chat],
      activeChatByAgent,
    });

    useChatStore.getState().switchToAgent(bookmark.id, chatId);
  },

  switchAgent: (agentId: string) => {
    const state = get();
    if (state.activeAgentId === agentId) return;

    set({ activeAgentId: agentId });

    const chatId = state.activeChatByAgent[agentId];
    if (chatId) {
      useChatStore.getState().switchToAgent(agentId, chatId);
    }
  },

  removeProject: (agentId: string) => {
    const state = get();

    // Cannot remove the last agent
    if (state.agents.length <= 1) return;

    const agents = state.agents.filter((a) => a.id !== agentId);
    const chats = state.chats.filter((c) => c.agentId !== agentId);
    const activeChatByAgent = { ...state.activeChatByAgent };
    delete activeChatByAgent[agentId];

    // If removing active agent, switch to the first remaining one
    const needSwitch = state.activeAgentId === agentId;
    const newActiveId = needSwitch ? agents[0].id : state.activeAgentId;

    set({ agents, chats, activeChatByAgent, activeAgentId: newActiveId });

    if (needSwitch) {
      const switchChatId = activeChatByAgent[agents[0].id];
      if (switchChatId) {
        useChatStore.getState().switchToAgent(agents[0].id, switchChatId);
      }
    }

    // Bookmarks stay — closing agent card ≠ removing bookmark
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
      activeChatByAgent: { ...s.activeChatByAgent, [agentId]: chatId },
    }));

    // Sync to chatStore
    useChatStore.getState().setActiveChatId(chatId);

    return chatId;
  },

  switchChat: (chatId: string) => {
    const state = get();
    const chat = state.chats.find((c) => c.id === chatId);
    if (!chat) return;

    set((s) => ({
      activeChatByAgent: { ...s.activeChatByAgent, [chat.agentId]: chatId },
    }));

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
