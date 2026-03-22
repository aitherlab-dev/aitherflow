import { create } from "zustand";
import { invoke, listen } from "../lib/transport";
import type { KnowledgeBase, KnowledgeDocument, RagSettings, SearchResult } from "../types/knowledge";

// --- Progress types ---

export interface BgOperation {
  type: "add" | "playlist" | "reindex" | "url" | "youtube";
  processed: number;
  total: number;
  label: string;
  baseId: string;
}

export interface BgResult {
  type: "add" | "playlist" | "reindex" | "url" | "youtube";
  message: string;
  baseId: string;
}

interface PlaylistProgressEvent {
  processed: number;
  total: number;
  currentTitle: string;
  skipped: number;
}

interface ReindexProgressEvent {
  processed: number;
  total: number;
  currentFilename: string;
}

interface AddProgressEvent {
  processed: number;
  total: number;
  currentFilename: string;
}

export interface PlaylistSummary {
  added: number;
  skipped: number;
  total: number;
  isPlaylist: boolean;
}

export interface ReindexSummary {
  reindexed: number;
  skipped: number;
  total: number;
}

// --- Store ---

interface KnowledgeState {
  bases: KnowledgeBase[];
  selectedBaseId: string | null;
  documents: KnowledgeDocument[];
  searchResults: SearchResult[];
  searchQuery: string;
  isSearching: boolean;
  error: string | null;
  _errorTimer: ReturnType<typeof setTimeout> | null;
  ragSettings: RagSettings | null;

  /** Current background operation progress (non-blocking). */
  bgOperation: BgOperation | null;
  /** Result of last completed background operation (auto-clears after 5s). */
  bgResult: BgResult | null;
  _bgResultTimer: ReturnType<typeof setTimeout> | null;

  loadBases: () => Promise<void>;
  createBase: (name: string, description: string) => Promise<void>;
  deleteBase: (baseId: string) => Promise<void>;
  selectBase: (baseId: string | null) => void;
  loadDocuments: (baseId: string) => Promise<void>;
  /** Fire-and-forget: starts operation, does NOT await completion. */
  addDocuments: (baseId: string, paths: string[]) => void;
  /** Fire-and-forget. */
  addUrl: (baseId: string, url: string) => void;
  /** Fire-and-forget. */
  addYoutube: (baseId: string, url: string) => void;
  removeDocument: (baseId: string, documentId: string) => Promise<void>;
  /** Fire-and-forget. */
  reindexBase: (baseId: string) => void;
  search: (baseId: string, query: string) => Promise<void>;
  clearError: () => void;
  clearBgResult: () => void;
  loadRagSettings: () => Promise<void>;
  saveRagSettings: (settings: RagSettings) => Promise<boolean>;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function setErrorWithAutoClear(
  set: (s: Partial<KnowledgeState>) => void,
  get: () => KnowledgeState,
  msg: string,
) {
  const prev = get()._errorTimer;
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => set({ error: null, _errorTimer: null }), 5000);
  set({ error: msg, _errorTimer: timer });
}

function setBgResult(
  set: (s: Partial<KnowledgeState>) => void,
  get: () => KnowledgeState,
  type: BgResult["type"],
  message: string,
  baseId: string,
) {
  const prev = get()._bgResultTimer;
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => set({ bgResult: null, _bgResultTimer: null }), 5000);
  set({ bgOperation: null, bgResult: { type, message, baseId }, _bgResultTimer: timer });
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  bases: [],
  selectedBaseId: null,
  documents: [],
  searchResults: [],
  searchQuery: "",
  isSearching: false,
  error: null,
  _errorTimer: null,
  ragSettings: null,
  bgOperation: null,
  bgResult: null,
  _bgResultTimer: null,

  clearError: () => {
    const timer = get()._errorTimer;
    if (timer) clearTimeout(timer);
    set({ error: null, _errorTimer: null });
  },

  clearBgResult: () => {
    const timer = get()._bgResultTimer;
    if (timer) clearTimeout(timer);
    set({ bgResult: null, _bgResultTimer: null });
  },

  loadBases: async () => {
    try {
      const bases = await invoke<KnowledgeBase[]>("rag_list_bases");
      set({ bases });
    } catch (e) {
      console.error("Failed to load knowledge bases:", e);
      setErrorWithAutoClear(set, get, `Failed to load knowledge bases: ${errorMessage(e)}`);
      set({ bases: [] });
    }
  },

  createBase: async (name, description) => {
    try {
      await invoke("rag_create_base", { name, description });
      await get().loadBases();
    } catch (e) {
      console.error("Failed to create knowledge base:", e);
      setErrorWithAutoClear(set, get, `Failed to create knowledge base: ${errorMessage(e)}`);
    }
  },

  deleteBase: async (baseId) => {
    try {
      await invoke("rag_delete_base", { baseId });
      const state = get();
      if (state.selectedBaseId === baseId) {
        set({ selectedBaseId: null, documents: [], searchResults: [], searchQuery: "" });
      }
      await state.loadBases();
    } catch (e) {
      console.error("Failed to delete knowledge base:", e);
      setErrorWithAutoClear(set, get, `Failed to delete knowledge base: ${errorMessage(e)}`);
    }
  },

  selectBase: (baseId) => {
    set({ selectedBaseId: baseId, documents: [], searchResults: [], searchQuery: "", error: null });
    if (baseId) {
      get().loadDocuments(baseId).catch(console.error);
    }
  },

  loadDocuments: async (baseId) => {
    try {
      const documents = await invoke<KnowledgeDocument[]>("rag_list_documents", { baseId });
      set({ documents });
    } catch (e) {
      console.error("Failed to load documents:", e);
      setErrorWithAutoClear(set, get, `Failed to load documents: ${errorMessage(e)}`);
      set({ documents: [] });
    }
  },

  addDocuments: (baseId, paths) => {
    set({
      bgOperation: { type: "add", processed: 0, total: paths.length, label: "Adding documents…", baseId },
    });

    // Fire-and-forget
    (async () => {
      let unlisten: (() => void) | null = null;
      try {
        unlisten = await listen<AddProgressEvent>("rag-add-progress", (event) => {
          const p = event.payload;
          set({
            bgOperation: {
              type: "add",
              processed: p.processed,
              total: p.total,
              label: p.currentFilename || "Adding documents…",
              baseId,
            },
          });
        });

        await invoke("rag_add_documents", { baseId, paths });
        await get().loadDocuments(baseId);
        await get().loadBases();
        setBgResult(set, get, "add", `Added ${paths.length} document${paths.length > 1 ? "s" : ""}`, baseId);
      } catch (e) {
        console.error("Failed to add documents:", e);
        // Load partial results even on error
        await get().loadDocuments(baseId).catch(console.error);
        await get().loadBases().catch(console.error);
        set({ bgOperation: null });
        setErrorWithAutoClear(set, get, `Failed to add documents: ${errorMessage(e)}`);
      } finally {
        if (unlisten) unlisten();
      }
    })();
  },

  addUrl: (baseId, url) => {
    set({
      bgOperation: { type: "url", processed: 0, total: 0, label: "Fetching URL…", baseId },
    });

    (async () => {
      try {
        await invoke("rag_add_url", { baseId, url });
        await get().loadDocuments(baseId);
        await get().loadBases();
        setBgResult(set, get, "url", "URL added", baseId);
      } catch (e) {
        console.error("Failed to add URL:", e);
        set({ bgOperation: null });
        setErrorWithAutoClear(set, get, `Failed to add URL: ${errorMessage(e)}`);
      }
    })();
  },

  addYoutube: (baseId, url) => {
    set({
      bgOperation: { type: "youtube", processed: 0, total: 0, label: "Fetching YouTube…", baseId },
    });

    (async () => {
      let unlisten: (() => void) | null = null;
      try {
        unlisten = await listen<PlaylistProgressEvent>("rag-playlist-progress", (event) => {
          const p = event.payload;
          set({
            bgOperation: {
              type: "playlist",
              processed: p.processed,
              total: p.total,
              label: p.currentTitle || "Adding videos…",
              baseId,
            },
          });
        });

        const summary = await invoke<PlaylistSummary>("rag_add_youtube", { baseId, url });
        await get().loadDocuments(baseId);
        await get().loadBases();

        if (summary.isPlaylist) {
          const msg = `Added ${summary.added}/${summary.total} videos${summary.skipped > 0 ? `, ${summary.skipped} skipped` : ""}`;
          setBgResult(set, get, "playlist", msg, baseId);
        } else {
          setBgResult(set, get, "youtube", "YouTube video added", baseId);
        }
      } catch (e) {
        console.error("Failed to add YouTube:", e);
        set({ bgOperation: null });
        setErrorWithAutoClear(set, get, `Failed to add YouTube: ${errorMessage(e)}`);
      } finally {
        if (unlisten) unlisten();
      }
    })();
  },

  removeDocument: async (baseId, documentId) => {
    try {
      await invoke("rag_remove_document", { baseId, documentId });
      await get().loadDocuments(baseId);
      await get().loadBases();
    } catch (e) {
      console.error("Failed to remove document:", e);
      setErrorWithAutoClear(set, get, `Failed to remove document: ${errorMessage(e)}`);
    }
  },

  reindexBase: (baseId) => {
    set({
      bgOperation: { type: "reindex", processed: 0, total: 0, label: "Starting reindex…", baseId },
    });

    (async () => {
      let unlisten: (() => void) | null = null;
      try {
        unlisten = await listen<ReindexProgressEvent>("rag-reindex-progress", (event) => {
          const p = event.payload;
          set({
            bgOperation: {
              type: "reindex",
              processed: p.processed,
              total: p.total,
              label: p.currentFilename || "Reindexing…",
              baseId,
            },
          });
        });

        const summary = await invoke<ReindexSummary>("rag_reindex_base", { baseId });
        await get().loadDocuments(baseId);
        await get().loadBases();

        const msg = `Reindexed ${summary.reindexed}/${summary.total}${summary.skipped > 0 ? `, ${summary.skipped} skipped` : ""}`;
        setBgResult(set, get, "reindex", msg, baseId);
      } catch (e) {
        console.error("Failed to reindex base:", e);
        set({ bgOperation: null });
        setErrorWithAutoClear(set, get, `Failed to reindex: ${errorMessage(e)}`);
      } finally {
        if (unlisten) unlisten();
      }
    })();
  },

  search: async (baseId, query) => {
    set({ searchQuery: query, isSearching: true });
    try {
      const searchResults = await invoke<SearchResult[]>("rag_search", { baseId, query });
      set({ searchResults, isSearching: false });
    } catch (e) {
      console.error("Failed to search:", e);
      set({ searchResults: [], isSearching: false });
      setErrorWithAutoClear(set, get, `Search failed: ${errorMessage(e)}`);
    }
  },

  loadRagSettings: async () => {
    try {
      const ragSettings = await invoke<RagSettings>("rag_load_settings");
      set({ ragSettings });
    } catch (e) {
      console.error("Failed to load RAG settings:", e);
      setErrorWithAutoClear(set, get, `Failed to load RAG settings: ${errorMessage(e)}`);
    }
  },

  saveRagSettings: async (settings) => {
    try {
      const modelChanged = await invoke<boolean>("rag_save_settings", { settings });
      set({ ragSettings: settings });
      return modelChanged;
    } catch (e) {
      console.error("Failed to save RAG settings:", e);
      setErrorWithAutoClear(set, get, `Failed to save settings: ${errorMessage(e)}`);
      return false;
    }
  },
}));
