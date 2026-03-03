/** A single skill (user-created or from plugin) */
export interface SkillEntry {
  /** Unique key: "blog-post" or "plugin-dev:skill-development" */
  id: string;
  /** Human-readable name from YAML frontmatter */
  name: string;
  /** Short description from YAML frontmatter */
  description: string;
  /** Slash-command to invoke: "/blog-post", "/feature-dev" */
  command: string;
  /** Where the skill lives */
  source: SkillSource;
  /** Absolute path to the SKILL.md or COMMAND.md file */
  filePath: string;
}

export type SkillSource =
  | { type: "global" }
  | { type: "project"; projectPath: string }
  | { type: "plugin"; pluginName: string; marketplace: string };

/** All skills grouped for the sidebar tree */
export interface SkillsData {
  global: SkillEntry[];
  project: SkillEntry[];
  plugins: PluginSkillGroup[];
}

/** Skills from one installed plugin */
export interface PluginSkillGroup {
  pluginName: string;
  marketplace: string;
  skills: SkillEntry[];
}

/** Favorites config (stored in our own config) */
export interface SkillFavorites {
  /** Skill IDs that are favorited */
  ids: string[];
}
