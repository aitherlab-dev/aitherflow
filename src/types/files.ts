export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface MountEntry {
  name: string;
  path: string;
}

export interface ProcessFileResult {
  name: string;
  content: string;
  size: number;
  fileType: string;
}
