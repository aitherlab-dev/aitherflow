import { memo } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { InlineMarkdown } from "./InlineMarkdown";
import { InteractiveCard } from "./InteractiveCard";
import { useTypewriter } from "./useTypewriter";
import type { ChatMessage } from "../../types/chat";
import { isInteractiveTool } from "../../types/chat";

interface AssistantMessageProps {
  message: ChatMessage;
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
}: AssistantMessageProps) {
  const interactiveTools = message.tools?.filter((t) =>
    isInteractiveTool(t.toolName),
  );
  const displayText = useTypewriter(message.text, message.isStreaming ?? false);

  // While streaming — lightweight inline markdown with typewriter effect.
  if (message.isStreaming) {
    return (
      <div className="chat-message chat-message-assistant">
        <div className="chat-message-content">
          <InlineMarkdown content={displayText} />
          <span className="streaming-cursor" />
        </div>
      </div>
    );
  }

  return (
    <div className="chat-message chat-message-assistant">
      {message.text && (
        <div className="chat-message-content">
          <MarkdownRenderer content={message.text} />
        </div>
      )}
      {interactiveTools &&
        interactiveTools.map((tool) => (
          <InteractiveCard key={tool.toolUseId} tool={tool} />
        ))}
    </div>
  );
});
