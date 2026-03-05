import type { FileEntry } from "../../../types/files";

export type FilesMode = "tree" | "browser";

export interface ContextMenuState {
  x: number;
  y: number;
  /** The entry that was right-clicked (null = background click) */
  entry: FileEntry | null;
  /** The parent directory path for operations */
  dirPath: string;
}
