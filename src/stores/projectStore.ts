import { create } from "zustand";
import { invoke } from "../lib/transport";
import type { ProjectBookmark, ProjectsConfig, WelcomeCard } from "../types/projects";
interface ProjectState {
  projects: ProjectBookmark[];
  lastOpenedProject: string | null;
  lastOpenedChatId: string | null;
  welcomeCards: WelcomeCard[];

  /** Load projects from disk */
  init: () => Promise<void>;

  /** Add a new project bookmark */
  addProject: (path: string, name: string) => Promise<void>;

  /** Remove a project (cannot remove Workspace) */
  removeProject: (path: string) => Promise<void>;

  /** Rename a project (display name only, not folder) */
  renameProject: (path: string, newName: string) => Promise<void>;

  /** Add an additional directory to a project */
  addDirectory: (projectPath: string, dirPath: string) => Promise<void>;

  /** Remove an additional directory from a project */
  removeDirectory: (projectPath: string, dirPath: string) => Promise<void>;

  /** Track last opened project + chat for welcome screen */
  setLastOpened: (projectPath: string, chatId: string | null) => Promise<void>;

  /** Add a welcome card */
  addWelcomeCard: (projectPath: string, projectName: string) => Promise<void>;

  /** Remove a welcome card */
  removeWelcomeCard: (projectPath: string) => Promise<void>;

  /** Reorder welcome cards */
  reorderWelcomeCards: (fromIndex: number, toIndex: number) => Promise<void>;
}

/** Persist current state to disk via Rust */
async function persist(
  projects: ProjectBookmark[],
  lastOpened: string | null,
  lastChatId: string | null,
  welcomeCards: WelcomeCard[],
) {
  await invoke("save_projects", {
    projects,
    lastOpenedProject: lastOpened,
    lastOpenedChatId: lastChatId,
    welcomeCards,
  });
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  lastOpenedProject: null,
  lastOpenedChatId: null,
  welcomeCards: [],

  init: async () => {
    try {
      const config = await invoke<ProjectsConfig>("load_projects");
      set({
        projects: config.projects,
        lastOpenedProject: config.lastOpenedProject,
        lastOpenedChatId: config.lastOpenedChatId ?? null,
        welcomeCards: config.welcomeCards ?? [],
      });
    } catch (e) {
      console.error("[projectStore] Failed to load projects:", e);
    }
  },

  addProject: async (path, name) => {
    const { projects, lastOpenedProject, lastOpenedChatId, welcomeCards } = get();
    if (projects.some((p) => p.path === path)) return;
    const updated = [...projects, { path, name }];
    set({ projects: updated });
    await persist(updated, lastOpenedProject, lastOpenedChatId, welcomeCards);
  },

  removeProject: async (path) => {
    const { projects, lastOpenedProject, lastOpenedChatId, welcomeCards } = get();
    const idx = projects.findIndex((p) => p.path === path);
    if (idx <= 0) return;
    const updated = projects.filter((p) => p.path !== path);
    const newLastOpened = lastOpenedProject === path ? null : lastOpenedProject;
    set({ projects: updated, lastOpenedProject: newLastOpened });
    await persist(updated, newLastOpened, lastOpenedChatId, welcomeCards);
  },

  renameProject: async (path, newName) => {
    const { projects, lastOpenedProject, lastOpenedChatId, welcomeCards } = get();
    const updated = projects.map((p) =>
      p.path === path ? { ...p, name: newName } : p,
    );
    // Also update welcome cards
    const updatedCards = welcomeCards.map((c) =>
      c.projectPath === path ? { ...c, projectName: newName } : c,
    );
    set({ projects: updated, welcomeCards: updatedCards });
    await persist(updated, lastOpenedProject, lastOpenedChatId, updatedCards);
    import("./agentStore").then(({ useAgentStore }) => {
      useAgentStore.getState().renameProjectInAgents(path, newName).catch(console.error);
    });
  },

  addDirectory: async (projectPath, dirPath) => {
    const { projects, lastOpenedProject, lastOpenedChatId, welcomeCards } = get();
    const updated = projects.map((p) => {
      if (p.path !== projectPath) return p;
      const dirs = p.additionalDirs ?? [];
      if (dirs.includes(dirPath)) return p;
      return { ...p, additionalDirs: [...dirs, dirPath] };
    });
    set({ projects: updated });
    await persist(updated, lastOpenedProject, lastOpenedChatId, welcomeCards);
  },

  removeDirectory: async (projectPath, dirPath) => {
    const { projects, lastOpenedProject, lastOpenedChatId, welcomeCards } = get();
    const updated = projects.map((p) => {
      if (p.path !== projectPath) return p;
      const dirs = (p.additionalDirs ?? []).filter((d) => d !== dirPath);
      return { ...p, additionalDirs: dirs };
    });
    set({ projects: updated });
    await persist(updated, lastOpenedProject, lastOpenedChatId, welcomeCards);
  },

  setLastOpened: async (projectPath, chatId) => {
    const { projects, welcomeCards } = get();
    set({ lastOpenedProject: projectPath, lastOpenedChatId: chatId });
    await persist(projects, projectPath, chatId, welcomeCards);
  },

  addWelcomeCard: async (projectPath, projectName) => {
    const { projects, lastOpenedProject, lastOpenedChatId, welcomeCards } = get();
    if (welcomeCards.some((c) => c.projectPath === projectPath)) return;
    const updated = [...welcomeCards, { projectPath, projectName }];
    set({ welcomeCards: updated });
    await persist(projects, lastOpenedProject, lastOpenedChatId, updated);
  },

  removeWelcomeCard: async (projectPath) => {
    const { projects, lastOpenedProject, lastOpenedChatId, welcomeCards } = get();
    const updated = welcomeCards.filter((c) => c.projectPath !== projectPath);
    set({ welcomeCards: updated });
    await persist(projects, lastOpenedProject, lastOpenedChatId, updated);
  },

  reorderWelcomeCards: async (fromIndex, toIndex) => {
    const { projects, lastOpenedProject, lastOpenedChatId, welcomeCards } = get();
    const updated = [...welcomeCards];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    set({ welcomeCards: updated });
    await persist(projects, lastOpenedProject, lastOpenedChatId, updated);
  },
}));
