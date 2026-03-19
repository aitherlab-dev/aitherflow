import { memo, useRef, useEffect, useCallback, useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowDown } from "lucide-react";
import { MessageBubble } from "./MessageBubble";
import { useChatStore } from "../../stores/chatStore";
import { Tooltip } from "../shared/Tooltip";

/** Distance from bottom (px) to consider "at bottom" */
const BOTTOM_THRESHOLD = 80;

/** Renders the streaming message separately to avoid re-running messages.map() on every chunk */
const StreamingBubble = memo(function StreamingBubble({ agentId }: { agentId: string }) {
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  if (!streamingMessage) return null;
  return <MessageBubble key={streamingMessage.id} message={streamingMessage} agentId={agentId} />;
});

export const MessageList = memo(function MessageList() {
  const messages = useChatStore(useShallow((s) => s.messages));
  const hasStreamingMessage = useChatStore((s) => s.streamingMessage !== null);
  const agentId = useChatStore((s) => s.agentId);
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const scrolledUp = useRef(false);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    scrolledUp.current = false;
    setShowScrollBtn(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // Detect manual scroll up via wheel event (not triggered by programmatic scrollTo)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        scrolledUp.current = true;
        setShowScrollBtn(true);
      } else if (e.deltaY > 0) {
        // Scrolling down — check if at bottom
        requestAnimationFrame(() => {
          const { scrollTop, scrollHeight, clientHeight } = el;
          if (scrollTop + clientHeight >= scrollHeight - BOTTOM_THRESHOLD) {
            scrolledUp.current = false;
            setShowScrollBtn(false);
          }
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Auto-scroll when inner content grows (new messages + streaming)
  useEffect(() => {
    const inner = innerRef.current;
    const container = containerRef.current;
    if (!inner || !container) return;
    const observer = new ResizeObserver(() => {
      if (!scrolledUp.current) {
        container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
      }
    });
    observer.observe(inner);
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
    >
      <div ref={innerRef} className="message-list-inner">
        {messages.length === 0 && !hasStreamingMessage ? (
          <div className="message-list-empty">
            <p>Start a conversation</p>
          </div>
        ) : (
          <>
            {messages.map((msg) => <MessageBubble key={msg.id} message={msg} agentId={agentId} />)}
            <StreamingBubble agentId={agentId} />
          </>
        )}
      </div>
      {showScrollBtn && (
        <Tooltip text="Scroll to bottom">
          <button
            className="scroll-to-bottom"
            onClick={scrollToBottom}
          >
            <ArrowDown size={16} />
          </button>
        </Tooltip>
      )}
    </div>
  );
});
