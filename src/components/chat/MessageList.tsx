import { memo, useRef, useEffect, useCallback } from "react";
import { MessageBubble } from "./MessageBubble";
import { useChatStore } from "../../stores/chatStore";

/** Distance from bottom (px) to consider "at bottom" */
const BOTTOM_THRESHOLD = 50;

export const MessageList = memo(function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const containerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUp = useRef(false);
  const lastScrollTop = useRef(0);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const { scrollTop, scrollHeight, clientHeight } = el;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - BOTTOM_THRESHOLD;

    // User scrolled up
    if (scrollTop < lastScrollTop.current && !isAtBottom) {
      isUserScrolledUp.current = true;
    }

    // User scrolled back to bottom
    if (isAtBottom) {
      isUserScrolledUp.current = false;
    }

    lastScrollTop.current = scrollTop;
  }, []);

  // Auto-scroll when messages change (unless user scrolled up)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || isUserScrolledUp.current) return;

    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }, [messages]);

  // Reset scroll lock when user sends a new message
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const lastUserMsgId = lastUserMsg?.id;
  useEffect(() => {
    isUserScrolledUp.current = false;
    const el = containerRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    }
  }, [lastUserMsgId]);

  return (
    <div
      ref={containerRef}
      className="message-list"
      onScroll={handleScroll}
    >
      <div className="message-list-inner">
        {messages.length === 0 ? (
          <div className="message-list-empty">
            <p>Start a conversation</p>
          </div>
        ) : (
          messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
        )}
      </div>
    </div>
  );
});
