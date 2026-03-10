import { memo, useCallback } from "react";
import { Folder, File } from "lucide-react";
import type { FileEntry } from "../../../types/files";
import { InlineNameInput } from "./InlineNameInput";
import { useFileEntryClick } from "../../../hooks/useFileEntryClick";

export const BrowserEntry = memo(function BrowserEntry({
  entry,
  renamingPath,
  onNavigate,
  onFileClick,
  onFileDblClick,
  onContextMenu,
  onRenameSubmit,
  onRenameCancel,
}: {
  entry: FileEntry;
  renamingPath: string | null;
  onNavigate: (path: string) => void;
  onFileClick: (path: string) => void;
  onFileDblClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: () => void;
}) {
  const isRenaming = renamingPath === entry.path;
  const { flash, handleClick, handleDragStart, handleDragEnd } = useFileEntryClick(
    entry.path, entry.isDir, onNavigate, onFileClick, onFileDblClick,
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onContextMenu(e, entry),
    [onContextMenu, entry],
  );

  return (
    <div
      className={`files-entry ${entry.isDir ? "files-entry--dir" : "files-entry--file"} ${flash ? "files-entry--flash" : ""}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      draggable={!entry.isDir}
      onDragStart={!entry.isDir ? handleDragStart : undefined}
      onDragEnd={!entry.isDir ? handleDragEnd : undefined}
    >
      {entry.isDir ? (
        <Folder size={16} className="files-entry__icon files-entry__icon--dir" />
      ) : (
        <File size={16} className="files-entry__icon files-entry__icon--file" />
      )}
      {isRenaming ? (
        <InlineNameInput
          placeholder={entry.name}
          initialValue={entry.name}
          selectStem={!entry.isDir}
          onSubmit={onRenameSubmit}
          onCancel={onRenameCancel}
        />
      ) : (
        <span className="files-entry__name">{entry.name}</span>
      )}
    </div>
  );
});
