import { memo, useCallback, useRef, useState } from "react";
import { Folder, File } from "lucide-react";
import { useAttachmentStore } from "../../../stores/attachmentStore";
import type { FileEntry } from "../../../types/files";
import { InlineNameInput } from "./InlineNameInput";

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
  const [flash, setFlash] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback(() => {
    if (entry.isDir) {
      onNavigate(entry.path);
      return;
    }
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      onFileDblClick(entry.path);
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null;
        onFileClick(entry.path);
        setFlash(true);
        setTimeout(() => setFlash(false), 400);
      }, 250);
    }
  }, [entry.isDir, entry.path, onNavigate, onFileClick, onFileDblClick]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", entry.path);
    e.dataTransfer.effectAllowed = "copy";
    useAttachmentStore.getState().setDragPath(entry.path);
  }, [entry.path]);

  const handleDragEnd = useCallback(() => {
    useAttachmentStore.getState().setDragPath(null);
  }, []);

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
