import { memo } from "react";
import { useChatStore } from "../../stores/chatStore";

export const ThinkingIndicator = memo(function ThinkingIndicator() {
  const isThinking = useChatStore((s) => s.isThinking);
  const hasStreamingMessage = useChatStore((s) => s.streamingMessage !== null);

  if (!isThinking || hasStreamingMessage) return null;

  return (
    <div className="thinking-indicator">
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-label">Thinking</span>
    </div>
  );
});
