import { memo, useState, useRef, useEffect, useMemo } from "react";
import { FileText } from "lucide-react";
import type { ChatMessage, Attachment } from "../../types/chat";

/** Max collapsed height in px (~5 lines) */
const COLLAPSE_HEIGHT = 126;

/** Format bytes to human-readable size */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Get first N lines of text for preview */
function textPreview(content: string, lines = 3): string {
  return content.split("\n").slice(0, lines).join("\n");
}

/** Strip inlined code blocks that match text attachments from message text */
function extractUserText(text: string, attachments?: Attachment[]): string {
  if (!attachments) return text;
  let result = text;
  for (const att of attachments) {
    if (att.fileType !== "text") continue;
    // Match ```filename\n...content...\n```
    const escaped = att.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp("```" + escaped + "\\n[\\s\\S]*?```\\n*", "g");
    result = result.replace(pattern, "");
  }
  return result.trim();
}

interface UserMessageProps {
  message: ChatMessage;
}

export const UserMessage = memo(function UserMessage({ message }: UserMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isLong, setIsLong] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const images = message.attachments?.filter((a) => a.fileType === "image");
  const textFiles = message.attachments?.filter((a) => a.fileType === "text");
  const hasAttachments = (images && images.length > 0) || (textFiles && textFiles.length > 0);

  const displayText = useMemo(
    () => hasAttachments ? extractUserText(message.text, message.attachments) : message.text,
    [message.text, message.attachments, hasAttachments],
  );

  useEffect(() => {
    if (contentRef.current) {
      setIsLong(contentRef.current.scrollHeight > COLLAPSE_HEIGHT);
    }
  }, [displayText]);

  return (
    <div className="chat-message-user-wrap">
      <div className="chat-message chat-message-user">
        {hasAttachments && (
          <div className="message-attachments">
            {images?.map((img) => (
              <div key={img.id} className="attachment-card attachment-card-image">
                <img
                  src={img.content}
                  alt={img.name}
                  className="attachment-card-thumb"
                />
              </div>
            ))}
            {textFiles?.map((file) => (
              <div key={file.id} className="attachment-card attachment-card-text">
                <FileText size={20} className="attachment-card-icon" />
                <div className="attachment-card-info">
                  <span className="attachment-card-name">{file.name}</span>
                  <span className="attachment-card-meta">{formatSize(file.size)}</span>
                  <pre className="attachment-card-preview">{textPreview(file.content)}</pre>
                </div>
              </div>
            ))}
          </div>
        )}
        {displayText && (
          <div
            ref={contentRef}
            className="chat-message-content"
            style={
              isLong && !expanded
                ? { maxHeight: COLLAPSE_HEIGHT, overflow: "hidden" }
                : undefined
            }
          >
            {displayText}
          </div>
        )}
      </div>
      {isLong && (
        <button
          className="chat-show-more"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
});
