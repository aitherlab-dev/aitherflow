import { memo, useCallback, useEffect, useState } from "react";
import { ChevronRight, Loader, Plus, X } from "lucide-react";
import type { ChatMeta } from "../../../stores/chatStore";
import { ChatItem } from "./ChatItem";
import { ChatContextMenu } from "./ChatContextMenu";

export const AgentTab = memo(function AgentTab({
  agentId,
  projectName,
  isActive,
  chatList,
  currentChatId,
  isThinking,
  isBackgroundThinking,
  lockedChatIds,
  onActivate,
  onClose,
  onNewChat,
  onSelectChat,
  onDeleteChat,
  onRenameChat,
  onToggleChatPin,
  onToggleExpand,
}: {
  agentId: string;
  projectName: string;
  isActive: boolean;
  chatList: ChatMeta[];
  currentChatId: string | null;
  isThinking: boolean;
  isBackgroundThinking: boolean;
  lockedChatIds: string[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, newTitle: string) => void;
  onToggleChatPin: (id: string, pinned: boolean) => void;
  onToggleExpand?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ chatId: string; x: number; y: number } | null>(null);

  // Collapse chat list when agent becomes inactive
  useEffect(() => {
    if (!isActive) {
      setExpanded(false);
      onToggleExpand?.(false);
    }
  }, [isActive, onToggleExpand]);

  const handleClick = useCallback(() => {
    if (isActive) {
      setExpanded((prev) => {
        const next = !prev;
        onToggleExpand?.(next);
        return next;
      });
    } else {
      onActivate(agentId);
    }
  }, [isActive, agentId, onActivate, onToggleExpand]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose(agentId);
    },
    [agentId, onClose],
  );

  const handleChatContextMenu = useCallback((e: React.MouseEvent, chatId: string) => {
    setContextMenu({ chatId, x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleContextRename = useCallback(() => {
    if (contextMenu) {
      setEditingChatId(contextMenu.chatId);
      setContextMenu(null);
    }
  }, [contextMenu]);

  const handleContextPin = useCallback(() => {
    if (contextMenu) {
      const chat = chatList.find((c) => c.id === contextMenu.chatId);
      if (chat) onToggleChatPin(chat.id, !chat.pinned);
      setContextMenu(null);
    }
  }, [contextMenu, chatList, onToggleChatPin]);

  const handleContextDelete = useCallback(() => {
    if (contextMenu) {
      onDeleteChat(contextMenu.chatId);
      setContextMenu(null);
    }
  }, [contextMenu, onDeleteChat]);

  const handleRenameSubmit = useCallback(
    (id: string, newTitle: string) => {
      setEditingChatId(null);
      onRenameChat(id, newTitle);
    },
    [onRenameChat],
  );

  const handleRenameCancel = useCallback(() => setEditingChatId(null), []);

  const contextChat = contextMenu ? chatList.find((c) => c.id === contextMenu.chatId) : null;

  return (
    <>
      <div className="sidebar-project-wrapper">
        <button
          className={`sidebar-project ${isActive ? "sidebar-project--active" : ""}`}
          onClick={handleClick}
        >
          <ChevronRight
            size={14}
            className={`sidebar-project__chevron ${expanded && isActive ? "sidebar-project__chevron--open" : ""}`}
          />
          <span className="sidebar-project__name">{projectName}</span>
          {isBackgroundThinking && !isActive && (
            <Loader size={14} className="sidebar-project__bg-spinner" />
          )}
        </button>
        <button
          className="sidebar-project__close"
          onClick={handleClose}
          title="Close agent"
        >
          <X size={14} />
        </button>
      </div>

      {expanded && isActive && (
        <div className="sidebar-project-body">
          <button
            className={`sidebar-new-chat ${isThinking ? "sidebar-new-chat--disabled" : ""}`}
            onClick={() => { onNewChat(); setExpanded(false); }}
            disabled={isThinking}
          >
            <Plus size={16} />
            <span>New Chat</span>
          </button>

          <div className="sidebar-chat-list">
            {chatList.map((chat) => (
              <ChatItem
                key={chat.id}
                chat={chat}
                isCurrent={chat.id === currentChatId}
                disabled={isThinking}
                locked={lockedChatIds.includes(chat.id)}
                isEditing={editingChatId === chat.id}
                onSelect={(id: string) => { onSelectChat(id); setExpanded(false); }}
                onDelete={onDeleteChat}
                onContextMenu={handleChatContextMenu}
                onRenameSubmit={handleRenameSubmit}
                onRenameCancel={handleRenameCancel}
              />
            ))}
          </div>
        </div>
      )}

      {contextMenu && contextChat && (
        <ChatContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          chat={contextChat}
          onRename={handleContextRename}
          onTogglePin={handleContextPin}
          onDelete={handleContextDelete}
          onClose={closeContextMenu}
        />
      )}
    </>
  );
});
