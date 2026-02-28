import { memo, useState, useRef, useEffect } from "react";
import type { ChatMessage } from "../../types/chat";

/** Max collapsed height in px (~4 lines) */
const COLLAPSE_HEIGHT = 96;

interface UserMessageProps {
  message: ChatMessage;
}

export const UserMessage = memo(function UserMessage({ message }: UserMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isLong, setIsLong] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (contentRef.current) {
      setIsLong(contentRef.current.scrollHeight > COLLAPSE_HEIGHT);
    }
  }, [message.text]);

  return (
    <div className="chat-message chat-message-user">
      <div
        ref={contentRef}
        className="chat-message-content"
        style={
          isLong && !expanded
            ? { maxHeight: COLLAPSE_HEIGHT, overflow: "hidden" }
            : undefined
        }
      >
        {message.text}
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
