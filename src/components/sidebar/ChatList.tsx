import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { MessageSquare, Plus } from "lucide-react";
import { useAgentStore } from "../../stores/agentStore";
import { useChatStore } from "../../stores/chatStore";

interface ChatListProps {
  agentId: string;
}

export const ChatList = memo(function ChatList({ agentId }: ChatListProps) {
  const chats = useAgentStore(useShallow((s) => s.chats.filter((c) => c.agentId === agentId)));
  const activeChatId = useChatStore((s) => s.activeChatId);
  const switchChat = useAgentStore((s) => s.switchChat);
  const createChat = useAgentStore((s) => s.createChat);

  return (
    <div className="chat-list">
      {chats.map((chat) => (
        <button
          key={chat.id}
          className={`chat-list-item ${chat.id === activeChatId ? "chat-list-item-active" : ""}`}
          onClick={() => switchChat(chat.id)}
        >
          <MessageSquare size={12} />
          <span className="chat-list-item-title">{chat.title}</span>
        </button>
      ))}
      <button
        className="chat-list-new"
        onClick={() => createChat(agentId)}
      >
        <Plus size={12} />
        <span>New Chat</span>
      </button>
    </div>
  );
});
