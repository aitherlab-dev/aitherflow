import { memo, useCallback, useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore, type ChatMeta } from "../../stores/chatStore";
import { ResizeHandle } from "./ResizeHandle";

const ChatItem = memo(function ChatItem({
  chat,
  isCurrent,
  disabled,
  onSelect,
  onDelete,
}: {
  chat: ChatMeta;
  isCurrent: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [removing, setRemoving] = useState(false);

  const handleClick = useCallback(() => {
    if (!disabled && !isCurrent) onSelect(chat.id);
  }, [chat.id, disabled, isCurrent, onSelect]);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!disabled && !removing) {
        setRemoving(true);
        setTimeout(() => onDelete(chat.id), 250);
      }
    },
    [chat.id, disabled, removing, onDelete],
  );

  return (
    <div
      className={`chat-item ${isCurrent ? "chat-item--active" : ""} ${disabled ? "chat-item--disabled" : ""} ${removing ? "chat-item--removing" : ""}`}
      onClick={handleClick}
    >
      <span className="chat-item__title">{chat.title}</span>
      {!disabled && (
        <button
          className="chat-item__delete"
          onClick={handleDelete}
          title="Delete chat"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
});

export const Sidebar = memo(function Sidebar() {
  const open = useLayoutStore((s) => s.sidebarOpen);
  const width = useLayoutStore((s) => s.sidebarWidth);

  const projectName = useChatStore((s) => s.projectName);
  const chatList = useChatStore((s) => s.chatList);
  const currentChatId = useChatStore((s) => s.currentChatId);
  const isThinking = useChatStore((s) => s.isThinking);
  const newChat = useChatStore((s) => s.newChat);
  const switchChat = useChatStore((s) => s.switchChat);
  const deleteChat = useChatStore((s) => s.deleteChat);

  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleNewChat = useCallback(() => {
    if (!isThinking) newChat().catch(console.error);
  }, [isThinking, newChat]);

  const handleSelect = useCallback(
    (id: string) => {
      switchChat(id).catch(console.error);
    },
    [switchChat],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteChat(id).catch(console.error);
    },
    [deleteChat],
  );

  return (
    <aside
      className="app-sidebar"
      style={{ width: open ? width : 0 }}
    >
      {open && (
        <>
          <div className="sidebar-content">
            {/* Project tab — clickable accordion header */}
            <button className="sidebar-project" onClick={toggleExpanded}>
              <ChevronRight
                size={14}
                className={`sidebar-project__chevron ${expanded ? "sidebar-project__chevron--open" : ""}`}
              />
              <span className="sidebar-project__name">{projectName}</span>
            </button>

            {/* Accordion body */}
            {expanded && (
              <div className="sidebar-project-body">
                {/* New Chat button */}
                <button
                  className={`sidebar-new-chat ${isThinking ? "sidebar-new-chat--disabled" : ""}`}
                  onClick={handleNewChat}
                  disabled={isThinking}
                >
                  <Plus size={16} />
                  <span>New Chat</span>
                </button>

                {/* Chat list */}
                <div className="sidebar-chat-list">
                  {chatList.map((chat) => (
                    <ChatItem
                      key={chat.id}
                      chat={chat}
                      isCurrent={chat.id === currentChatId}
                      disabled={isThinking}
                      onSelect={handleSelect}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <ResizeHandle />
        </>
      )}
    </aside>
  );
});
