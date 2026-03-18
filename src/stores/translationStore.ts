import { create } from "zustand";
import { invoke } from "../lib/transport";
import { useSkillStore } from "./skillStore";
import { usePluginStore } from "./pluginStore";
import { useAgentStore } from "./agentStore";
import { useConductorStore } from "./conductorStore";
import { COMMAND_DESCRIPTIONS } from "../data/commandDescriptions";
import type { HooksConfig, HookEntry } from "../types/hooks";

interface TranslationCache {
  language: string;
  entries: Record<string, string>;
}

interface TranslationItem {
  key: string;
  text: string;
}

interface TranslationState {
  cache: TranslationCache;
  loaded: boolean;
  translating: boolean;
  error: string | null;

  /** Load cached translations from disk */
  load: () => Promise<void>;

  /** Translate all content from scratch */
  translateAll: (language: string) => Promise<void>;

  /** Translate only items missing from cache */
  updateTranslations: (language: string) => Promise<void>;

  /** Get a translation by key, or undefined if not translated */
  get: (key: string) => string | undefined;
}

/** Extract translatable descriptions from a hooks config */
function collectHookItems(items: TranslationItem[], hooks: HooksConfig, prefix: string) {
  for (const [event, entries] of Object.entries(hooks)) {
    if (!entries) continue;
    for (let ei = 0; ei < entries.length; ei++) {
      const entry = entries[ei] as HookEntry;
      for (let hi = 0; hi < entry.hooks.length; hi++) {
        const handler = entry.hooks[hi];
        if (handler.statusMessage) {
          items.push({
            key: `hook:${prefix}:${event}:${ei}:${hi}`,
            text: handler.statusMessage,
          });
        }
      }
    }
  }
}

/** Collect all translatable descriptions from skill, plugin, and hook stores */
async function collectItems(): Promise<TranslationItem[]> {
  const items: TranslationItem[] = [];

  const skills = useSkillStore.getState().allSkills();
  for (const s of skills) {
    if (s.description) {
      items.push({ key: `skill:${s.id}`, text: s.description });
    }
  }

  const { installed, available } = usePluginStore.getState();
  for (const p of installed) {
    if (p.description) {
      items.push({ key: `installed-plugin:${p.id}`, text: p.description });
    }
  }
  for (const p of available) {
    if (p.description) {
      items.push({
        key: `available-plugin:${p.name}@${p.marketplace}`,
        text: p.description,
      });
    }
  }

  // Collect CLI command descriptions
  const slashCommands = useConductorStore.getState().slashCommands;
  for (const cmd of slashCommands) {
    const desc = COMMAND_DESCRIPTIONS[cmd];
    if (desc) {
      items.push({ key: `cmd:${cmd}`, text: desc });
    }
  }

  // Collect hook descriptions
  try {
    const globalHooks = await invoke<HooksConfig>("load_hooks", { scope: "global" });
    if (globalHooks) collectHookItems(items, globalHooks, "global");

    const projectPath = useAgentStore.getState().getActiveAgent()?.projectPath;
    if (projectPath) {
      const projectHooks = await invoke<HooksConfig>("load_hooks", { scope: "project", projectPath });
      if (projectHooks) collectHookItems(items, projectHooks, "project");
    }
  } catch (e) {
    console.error("Failed to collect hook translations:", e);
  }

  return items;
}

export const useTranslationStore = create<TranslationState>((set, get) => ({
  cache: { language: "", entries: {} },
  loaded: false,
  translating: false,
  error: null,

  load: async () => {
    try {
      const cache = await invoke<TranslationCache>("load_translations");
      set({ cache, loaded: true });
    } catch (e) {
      console.error("Failed to load translations:", e);
      set({ loaded: true });
    }
  },

  translateAll: async (language) => {
    if (get().translating) return;
    set({ translating: true, error: null });

    try {
      const items = await collectItems();
      const cache = await invoke<TranslationCache>("translate_content", {
        language,
        items,
        force: true,
      });
      set({ cache, translating: false });
    } catch (e) {
      console.error("Translation failed:", e);
      set({ translating: false, error: "Translation failed. Check console for details." });
      // Reload cache to get partial results
      await get().load();
      throw e;
    }
  },

  updateTranslations: async (language) => {
    if (get().translating) return;
    set({ translating: true, error: null });

    try {
      const items = await collectItems();
      const cache = await invoke<TranslationCache>("translate_content", {
        language,
        items,
        force: false,
      });
      set({ cache, translating: false });
    } catch (e) {
      console.error("Translation update failed:", e);
      set({ translating: false, error: "Translation update failed. Check console for details." });
      await get().load();
      throw e;
    }
  },

  get: (key) => {
    return get().cache.entries[key];
  },
}));

// Load cache on startup
useTranslationStore.getState().load().catch(console.error);
