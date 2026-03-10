import { useCallback, useRef, useState } from "react";
import { useAttachmentStore } from "../stores/attachmentStore";

/**
 * Shared click/dblclick + drag logic for file entries (TreeEntry & BrowserEntry).
 * Single click with 250ms delay to detect double-click.
 */
export function useFileEntryClick(
  path: string,
  isDir: boolean,
  onDirAction: (path: string) => void,
  onFileClick: (path: string) => void,
  onFileDblClick: (path: string) => void,
) {
  const [flash, setFlash] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback(() => {
    if (isDir) {
      onDirAction(path);
      return;
    }
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      onFileDblClick(path);
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null;
        onFileClick(path);
        setFlash(true);
        setTimeout(() => setFlash(false), 400);
      }, 250);
    }
  }, [isDir, path, onDirAction, onFileClick, onFileDblClick]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "copy";
    useAttachmentStore.getState().setDragPath(path);
  }, [path]);

  const handleDragEnd = useCallback(() => {
    useAttachmentStore.getState().setDragPath(null);
  }, []);

  return { flash, handleClick, handleDragStart, handleDragEnd };
}
