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

  // While streaming — lightweight inline markdown with typewriter effect.
  if (message.isStreaming) {
    return (
      <div className="chat-message chat-message-assistant">
        {thinking.length > 0 && (
          <div className="thinking-blocks">
            {thinking.map((block, i) => (
              <div key={i} className="thinking-block">
                <InlineMarkdown content={block} />
              </div>
            ))}
          </div>
        )}
        <div className="chat-message-content">
          <InlineMarkdown content={thinking.length > 0 ? finalText : displayText} />
          <span className="streaming-cursor" />
        </div>
      </div>
    );
  }

  return (
    <div className="chat-message chat-message-assistant">
      {thinking.length > 0 && (
        <div className="thinking-blocks">
          {thinking.map((block, i) => (
            <div key={i} className="thinking-block">
              <MarkdownRenderer content={block} />
            </div>
          ))}
        </div>
      )}
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
