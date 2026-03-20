export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  documentCount: number;
}

export interface KnowledgeDocument {
  id: string;
  filename: string;
  path: string;
  sizeBytes: number;
  chunkCount: number;
  addedAt: number;
}

export interface SearchResult {
  chunkText: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  score: number;
}
