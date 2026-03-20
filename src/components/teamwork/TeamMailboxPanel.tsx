import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Mail, MessageSquare, X, ArrowDown, User, Trash2 } from "lucide-react";
import { invoke } from "../../lib/transport";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore } from "../../stores/chatStore";
import { useConductorStore } from "../../stores/conductorStore";
import { useAgentStore } from "../../stores/agentStore";
import { Tooltip } from "../shared/Tooltip";
import { ChatPanel } from "../layout/chat-panel";
import type { TeamMessage } from "../../types/team";

type PanelTab = "mailbox" | "chats";

/* ── Types ── */

interface FeedMessage {
  id: string;
  sender: string;
  fromId: string;
  text: string;
  timestamp: number;
  broadcastId?: string;
  isManager: boolean;
}

const COLLAPSE_THRESHOLD = 150;

/* ── Main panel ── */

export const TeamMailboxPanel = memo(function TeamMailboxPanel() {
  const [activeTab, setActiveTab] = useState<PanelTab>("mailbox");
  const toggleTeamMailbox = useLayoutStore((s) => s.toggleTeamMailbox);
  const setTeamMailboxWidth = useLayoutStore((s) => s.setTeamMailboxWidth);
  const projectPath = useChatStore((s) => s.projectPath);

  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [teamSlug, setTeamSlug] = useState<string | null>(null);
  const agentRoles = useConductorStore(useShallow((s) => s.agentRoles));
  const agents = useAgentStore(useShallow((s) => s.agents));

  // Resolve project slug once
  useEffect(() => {
    if (!projectPath) {
      setTeamSlug(null);
      return;
    }
    invoke<string>("get_teamwork_slug", { projectPath })
      .then(setTeamSlug)
      .catch(console.error);
  }, [projectPath]);

  // Poll messages every 4s
  useEffect(() => {
    if (!teamSlug) return;

    const fetchMessages = () => {
      invoke<TeamMessage[]>("team_read_all_messages", { team: teamSlug })
        .then(setMessages)
        .catch(console.error);
    };

    fetchMessages();
    const interval = setInterval(fetchMessages, 4000);
    return () => clearInterval(interval);
  }, [teamSlug]);

  // Build agent name map from conductor role assignments
  const agentNameMap = useMemo(() => {
    const map = new Map<string, { name: string; canManage: boolean }>();
    for (const agent of agents) {
      const role = agentRoles[agent.id];
      if (role) {
        map.set(agent.id, { name: role.name, canManage: role.can_manage });
      }
    }
    return map;
  }, [agents, agentRoles]);

  // Build feed: deduplicate broadcasts, sort by time
  const feed = useMemo(() => {
    const items: FeedMessage[] = messages.map((msg) => {
      const isUser = msg.from === "user";
      const info = agentNameMap.get(msg.from);
      return {
        id: msg.id,
        sender: isUser ? "You" : (info?.name ?? "Agent"),
        fromId: msg.from,
        text: msg.text,
        timestamp: new Date(msg.timestamp).getTime(),
        broadcastId: msg.broadcast_id,
        isManager: isUser || (info?.canManage ?? false),
      };
    });

    // Deduplicate broadcast copies
    const seen = new Set<string>();
    const deduped = items.filter((item) => {
      if (!item.broadcastId) return true;
      if (seen.has(item.broadcastId)) return false;
      seen.add(item.broadcastId);
      return true;
    });

    deduped.sort((a, b) => a.timestamp - b.timestamp);
    return deduped;
  }, [messages, agentNameMap]);

  // Auto-scroll
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const scrolledUp = useRef(false);
  const lastScrollTop = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && !scrolledUp.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" as ScrollBehavior });
    }
  }, [feed.length]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 60;

    if (scrollTop < lastScrollTop.current && !isAtBottom) {
      scrolledUp.current = true;
      setShowScrollBtn(true);
    }
    if (isAtBottom) {
      scrolledUp.current = false;
      setShowScrollBtn(false);
    }
    lastScrollTop.current = scrollTop;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    scrolledUp.current = false;
    setShowScrollBtn(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const handleClearMessages = useCallback(() => {
    if (!teamSlug) return;
    invoke("team_clear_messages", { team: teamSlug })
      .then(() => setMessages([]))
      .catch(console.error);
  }, [teamSlug]);

  // Resize handle (drag from right edge — panel is on the left)
  const dragging = useRef(false);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      document.body.classList.add("select-none");
      document.body.style.cursor = "col-resize";

      const wrapper = document.querySelector(".team-mailbox-wrapper") as HTMLElement | null;
      if (wrapper) wrapper.style.transition = "none";
      const wrapperLeft = wrapper?.getBoundingClientRect().left ?? 0;

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const newWidth = ev.clientX - wrapperLeft;
        setTeamMailboxWidth(newWidth);
      };

      const onUp = () => {
        dragging.current = false;
        document.body.classList.remove("select-none");
        document.body.style.cursor = "";
        if (wrapper) wrapper.style.transition = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setTeamMailboxWidth],
  );

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        e.preventDefault();
        toggleTeamMailbox();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleTeamMailbox]);

  return (
    <div className="team-mailbox">
      <div className="tm-resize-handle" onMouseDown={handleResizeMouseDown} />

      <div className="team-mailbox__header">
        <div className="tm-tabs">
          <button
            className={`tm-tab ${activeTab === "mailbox" ? "tm-tab--active" : ""}`}
            onClick={() => setActiveTab("mailbox")}
          >
            <Mail size={14} />
            <span>Mailbox</span>
          </button>
          <button
            className={`tm-tab ${activeTab === "chats" ? "tm-tab--active" : ""}`}
            onClick={() => setActiveTab("chats")}
          >
            <MessageSquare size={14} />
            <span>Chats</span>
          </button>
        </div>
        {activeTab === "mailbox" && (
          <Tooltip text="Clear messages">
            <button className="team-mailbox__clear-btn" onClick={handleClearMessages}>
              <Trash2 size={14} />
            </button>
          </Tooltip>
        )}
        <Tooltip text="Close (Esc)">
          <button className="settings-close" onClick={toggleTeamMailbox}>
            <X size={16} />
          </button>
        </Tooltip>
      </div>

      {activeTab === "mailbox" ? (
        <div className="team-mailbox__feed" ref={scrollRef} onScroll={handleScroll}>
          {feed.length === 0 ? (
            <div className="team-mailbox__empty">
              No messages yet
            </div>
          ) : (
            feed.map((msg) => (
              <FeedItem key={msg.id} msg={msg} />
            ))
          )}
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
      ) : (
        <ChatPanel />
      )}
    </div>
  );
});

/* ── Single message bubble ── */

function getRoleIconClass(sender: string, fromId: string): string {
  if (fromId === "user") return "team-mailbox__msg-icon--user";
  const lower = sender.toLowerCase();
  if (lower.includes("architect")) return "team-mailbox__msg-icon--architect";
  if (lower.includes("coder") || lower.includes("developer")) return "team-mailbox__msg-icon--coder";
  if (lower.includes("review")) return "team-mailbox__msg-icon--reviewer";
  if (lower.includes("research")) return "team-mailbox__msg-icon--researcher";
  return "";
}

function FeedItem({ msg }: { msg: FeedMessage }) {
  const side = msg.fromId === "user" ? "right" : "left";

  const needsCollapse = msg.text.length > COLLAPSE_THRESHOLD;
  const [collapsed, setCollapsed] = useState(needsCollapse);

  const displayText = collapsed
    ? msg.text.slice(
        0,
        msg.text.indexOf("\n", 0) > 0
          ? msg.text.indexOf("\n", 0)
          : COLLAPSE_THRESHOLD,
      ) + "..."
    : msg.text;

  const iconClass = getRoleIconClass(msg.sender, msg.fromId);

  return (
    <div className={`team-mailbox__msg-wrap team-mailbox__msg-wrap--${side}`}>
      <div className={`team-mailbox__bubble team-mailbox__bubble--${side}`}>
        <div className="team-mailbox__msg-header">
          <User size={12} className={`team-mailbox__msg-icon ${iconClass}`} />
          <span className={`team-mailbox__msg-sender ${iconClass}`}>{msg.sender}</span>
          <span className="team-mailbox__msg-time">
            {new Date(msg.timestamp).toLocaleTimeString()}
          </span>
        </div>
        <div className="team-mailbox__msg-text">{displayText}</div>
        {needsCollapse && (
          <button
            className="team-mailbox__expand-btn"
            onClick={() => setCollapsed((p) => !p)}
          >
            {collapsed ? "Show more \u25B6" : "Show less \u25BC"}
          </button>
        )}
      </div>
    </div>
  );
}
