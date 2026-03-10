import { memo, useEffect, useRef, useState } from "react";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { createPortal } from "react-dom";
import { Pencil, Pin, Trash2 } from "lucide-react";
import type { ChatMeta } from "../../../stores/chatStore";

interface ChatContextMenuProps {
  x: number;
  y: number;
  chat: ChatMeta;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export const ChatContextMenu = memo(function ChatContextMenu({
  x,
  y,
  chat,
  onRename,
  onTogglePin,
  onDelete,
  onClose,
}: ChatContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width > vw) nx = vw - rect.width - 4;
    if (ny + rect.height > vh) ny = vh - rect.height - 4;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useClickOutside(ref, onClose);

  return createPortal(
    <div ref={ref} className="chat-context-menu" style={{ left: pos.x, top: pos.y }}>
      <button type="button" className="chat-context-menu__item" onClick={onRename}>
        <Pencil size={14} />
        <span>Rename</span>
      </button>
      <button type="button" className="chat-context-menu__item" onClick={onTogglePin}>
        <Pin size={14} />
        <span>{chat.pinned ? "Unpin" : "Pin to top"}</span>
      </button>
      <div className="chat-context-menu__sep" />
      <button type="button" className="chat-context-menu__item chat-context-menu__item--danger" onClick={onDelete}>
        <Trash2 size={14} />
        <span>Delete</span>
      </button>
    </div>,
    document.body,
  );
});
