import { memo, useCallback } from "react";
import {
  Folder,
  FolderOpen,
  File,
  ChevronRight,
} from "lucide-react";
import type { FileEntry } from "../../../types/files";
import { InlineNameInput } from "./InlineNameInput";
import { useFileEntryClick } from "../../../hooks/useFileEntryClick";

export const TreeEntry = memo(function TreeEntry({
  entry,
  depth,
  expanded,
  renamingPath,
  onToggle,
  onFileClick,
  onFileDblClick,
  onContextMenu,
  onRenameSubmit,
  onRenameCancel,
  children,
}: {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  renamingPath: string | null;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  onFileDblClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: () => void;
  children?: React.ReactNode;
}) {
  const isRenaming = renamingPath === entry.path;
  const { flash, handleClick, handleDragStart, handleDragEnd } = useFileEntryClick(
    entry.path, entry.isDir, onToggle, onFileClick, onFileDblClick,
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onContextMenu(e, entry),
    [onContextMenu, entry],
  );

  return (
    <>
      <div
        className={`files-entry ${entry.isDir ? "files-entry--dir" : "files-entry--file"} ${flash ? "files-entry--flash" : ""}`}
        style={{ paddingLeft: entry.isDir ? depth * 20 + 8 : depth * 20 + 30 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable={!entry.isDir}
        onDragStart={!entry.isDir ? handleDragStart : undefined}
        onDragEnd={!entry.isDir ? handleDragEnd : undefined}
      >
        {entry.isDir ? (
          <>
            <ChevronRight
              size={12}
              className={`files-entry__chevron ${expanded ? "files-entry__chevron--open" : ""}`}
            />
            {expanded ? (
              <FolderOpen size={16} className="files-entry__icon files-entry__icon--dir" />
            ) : (
              <Folder size={16} className="files-entry__icon files-entry__icon--dir" />
            )}
          </>
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
      {expanded && children}
    </>
  );
});

export function TreeLevel({
  parentPath,
  depth,
  expandedSet,
  childrenCache,
  renamingPath,
  onToggle,
  onFileClick,
  onFileDblClick,
  onContextMenu,
  onRenameSubmit,
  onRenameCancel,
  inlineInput,
  onInlineSubmit,
  onInlineCancel,
}: {
  parentPath: string;
  depth: number;
  expandedSet: Set<string>;
  childrenCache: Map<string, FileEntry[]>;
  renamingPath: string | null;
  onToggle: (path: string) => void;
  onFileClick: (path: string) => void;
  onFileDblClick: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onRenameSubmit: (name: string) => void;
  onRenameCancel: () => void;
  inlineInput: { type: "folder" | "file"; dirPath: string } | null;
  onInlineSubmit: (name: string) => void;
  onInlineCancel: () => void;
}) {
  const entries = childrenCache.get(parentPath);
  if (!entries) return null;

  return (
    <>
      {entries.map((entry) => (
        <TreeEntry
          key={entry.path}
          entry={entry}
          depth={depth}
          expanded={expandedSet.has(entry.path)}
          renamingPath={renamingPath}
          onToggle={onToggle}
          onFileClick={onFileClick}
          onFileDblClick={onFileDblClick}
          onContextMenu={onContextMenu}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
        >
          {entry.isDir && expandedSet.has(entry.path) && (
            <TreeLevel
              parentPath={entry.path}
              depth={depth + 1}
              expandedSet={expandedSet}
              childrenCache={childrenCache}
              renamingPath={renamingPath}
              onToggle={onToggle}
              onFileClick={onFileClick}
              onFileDblClick={onFileDblClick}
              onContextMenu={onContextMenu}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              inlineInput={inlineInput}
              onInlineSubmit={onInlineSubmit}
              onInlineCancel={onInlineCancel}
            />
          )}
        </TreeEntry>
      ))}
      {inlineInput && inlineInput.dirPath === parentPath && (
        <InlineNameInput
          placeholder={inlineInput.type === "folder" ? "Folder name" : "File name"}
          onSubmit={onInlineSubmit}
          onCancel={onInlineCancel}
        />
      )}
    </>
  );
}
