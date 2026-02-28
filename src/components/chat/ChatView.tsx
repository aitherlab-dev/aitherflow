import { MessageList } from "./MessageList";
import { InputBar } from "./InputBar";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ToolStatus } from "./ToolStatus";
import { useChatStore } from "../../stores/chatStore";

export function ChatView() {
  const error = useChatStore((s) => s.error);

  return (
    <div className="chat-view">
      <MessageList />

      <div className="chat-bottom">
        {error && (
          <div className="chat-error">{error}</div>
        )}
        <ThinkingIndicator />
        <InputBar />
        <ToolStatus />
      </div>
    </div>
  );
}
