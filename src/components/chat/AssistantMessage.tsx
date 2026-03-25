import { memo, useMemo, useState, useCallback } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import { StreamdownRenderer } from "./StreamdownRenderer";
import { InteractiveCard } from "./InteractiveCard";
import { ImageResult } from "./ImageResult";
import type { ChatMessage } from "../../types/chat";
import { isInteractiveTool } from "../../types/chat";
import { formatMessageTime } from "../../lib/formatTime";

const IMAGE_PATH_RE = /(?:^|[\s`])(\/?(?:~\/|\/)[^\s`]*\.(?:png|jpg|jpeg|webp|gif|svg))(?:[\s`]|$)/gim;

/** Extract unique image file paths from message text */
function extractImagePaths(text: string): string[] {
  const paths = new Set<string>();
  let match;
  while ((match = IMAGE_PATH_RE.exec(text)) !== null) {
    paths.add(match[1]);
  }
  IMAGE_PATH_RE.lastIndex = 0;
  return [...paths];
}

const TURN_SEPARATOR = "\n<!-- turn -->\n";

interface AssistantMessageProps {
  message: ChatMessage;
  agentId: string;
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  agentId,
}: AssistantMessageProps) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const toggleThinking = useCallback(() => setThinkingOpen((v) => !v), []);
  const interactiveTools = useMemo(
    () => message.tools?.filter((t) => isInteractiveTool(t.toolName)),
    [message.tools],
  );
  // Split text into thinking blocks (intermediate) and final answer
  const { thinking, final: finalText } = useMemo(() => {
    const raw = message.text;
    if (!raw) return { thinking: [], final: "" };

    const parts = raw.split(TURN_SEPARATOR);
    if (parts.length <= 1) return { thinking: [], final: raw };

    return {
      thinking: parts.slice(0, -1).filter((p) => p.trim()),
      final: parts[parts.length - 1],
    };
  }, [message.text]);

  // While streaming — show current block, with collapsible thinking above
  if (message.isStreaming) {
    return (
      <div className="chat-message chat-message-assistant">
        {thinking.length > 0 && (
          <ThinkingToggle
            thinking={thinking}
            open={thinkingOpen}
            onToggle={toggleThinking}
            isStreaming
          />
        )}
        <div className="chat-message-content">
          <StreamdownRenderer content={thinking.length > 0 ? finalText : (message.text ?? "")} isStreaming />
        </div>
      </div>
    );
  }

  const imagePaths = useMemo(
    () => (finalText ? extractImagePaths(finalText) : []),
    [finalText],
  );

  // Finished — show collapsible thinking + final text
  return (
    <div className="chat-message chat-message-assistant">
      <span className="chat-message-time">{formatMessageTime(message.timestamp)}</span>
      {thinking.length > 0 && (
        <ThinkingToggle
          thinking={thinking}
          open={thinkingOpen}
          onToggle={() => setThinkingOpen((v) => !v)}
        />
      )}
      {finalText && (
        <div className="chat-message-content">
          <StreamdownRenderer content={finalText} />
        </div>
      )}
      {imagePaths.length > 0 && (
        <div className="chat-message-images">
          {imagePaths.map((p) => (
            <ImageResult key={p} filePath={p} />
          ))}
        </div>
      )}
      {interactiveTools &&
        interactiveTools.map((tool) => (
          <InteractiveCard key={tool.toolUseId} tool={tool} agentId={agentId} />
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
            <div key={`think-${i}-${block.length}`} className="thinking-block">
              <StreamdownRenderer content={block} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
