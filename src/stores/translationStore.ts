import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useSkillStore } from "./skillStore";
import { usePluginStore } from "./pluginStore";

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

/** Collect all translatable descriptions from skill and plugin stores */
function collectItems(): TranslationItem[] {
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
      const items = collectItems();
      const cache = await invoke<TranslationCache>("translate_content", {
        language,
        items,
        force: true,
      });
      set({ cache, translating: false });
    } catch (e) {
      const msg = String(e);
      console.error("Translation failed:", msg);
      set({ translating: false, error: msg });
      // Reload cache to get partial results
      await get().load();
      throw e;
    }
  },

  updateTranslations: async (language) => {
    if (get().translating) return;
    set({ translating: true, error: null });

    try {
      const items = collectItems();
      const cache = await invoke<TranslationCache>("translate_content", {
        language,
        items,
        force: false,
      });
      set({ cache, translating: false });
    } catch (e) {
      const msg = String(e);
      console.error("Translation update failed:", msg);
      set({ translating: false, error: msg });
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
