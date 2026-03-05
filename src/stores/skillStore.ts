import { create } from "zustand";
import { invoke } from "../lib/transport";
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

  /** Delete a user skill (global or project) */
  deleteSkill: (skill: SkillEntry) => Promise<void>;
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

  deleteSkill: async (skill) => {
    try {
      await invoke("delete_skill", { filePath: skill.filePath });
      // Remove from local state
      const { global, project, favoriteIds } = get();
      if (skill.source.type === "global") {
        set({ global: global.filter((s) => s.id !== skill.id) });
      } else if (skill.source.type === "project") {
        set({ project: project.filter((s) => s.id !== skill.id) });
      }
      // Remove from favorites if needed
      if (favoriteIds.includes(skill.id)) {
        const next = favoriteIds.filter((id) => id !== skill.id);
        set({ favoriteIds: next });
        await invoke("save_skill_favorites", { ids: next });
      }
    } catch (e) {
      console.error("Failed to delete skill:", e);
      throw e;
    }
  },
}));
