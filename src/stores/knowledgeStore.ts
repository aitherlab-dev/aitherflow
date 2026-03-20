import { create } from "zustand";
import { invoke } from "../lib/transport";
import type { KnowledgeBase, KnowledgeDocument, SearchResult } from "../types/knowledge";

interface KnowledgeState {
  bases: KnowledgeBase[];
  selectedBaseId: string | null;
  documents: KnowledgeDocument[];
  searchResults: SearchResult[];
  searchQuery: string;
  isSearching: boolean;
  error: string | null;
  _errorTimer: ReturnType<typeof setTimeout> | null;

  loadBases: () => Promise<void>;
  createBase: (name: string, description: string) => Promise<void>;
  deleteBase: (baseId: string) => Promise<void>;
  selectBase: (baseId: string | null) => void;
  loadDocuments: (baseId: string) => Promise<void>;
  addDocuments: (baseId: string, paths: string[]) => Promise<void>;
  addUrl: (baseId: string, url: string) => Promise<void>;
  addYoutube: (baseId: string, url: string) => Promise<void>;
  removeDocument: (baseId: string, documentId: string) => Promise<void>;
  search: (baseId: string, query: string) => Promise<void>;
  clearError: () => void;
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

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  bases: [],
  selectedBaseId: null,
  documents: [],
  searchResults: [],
  searchQuery: "",
  isSearching: false,
  error: null,
  _errorTimer: null,

  clearError: () => {
    const timer = get()._errorTimer;
    if (timer) clearTimeout(timer);
    set({ error: null, _errorTimer: null });
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

  addDocuments: async (baseId, paths) => {
    try {
      await invoke("rag_add_documents", { baseId, paths });
      await get().loadDocuments(baseId);
      await get().loadBases();
    } catch (e) {
      console.error("Failed to add documents:", e);
      setErrorWithAutoClear(set, get, `Failed to add documents: ${errorMessage(e)}`);
    }
  },

  addUrl: async (baseId, url) => {
    try {
      await invoke("rag_add_url", { baseId, url });
      await get().loadDocuments(baseId);
      await get().loadBases();
    } catch (e) {
      console.error("Failed to add URL:", e);
      setErrorWithAutoClear(set, get, `Failed to add URL: ${errorMessage(e)}`);
    }
  },

  addYoutube: async (baseId, url) => {
    try {
      await invoke("rag_add_youtube", { baseId, url });
      await get().loadDocuments(baseId);
      await get().loadBases();
    } catch (e) {
      console.error("Failed to add YouTube video:", e);
      setErrorWithAutoClear(set, get, `Failed to add YouTube video: ${errorMessage(e)}`);
    }
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
}));
