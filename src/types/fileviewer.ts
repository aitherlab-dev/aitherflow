/** A single open file tab */
export interface FileTab {
  id: string;
  filePath: string;
  fileName: string;
  isPreview: boolean;
  isModified: boolean;
  content: string | null;
  language: string | null;
  isImage: boolean;
}

/** A single edit hunk (old → new) */
export interface DiffEdit {
  oldString: string;
  newString: string;
}

/** Status of a diff from CLI */
type DiffStatus = "pending" | "accepted" | "rejected";

/** A file diff created by CLI agent (Edit/Write/MultiEdit) */
export interface FileDiff {
  toolUseId: string;
  filePath: string;
  fileName: string;
  toolName: "Edit" | "Write" | "MultiEdit";
  edits: DiffEdit[];
  status: DiffStatus;
  /** File content before the change (for reject/rollback) */
  snapshot: string | null;
}

/** Image file extensions (shared between file viewer and input bar) */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

const IMAGE_SET = new Set(IMAGE_EXTENSIONS);

/** Check if a file path is an image */
export function isImageFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_SET.has(ext);
}
