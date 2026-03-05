import { memo, useRef, useEffect, useCallback, useState, useMemo } from "react";
import { ArrowDown } from "lucide-react";
import { MessageBubble } from "./MessageBubble";
import { useChatStore } from "../../stores/chatStore";

/** Distance from bottom (px) to consider "at bottom" */
const BOTTOM_THRESHOLD = 50;

export const MessageList = memo(function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const scrolledUp = useRef(false);
  const lastScrollTop = useRef(0);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    const { scrollTop, scrollHeight, clientHeight } = el;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - BOTTOM_THRESHOLD;

    // User scrolled up
    if (scrollTop < lastScrollTop.current && !isAtBottom) {
      scrolledUp.current = true;
      setShowScrollBtn(true);
    }

    // User scrolled back to bottom
    if (isAtBottom) {
      scrolledUp.current = false;
      setShowScrollBtn(false);
    }

    lastScrollTop.current = scrollTop;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    scrolledUp.current = false;
    setShowScrollBtn(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // Auto-scroll when messages or streaming message change (unless user scrolled up)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || scrolledUp.current) return;

    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }, [messages, streamingMessage]);

  // Scroll to bottom when container resizes (input bar grows/shrinks with attachments)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!scrolledUp.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Reset scroll lock when user sends a new message
  const lastUserMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return undefined;
  }, [messages]);
  useEffect(() => {
    scrolledUp.current = false;
    setShowScrollBtn(false);
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
        {messages.length === 0 && !streamingMessage ? (
          <div className="message-list-empty">
            <p>Start a conversation</p>
          </div>
        ) : (
          <>
            {messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)}
            {streamingMessage && <MessageBubble key={streamingMessage.id} message={streamingMessage} />}
          </>
        )}
      </div>
      {showScrollBtn && (
        <button
          className="scroll-to-bottom"
          onClick={scrollToBottom}
          title="Scroll to bottom"
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
});
