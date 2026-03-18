import { memo, useRef, useEffect, useCallback, useState, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ArrowDown } from "lucide-react";
import { MessageBubble } from "./MessageBubble";
import { useChatStore } from "../../stores/chatStore";
import { Tooltip } from "../shared/Tooltip";

/** Threshold to enable virtualization */
const VIRTUALIZE_THRESHOLD = 100;
/** Distance from bottom (px) to consider "at bottom" */
const BOTTOM_THRESHOLD = 50;

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
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const scrolledUp = useRef(false);
  const lastScrollTop = useRef(0);

  const useVirtualization = messages.length >= VIRTUALIZE_THRESHOLD;

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
    if (useVirtualization && virtuosoRef.current) {
      scrolledUp.current = false;
      setShowScrollBtn(false);
      virtuosoRef.current.scrollToIndex({ index: "LAST", behavior: "smooth" });
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    scrolledUp.current = false;
    setShowScrollBtn(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [useVirtualization]);

  // ── Non-virtualized: auto-scroll via ResizeObserver ──

  // Auto-scroll when inner content grows (covers both new messages and streaming)
  useEffect(() => {
    if (useVirtualization) return;
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
  }, [useVirtualization]);

  // Scroll to bottom when container resizes (input bar grows/shrinks with attachments)
  useEffect(() => {
    if (useVirtualization) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!scrolledUp.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [useVirtualization]);

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
    if (useVirtualization && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: "LAST", behavior: "auto" });
    } else {
      const el = containerRef.current;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
    }
  }, [lastUserMsgId, useVirtualization]);

  // ── Virtuoso callbacks ──

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    if (atBottom) {
      scrolledUp.current = false;
      setShowScrollBtn(false);
    } else {
      scrolledUp.current = true;
      setShowScrollBtn(true);
    }
  }, []);

  const renderItem = useCallback(
    (_index: number, msg: (typeof messages)[number]) => (
      <MessageBubble key={msg.id} message={msg} agentId={agentId} />
    ),
    [agentId],
  );

  const VirtuosoFooter = useMemo(() => () => <StreamingBubble agentId={agentId} />, [agentId]);

  if (messages.length === 0 && !hasStreamingMessage) {
    return (
      <div ref={containerRef} className="message-list">
        <div className="message-list-inner">
          <div className="message-list-empty">
            <p>Start a conversation</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Virtualized path ──
  if (useVirtualization) {
    return (
      <div className="message-list message-list--virtualized">
        <Virtuoso
          ref={virtuosoRef}
          data={messages}
          itemContent={renderItem}
          followOutput="smooth"
          atBottomThreshold={BOTTOM_THRESHOLD}
          atBottomStateChange={handleAtBottomChange}
          increaseViewportBy={200}
          components={{
            Footer: VirtuosoFooter,
          }}
        />
        {showScrollBtn && (
          <Tooltip text="Scroll to bottom">
            <button className="scroll-to-bottom" onClick={scrollToBottom}>
              <ArrowDown size={16} />
            </button>
          </Tooltip>
        )}
      </div>
    );
  }

  // ── Non-virtualized path (< 100 messages) ──
  return (
    <div
      ref={containerRef}
      className="message-list"
      onScroll={handleScroll}
    >
      <div ref={innerRef} className="message-list-inner">
        {messages.map((msg) => <MessageBubble key={msg.id} message={msg} agentId={agentId} />)}
        <StreamingBubble agentId={agentId} />
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
