import { memo } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import type { ChatMessage } from "../../types/chat";

interface AssistantMessageProps {
  message: ChatMessage;
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
}: AssistantMessageProps) {
  // While streaming — plain text for performance. Markdown after completion.
  if (message.isStreaming) {
    return (
      <div className="chat-message chat-message-assistant">
        <div className="chat-message-content streaming-text">
          {message.text}
          <span className="streaming-cursor" />
        </div>
      </div>
    );
  }

  return (
    <div className="chat-message chat-message-assistant">
      <div className="chat-message-content">
        <MarkdownRenderer content={message.text} />
      </div>
    </div>
  );
});
