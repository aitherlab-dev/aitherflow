import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Copy,
  ClipboardPaste,
  FolderPlus,
  FilePlus,
  Clipboard,
  Trash2,
} from "lucide-react";
import type { ContextMenuState } from "./types";

export const FileContextMenu = memo(function FileContextMenu({
  menu,
  copiedPath,
  onCopyPath,
  onCopy,
  onDelete,
  onPaste,
  onNewFolder,
  onNewFile,
  onClose,
}: {
  menu: ContextMenuState;
  copiedPath: string | null;
  onCopyPath: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onPaste: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") onClose();
    };
    // Use capture so this fires before onClick handlers on buttons
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Adjust position so menu doesn't overflow viewport
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = menu;
    if (x + rect.width > vw) x = vw - rect.width - 4;
    if (y + rect.height > vh) y = vh - rect.height - 4;
    setPos({ x, y });
  }, [menu]);

  return createPortal(
    <div
      ref={ref}
      className="files-context-menu"
      style={{ left: pos.x, top: pos.y }}
    >
      {menu.entry && (
        <>
          <button type="button" className="files-context-menu__item" onClick={onCopyPath}>
            <Clipboard size={14} />
            <span>Copy Path</span>
          </button>
          <button type="button" className="files-context-menu__item" onClick={onCopy}>
            <Copy size={14} />
            <span>Copy</span>
          </button>
          <button
            type="button"
            className="files-context-menu__item files-context-menu__item--danger"
            onClick={onDelete}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </button>
        </>
      )}
      <button
        type="button"
        className="files-context-menu__item"
        onClick={onPaste}
        disabled={!copiedPath}
      >
        <ClipboardPaste size={14} />
        <span>Paste</span>
      </button>
      <div className="files-context-menu__sep" />
      <button type="button" className="files-context-menu__item" onClick={onNewFolder}>
        <FolderPlus size={14} />
        <span>New Folder</span>
      </button>
      <button type="button" className="files-context-menu__item" onClick={onNewFile}>
        <FilePlus size={14} />
        <span>New File</span>
      </button>
    </div>,
    document.body,
  );
});
