import { memo, useMemo, useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
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
  const [thinkingOpen, setThinkingOpen] = useState(false);
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

  // While streaming — show current block, with collapsible thinking above
  if (message.isStreaming) {
    return (
      <div className="chat-message chat-message-assistant">
        {thinking.length > 0 && (
          <ThinkingToggle
            thinking={thinking}
            open={thinkingOpen}
            onToggle={() => setThinkingOpen((v) => !v)}
            isStreaming
          />
        )}
        <div className="chat-message-content">
          <InlineMarkdown content={thinking.length > 0 ? finalText : displayText} />
          <span className="streaming-cursor" />
        </div>
      </div>
    );
  }

  // Finished — show collapsible thinking + final text
  return (
    <div className="chat-message chat-message-assistant">
      {thinking.length > 0 && (
        <ThinkingToggle
          thinking={thinking}
          open={thinkingOpen}
          onToggle={() => setThinkingOpen((v) => !v)}
        />
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

/* ── Collapsible thinking block ── */

interface ThinkingToggleProps {
  thinking: string[];
  open: boolean;
  onToggle: () => void;
  isStreaming?: boolean;
}

const ThinkingToggle = memo(function ThinkingToggle({
  thinking,
  open,
  onToggle,
  isStreaming,
}: ThinkingToggleProps) {
  return (
    <div className="thinking-toggle">
      <button className="thinking-toggle-bar" onClick={onToggle}>
        <Sparkles size={14} className="thinking-toggle-icon" />
        <span className="thinking-toggle-label">
          {isStreaming ? "Thinking…" : "Thought process"}
        </span>
        <ChevronRight
          size={14}
          className={`thinking-toggle-chevron${open ? " thinking-toggle-chevron--open" : ""}`}
        />
      </button>
      {open && (
        <div className="thinking-toggle-content">
          {thinking.map((block, i) => (
            <div key={i} className="thinking-block">
              <InlineMarkdown content={block} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
