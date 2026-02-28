import { MessageList } from "./MessageList";
import { InputBar } from "./InputBar";
import { useChatStore } from "../../stores/chatStore";

export function ChatView() {
  const error = useChatStore((s) => s.error);
  const isEmpty = useChatStore((s) => s.messages.length === 0);

  return (
    <div className="chat-view chat-view-inset">
      <MessageList />

      <div className={`chat-bottom ${isEmpty ? "chat-bottom-center" : ""}`}>
        {error && (
          <div className="chat-error">{error}</div>
        )}
        <InputBar />
      </div>
    </div>
  );
}
