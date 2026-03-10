import { create } from "zustand";
import { invoke } from "../lib/transport";
import type {
  SkillEntry,
  SkillsData,
  SkillFavorites,
  PluginSkillGroup,
  ProjectSkillGroup,
} from "../types/skills";

interface ProjectInfo {
  path: string;
  name: string;
}

interface SkillState {
  global: SkillEntry[];
  projects: ProjectSkillGroup[];
  plugins: PluginSkillGroup[];
  favoriteIds: string[];
  loaded: boolean;

  /** Load all skills for all registered projects */
  load: (projectList: ProjectInfo[]) => Promise<void>;

  /** Toggle a skill as favorite */
  toggleFavorite: (skillId: string) => Promise<void>;

  /** Get all skills as a flat list */
  allSkills: () => SkillEntry[];

  /** Get favorite skills */
  getFavorites: () => SkillEntry[];

  /** Delete a user skill (global or project) */
  deleteSkill: (skill: SkillEntry) => Promise<void>;

  /** Move a skill to a different location (global ↔ project) */
  moveSkill: (skill: SkillEntry, targetType: "global" | "project", projectPath: string | null, newName?: string) => Promise<void>;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  global: [],
  projects: [],
  plugins: [],
  favoriteIds: [],
  loaded: false,

  load: async (projectList) => {
    try {
      const [data, favs] = await Promise.all([
        invoke<SkillsData>("load_skills", { projectList }),
        invoke<SkillFavorites>("load_skill_favorites"),
      ]);
      set({
        global: data.global,
        projects: data.projects,
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
    const { global, projects, plugins } = get();
    return [
      ...global,
      ...projects.flatMap((p) => p.skills),
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
      const { global, projects, favoriteIds } = get();
      if (skill.source.type === "global") {
        set({ global: global.filter((s) => s.id !== skill.id) });
      } else if (skill.source.type === "project") {
        set({
          projects: projects.map((pg) => ({
            ...pg,
            skills: pg.skills.filter((s) => s.id !== skill.id),
          })).filter((pg) => pg.skills.length > 0),
        });
      }
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

  moveSkill: async (skill, targetType, projectPath, newName) => {
    try {
      const newFilePath = await invoke<string>("move_skill", {
        filePath: skill.filePath,
        targetType,
        projectPath: projectPath ?? null,
        newName: newName ?? null,
      });

      const dirName = newName ?? skill.id.replace(/^project:[^:]+:/, "");
      const newSource: SkillEntry["source"] = targetType === "global"
        ? { type: "global" }
        : { type: "project", projectPath: projectPath! };
      const movedSkill: SkillEntry = {
        ...skill,
        id: targetType === "project" ? `project:${projectPath}:${dirName}` : dirName,
        source: newSource,
        filePath: newFilePath,
      };

      // Remove from old location
      const { global, projects } = get();
      if (skill.source.type === "global") {
        set({ global: global.filter((s) => s.id !== skill.id) });
      } else if (skill.source.type === "project") {
        set({
          projects: projects.map((pg) => ({
            ...pg,
            skills: pg.skills.filter((s) => s.id !== skill.id),
          })).filter((pg) => pg.skills.length > 0),
        });
      }

      // Add to new location
      if (targetType === "global") {
        set({ global: [...get().global, movedSkill] });
      } else {
        const currentProjects = get().projects;
        const existing = currentProjects.find((pg) => pg.projectPath === projectPath);
        if (existing) {
          set({
            projects: currentProjects.map((pg) =>
              pg.projectPath === projectPath
                ? { ...pg, skills: [...pg.skills, movedSkill] }
                : pg,
            ),
          });
        } else {
          // Project group doesn't exist yet — create it
          const name = projectPath!.split("/").pop() ?? projectPath!;
          set({
            projects: [...currentProjects, { projectPath: projectPath!, projectName: name, skills: [movedSkill] }],
          });
        }
      }
    } catch (e) {
      console.error("Failed to move skill:", e);
      throw e;
    }
  },
}));
