import { memo, useMemo } from "react";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { InlineMarkdown } from "./InlineMarkdown";
import { InteractiveCard } from "./InteractiveCard";
import { useTypewriter } from "./useTypewriter";
import type { ChatMessage } from "../../types/chat";
import { isInteractiveTool } from "../../types/chat";

const TURN_SEPARATOR = "\n<!-- turn -->\n";

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

  // Split text into thinking blocks (intermediate) and final answer
  const { thinking, final: finalText } = useMemo(() => {
    const raw = message.isStreaming ? displayText : message.text;
    if (!raw) return { thinking: [], final: "" };

    const parts = raw.split(TURN_SEPARATOR);
    if (parts.length <= 1) return { thinking: [], final: raw };

    return {
      thinking: parts.slice(0, -1).filter((p) => p.trim()),
      final: parts[parts.length - 1],
    };
  }, [message.text, message.isStreaming, displayText]);

  // While streaming — show only the latest block (previous ones are overwritten)
  if (message.isStreaming) {
    return (
      <div className="chat-message chat-message-assistant">
        <div className="chat-message-content">
          <InlineMarkdown content={thinking.length > 0 ? finalText : displayText} />
          <span className="streaming-cursor" />
        </div>
      </div>
    );
  }

  // Finished — show only the final text, intermediate thinking is discarded
  return (
    <div className="chat-message chat-message-assistant">
      {finalText && (
        <div className="chat-message-content">
          <MarkdownRenderer content={finalText} />
        </div>
      )}
      {interactiveTools &&
        interactiveTools.map((tool) => (
          <InteractiveCard key={tool.toolUseId} tool={tool} />
        ))}
    </div>
  );
});
