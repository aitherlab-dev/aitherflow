import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  SkillEntry,
  SkillsData,
  SkillFavorites,
  PluginSkillGroup,
} from "../types/skills";

interface SkillState {
  global: SkillEntry[];
  project: SkillEntry[];
  plugins: PluginSkillGroup[];
  favoriteIds: string[];
  loaded: boolean;

  /** Load all skills for the given project path */
  load: (projectPath: string) => Promise<void>;

  /** Toggle a skill as favorite */
  toggleFavorite: (skillId: string) => Promise<void>;

  /** Get all skills as a flat list */
  allSkills: () => SkillEntry[];

  /** Get favorite skills */
  getFavorites: () => SkillEntry[];
}

export const useSkillStore = create<SkillState>((set, get) => ({
  global: [],
  project: [],
  plugins: [],
  favoriteIds: [],
  loaded: false,

  load: async (projectPath) => {
    try {
      const [data, favs] = await Promise.all([
        invoke<SkillsData>("load_skills", { projectPath }),
        invoke<SkillFavorites>("load_skill_favorites"),
      ]);
      set({
        global: data.global,
        project: data.project,
        plugins: data.plugins,
        favoriteIds: favs.ids,
        loaded: true,
      });
    } catch (e) {
      console.error("Failed to load skills:", e);
    }
  },

  toggleFavorite: async (skillId) => {
    const { favoriteIds } = get();
    const next = favoriteIds.includes(skillId)
      ? favoriteIds.filter((id) => id !== skillId)
      : [...favoriteIds, skillId];

    set({ favoriteIds: next });

    try {
      await invoke("save_skill_favorites", { ids: next });
    } catch (e) {
      console.error("Failed to save skill favorites:", e);
    }
  },

  allSkills: () => {
    const { global, project, plugins } = get();
    return [
      ...global,
      ...project,
      ...plugins.flatMap((p) => p.skills),
    ];
  },

  getFavorites: () => {
    const { favoriteIds } = get();
    const all = get().allSkills();
    return favoriteIds
      .map((id) => all.find((s) => s.id === id))
      .filter((s): s is SkillEntry => s !== undefined);
  },
}));
