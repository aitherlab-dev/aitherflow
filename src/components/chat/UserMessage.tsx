import { memo, useState, useRef, useEffect, useMemo } from "react";
import { FileText } from "lucide-react";
import type { ChatMessage, Attachment } from "../../types/chat";

/** Number of visible lines when collapsed */
const COLLAPSE_LINES = 5;

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

/** Strip inlined code blocks that match text attachments from message text.
 *  Uses exact content matching instead of regex to handle files containing backticks. */
function extractUserText(text: string, attachments?: Attachment[]): string {
  if (!attachments) return text;
  let result = text;
  for (const att of attachments) {
    if (att.fileType !== "text") continue;
    const block = "```" + att.name + "\n" + att.content + "\n```";
    const idx = result.indexOf(block);
    if (idx === -1) continue;
    // Remove the block and any trailing newlines
    let end = idx + block.length;
    while (end < result.length && result[end] === "\n") end++;
    result = result.slice(0, idx) + result.slice(end);
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
  const [collapseHeight, setCollapseHeight] = useState<number>(0);

  const images = message.attachments?.filter((a) => a.fileType === "image");
  const textFiles = message.attachments?.filter((a) => a.fileType === "text");
  const hasAttachments = (images && images.length > 0) || (textFiles && textFiles.length > 0);

  const displayText = useMemo(
    () => hasAttachments ? extractUserText(message.text, message.attachments) : message.text,
    [message.text, message.attachments, hasAttachments],
  );

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    const maxH = lineHeight * COLLAPSE_LINES;
    const tooLong = el.scrollHeight > maxH + 2; // 2px tolerance
    setIsLong(tooLong);
    if (tooLong) setCollapseHeight(maxH);
  }, [displayText]);

  return (
    <div className="chat-message-user-wrap">
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
        <div className="chat-message chat-message-user">
          <div
            ref={contentRef}
            className="chat-message-content"
            style={
              isLong && !expanded
                ? { maxHeight: collapseHeight, overflow: "hidden" }
                : undefined
            }
          >
            {displayText}
          </div>
        </div>
      )}
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
