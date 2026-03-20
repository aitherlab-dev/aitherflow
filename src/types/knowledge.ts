export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  created_at: string;
  document_count: number;
  total_chunks: number;
  status: "ready" | "indexing" | "error";
}

export interface KnowledgeDocument {
  id: string;
  base_id: string;
  filename: string;
  source_type: "file" | "url" | "youtube";
  source_path: string;
  chunk_count: number;
  added_at: string;
  status: "indexed" | "indexing" | "error";
}

export interface SearchResult {
  text: string;
  document_id: string;
  chunk_index: number;
  score: number;
}
