import { memo } from "react";
import { useChatStore } from "../../stores/chatStore";

export const ThinkingIndicator = memo(function ThinkingIndicator() {
  const isThinking = useChatStore((s) => s.isThinking);
  const messages = useChatStore((s) => s.messages);

  // Show only when thinking and no streaming message yet
  const lastMsg = messages[messages.length - 1];
  const isStreaming = lastMsg?.role === "assistant" && lastMsg.isStreaming;

  if (!isThinking || isStreaming) return null;

  return (
    <div className="thinking-indicator">
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-label">Thinking</span>
    </div>
  );
});
