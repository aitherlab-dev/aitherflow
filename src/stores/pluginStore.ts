import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  InstalledPlugin,
  AvailablePlugin,
  MarketplaceSource,
  PluginsData,
} from "../types/plugins";

interface PluginState {
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
  sources: MarketplaceSource[];
  loaded: boolean;
  installing: Set<string>;
  uninstalling: Set<string>;
  updatingSources: boolean;

  /** Load all plugin data from disk */
  load: () => Promise<void>;

  /** Install a plugin from a marketplace */
  install: (name: string, marketplace: string) => Promise<void>;

  /** Uninstall a plugin */
  uninstall: (name: string, marketplace: string) => Promise<void>;

  /** Add a new marketplace source */
  addSource: (
    name: string,
    sourceType: string,
    url: string,
  ) => Promise<void>;

  /** Remove a marketplace source */
  removeSource: (name: string) => Promise<void>;

  /** Update all marketplace sources (git pull) */
  updateSources: () => Promise<void>;
}

export const usePluginStore = create<PluginState>((set, get) => ({
  installed: [],
  available: [],
  sources: [],
  loaded: false,
  installing: new Set(),
  uninstalling: new Set(),
  updatingSources: false,

  load: async () => {
    try {
      const data = await invoke<PluginsData>("load_plugins");
      set({
        installed: data.installed,
        available: data.available,
        sources: data.sources,
        loaded: true,
      });
    } catch (e) {
      console.error("Failed to load plugins:", e);
    }
  },

  install: async (name, marketplace) => {
    const key = `${name}@${marketplace}`;
    const { installing } = get();
    if (installing.has(key)) return;

    set({ installing: new Set([...installing, key]) });

    try {
      await invoke("install_plugin", { name, marketplace });
      // Reload to get fresh data
      await get().load();
    } catch (e) {
      console.error("Failed to install plugin:", e);
      throw e;
    } finally {
      const current = get().installing;
      const next = new Set(current);
      next.delete(key);
      set({ installing: next });
    }
  },

  uninstall: async (name, marketplace) => {
    const key = `${name}@${marketplace}`;
    const { uninstalling } = get();
    if (uninstalling.has(key)) return;

    set({ uninstalling: new Set([...uninstalling, key]) });

    try {
      await invoke("uninstall_plugin", { name, marketplace });
      await get().load();
    } catch (e) {
      console.error("Failed to uninstall plugin:", e);
      throw e;
    } finally {
      const current = get().uninstalling;
      const next = new Set(current);
      next.delete(key);
      set({ uninstalling: next });
    }
  },

  addSource: async (name, sourceType, url) => {
    try {
      await invoke("add_marketplace", { name, sourceType, url });
      await get().load();
    } catch (e) {
      console.error("Failed to add marketplace:", e);
      throw e;
    }
  },

  removeSource: async (name) => {
    try {
      await invoke("remove_marketplace", { name });
      await get().load();
    } catch (e) {
      console.error("Failed to remove marketplace:", e);
      throw e;
    }
  },

  updateSources: async () => {
    if (get().updatingSources) return;
    set({ updatingSources: true });

    try {
      await invoke("update_marketplaces");
      await get().load();
    } catch (e) {
      console.error("Failed to update marketplaces:", e);
      throw e;
    } finally {
      set({ updatingSources: false });
    }
  },
}));
