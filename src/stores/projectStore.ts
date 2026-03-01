import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectBookmark, ProjectsConfig } from "../types/projects";

interface ProjectState {
  projects: ProjectBookmark[];
  lastOpenedProject: string | null;

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
}

/** Persist current state to disk via Rust */
async function persist(projects: ProjectBookmark[], lastOpened: string | null) {
  await invoke("save_projects", {
    projects,
    lastOpenedProject: lastOpened,
  });
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  lastOpenedProject: null,

  init: async () => {
    const config = await invoke<ProjectsConfig>("load_projects");
    set({
      projects: config.projects,
      lastOpenedProject: config.lastOpenedProject,
    });
  },

  addProject: async (path, name) => {
    const { projects, lastOpenedProject } = get();
    // Don't add duplicates
    if (projects.some((p) => p.path === path)) return;
    const updated = [...projects, { path, name }];
    set({ projects: updated });
    await persist(updated, lastOpenedProject);
  },

  removeProject: async (path) => {
    const { projects, lastOpenedProject } = get();
    // Find the project — cannot remove if it's the first (Workspace)
    const idx = projects.findIndex((p) => p.path === path);
    if (idx <= 0) return;
    const updated = projects.filter((p) => p.path !== path);
    const newLastOpened = lastOpenedProject === path ? null : lastOpenedProject;
    set({ projects: updated, lastOpenedProject: newLastOpened });
    await persist(updated, newLastOpened);
  },

  renameProject: async (path, newName) => {
    const { projects, lastOpenedProject } = get();
    const updated = projects.map((p) =>
      p.path === path ? { ...p, name: newName } : p,
    );
    set({ projects: updated });
    await persist(updated, lastOpenedProject);
  },

  addDirectory: async (projectPath, dirPath) => {
    const { projects, lastOpenedProject } = get();
    const updated = projects.map((p) => {
      if (p.path !== projectPath) return p;
      const dirs = p.additionalDirs ?? [];
      if (dirs.includes(dirPath)) return p;
      return { ...p, additionalDirs: [...dirs, dirPath] };
    });
    set({ projects: updated });
    await persist(updated, lastOpenedProject);
  },

  removeDirectory: async (projectPath, dirPath) => {
    const { projects, lastOpenedProject } = get();
    const updated = projects.map((p) => {
      if (p.path !== projectPath) return p;
      const dirs = (p.additionalDirs ?? []).filter((d) => d !== dirPath);
      return { ...p, additionalDirs: dirs };
    });
    set({ projects: updated });
    await persist(updated, lastOpenedProject);
  },
}));
