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

  loadBases: () => Promise<void>;
  createBase: (name: string, description: string) => Promise<void>;
  deleteBase: (baseId: string) => Promise<void>;
  selectBase: (baseId: string | null) => void;
  loadDocuments: (baseId: string) => Promise<void>;
  addDocuments: (baseId: string, paths: string[]) => Promise<void>;
  removeDocument: (baseId: string, documentId: string) => Promise<void>;
  search: (baseId: string, query: string) => Promise<void>;
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  bases: [],
  selectedBaseId: null,
  documents: [],
  searchResults: [],
  searchQuery: "",
  isSearching: false,

  loadBases: async () => {
    try {
      const bases = await invoke<KnowledgeBase[]>("rag_list_bases");
      set({ bases });
    } catch (e) {
      console.error("Failed to load knowledge bases:", e);
      set({ bases: [] });
    }
  },

  createBase: async (name, description) => {
    try {
      await invoke("rag_create_base", { name, description });
      await get().loadBases();
    } catch (e) {
      console.error("Failed to create knowledge base:", e);
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
    }
  },

  selectBase: (baseId) => {
    set({ selectedBaseId: baseId, documents: [], searchResults: [], searchQuery: "" });
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
    }
  },

  removeDocument: async (baseId, documentId) => {
    try {
      await invoke("rag_remove_document", { baseId, documentId });
      await get().loadDocuments(baseId);
      await get().loadBases();
    } catch (e) {
      console.error("Failed to remove document:", e);
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
    }
  },
}));
