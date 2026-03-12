import { memo, useCallback, useState } from "react";
import { Plus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "../../../stores/chatStore";
import { useAgentStore } from "../../../stores/agentStore";
import { newChat, switchChat, deleteChat, renameChat, toggleChatPin } from "../../../stores/chatService";
import { useLayoutStore } from "../../../stores/layoutStore";
import { ChatItem } from "../sidebar/ChatItem";
import { ChatContextMenu } from "../sidebar/ChatContextMenu";

export const ChatPanel = memo(function ChatPanel() {
  const { chatList, currentChatId, isThinking } = useChatStore(
    useShallow((s) => ({
      chatList: s.chatList,
      currentChatId: s.currentChatId,
      isThinking: s.isThinking,
    })),
  );

  const { activeAgentId, getLockedChatIds } = useAgentStore(
    useShallow((s) => ({
      activeAgentId: s.activeAgentId,
      getLockedChatIds: s.getLockedChatIds,
    })),
  );

  const { activeView, closeSettings } = useLayoutStore(
    useShallow((s) => ({
      activeView: s.activeView,
      closeSettings: s.closeSettings,
    })),
  );

  const lockedChatIds = activeAgentId ? getLockedChatIds(activeAgentId) : [];

  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ chatId: string; x: number; y: number } | null>(null);

  const handleNewChat = useCallback(() => {
    if (!isThinking) newChat().catch(console.error);
  }, [isThinking]);

  const handleSelectChat = useCallback(
    (id: string) => {
      if (activeView === "settings") closeSettings();
      switchChat(id).catch(console.error);
    },
    [activeView, closeSettings],
  );

  const handleDeleteChat = useCallback((id: string) => {
    deleteChat(id).catch(console.error);
  }, []);

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
      if (chat) toggleChatPin(chat.id, !chat.pinned).catch(console.error);
      setContextMenu(null);
    }
  }, [contextMenu, chatList]);

  const handleContextDelete = useCallback(() => {
    if (contextMenu) {
      deleteChat(contextMenu.chatId).catch(console.error);
      setContextMenu(null);
    }
  }, [contextMenu]);

  const handleRenameSubmit = useCallback((id: string, newTitle: string) => {
    setEditingChatId(null);
    renameChat(id, newTitle).catch(console.error);
  }, []);

  const handleRenameCancel = useCallback(() => setEditingChatId(null), []);

  const contextChat = contextMenu ? chatList.find((c) => c.id === contextMenu.chatId) : null;

  if (!activeAgentId) return null;

  return (
    <div className="chat-panel">
      <div className="chat-panel__header">
        <span className="chat-panel__title">Chats</span>
        <button
          className={`chat-panel__new-btn ${isThinking ? "chat-panel__new-btn--disabled" : ""}`}
          onClick={handleNewChat}
          disabled={isThinking}
          title="New Chat"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="chat-panel__list">
        {chatList.map((chat) => (
          <ChatItem
            key={chat.id}
            chat={chat}
            isCurrent={chat.id === currentChatId}
            disabled={isThinking}
            locked={lockedChatIds.includes(chat.id)}
            isEditing={editingChatId === chat.id}
            onSelect={handleSelectChat}
            onDelete={handleDeleteChat}
            onContextMenu={handleChatContextMenu}
            onRenameSubmit={handleRenameSubmit}
            onRenameCancel={handleRenameCancel}
          />
        ))}
      </div>

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
    </div>
  );
});
