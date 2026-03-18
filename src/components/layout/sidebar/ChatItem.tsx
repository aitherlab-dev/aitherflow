import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Pin, Trash2 } from "lucide-react";
import type { ChatMeta } from "../../../stores/chatStore";
import { Tooltip } from "../../shared/Tooltip";

export const ChatItem = memo(function ChatItem({
  chat,
  isCurrent,
  disabled,
  locked,
  isEditing,
  onSelect,
  onDelete,
  onContextMenu,
  onRenameSubmit,
  onRenameCancel,
}: {
  chat: ChatMeta;
  isCurrent: boolean;
  disabled: boolean;
  locked: boolean;
  isEditing: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, chatId: string) => void;
  onRenameSubmit: (id: string, newTitle: string) => void;
  onRenameCancel: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    if (!disabled && !locked && !isCurrent) onSelect(chat.id);
  }, [chat.id, disabled, locked, isCurrent, onSelect]);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!disabled && !locked && !removing) {
        setRemoving(true);
        setTimeout(() => onDelete(chat.id), 250);
      }
    },
    [chat.id, disabled, locked, removing, onDelete],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!disabled && !locked) onContextMenu(e, chat.id);
    },
    [chat.id, disabled, locked, onContextMenu],
  );

  // Inline rename
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.code === "Enter") {
        onRenameSubmit(chat.id, (e.target as HTMLInputElement).value);
      } else if (e.code === "Escape") {
        onRenameCancel();
      }
    },
    [chat.id, onRenameSubmit, onRenameCancel],
  );

  const handleRenameBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      onRenameSubmit(chat.id, e.target.value);
    },
    [chat.id, onRenameSubmit],
  );

  const displayTitle = chat.customTitle || chat.title;

  return (
    <div
      className={`chat-item ${isCurrent ? "chat-item--active" : ""} ${disabled ? "chat-item--disabled" : ""} ${locked ? "chat-item--locked" : ""} ${removing ? "chat-item--removing" : ""} ${chat.pinned ? "chat-item--pinned" : ""}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {chat.pinned && <Pin size={10} className="chat-item__pin" />}
      {isEditing ? (
        <input
          ref={inputRef}
          className="chat-item__rename-input"
          defaultValue={displayTitle}
          onKeyDown={handleRenameKeyDown}
          onBlur={handleRenameBlur}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="chat-item__title">{displayTitle}</span>
      )}
      {!disabled && !locked && !isEditing && (
        <Tooltip text="Delete chat">
          <button
            className="chat-item__delete"
            onClick={handleDelete}
          >
            <Trash2 size={14} />
          </button>
        </Tooltip>
      )}
    </div>
  );
});
