import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  X,
  ArrowUp,
  ArrowDown,
  Trash2,
  Code,
  Eye,
  Compass,
  User,
  MessageSquare,
} from "lucide-react";
import { useTeamStore } from "../../stores/teamStore";
import { useLayoutStore } from "../../stores/layoutStore";
import type { AgentRole } from "../../types/team";

/* ── Role config ── */

const ROLE_ICON: Record<AgentRole | "user", React.ElementType> = {
  coder: Code,
  reviewer: Eye,
  architect: Compass,
  user: User,
};

const ROLE_LABEL: Record<AgentRole | "user", string> = {
  coder: "Coder",
  reviewer: "Reviewer",
  architect: "Architect",
  user: "You",
};

/* ── Unified message type for the feed ── */

interface FeedMessage {
  id: string;
  sender: AgentRole | "user";
  agentId?: string;
  text: string;
  timestamp: number;
  broadcastId?: string;
}

/* ── Component ── */

export const MasterChat = memo(function MasterChat() {
  const { masterChatTeamId, closeMasterChat } = useLayoutStore(
    useShallow((s) => ({
      masterChatTeamId: s.masterChatTeamId,
      closeMasterChat: s.closeMasterChat,
    })),
  );

  const { teams, messages: mailboxMessages, fetchTeams, fetchAllMessages } =
    useTeamStore(
      useShallow((s) => ({
        teams: s.teams,
        messages: s.messages,
        fetchTeams: s.fetchTeams,
        fetchAllMessages: s.fetchAllMessages,
      })),
    );

  const team = useMemo(
    () => teams.find((t) => t.id === masterChatTeamId) ?? null,
    [teams, masterChatTeamId],
  );

  // Fetch teams if needed
  useEffect(() => {
    if (masterChatTeamId && teams.length === 0) {
      fetchTeams().catch(console.error);
    }
  }, [masterChatTeamId, teams.length, fetchTeams]);

  // Poll mailbox messages every 4s
  useEffect(() => {
    if (!team) return;
    fetchAllMessages(team.name).catch(console.error);
    const interval = setInterval(() => {
      fetchAllMessages(team.name).catch(console.error);
    }, 4000);
    return () => clearInterval(interval);
  }, [team, fetchAllMessages]);

  // Build agent role map
  const agentRoleMap = useMemo(() => {
    const map = new Map<string, AgentRole>();
    if (team) {
      for (const a of team.agents) {
        map.set(a.agent_id, a.role);
      }
    }
    return map;
  }, [team]);

  // Build unified feed from mailbox messages, deduplicate broadcasts
  const feed = useMemo(() => {
    if (!team) return [];
    const items: FeedMessage[] = [];

    for (const msg of mailboxMessages) {
      const role = msg.from === "user"
        ? "user" as const
        : agentRoleMap.get(msg.from) ?? ("coder" as AgentRole);
      items.push({
        id: `mail-${msg.id}`,
        sender: role,
        agentId: msg.from === "user" ? undefined : msg.from,
        text: msg.text,
        timestamp: new Date(msg.timestamp).getTime(),
        broadcastId: msg.broadcast_id,
      });
    }

    // Deduplicate broadcast copies — keep only the first per broadcast_id
    const seen = new Set<string>();
    const deduped = items.filter((item) => {
      if (!item.broadcastId) return true;
      if (seen.has(item.broadcastId)) return false;
      seen.add(item.broadcastId);
      return true;
    });

    deduped.sort((a, b) => a.timestamp - b.timestamp);
    return deduped;
  }, [team, mailboxMessages, agentRoleMap]);

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

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        e.preventDefault();
        closeMasterChat();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeMasterChat]);

  if (!team) {
    return (
      <div className="master-chat">
        <div className="master-chat__header">
          <span className="master-chat__title">Master Chat</span>
          <button className="settings-close" onClick={closeMasterChat} title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
        <div className="master-chat__empty">No team selected</div>
      </div>
    );
  }

  return (
    <div className="master-chat">
      <div className="master-chat__header">
        <MessageSquare size={16} className="master-chat__header-icon" />
        <span className="master-chat__title">{team.name} — Master Chat</span>
        <button
          className="master-chat__clear-btn"
          onClick={() => useTeamStore.getState().clearMessages(team.name).catch(console.error)}
          title="Clear messages"
        >
          <Trash2 size={14} />
        </button>
        <button className="settings-close" onClick={closeMasterChat} title="Close (Esc)">
          <X size={18} />
        </button>
      </div>

      <div className="master-chat__feed" ref={scrollRef} onScroll={handleScroll}>
        {feed.length === 0 ? (
          <div className="master-chat__empty">
            No messages yet. Start agents and send a message.
          </div>
        ) : (
          feed.map((msg) => (
            <FeedItem key={msg.id} msg={msg} />
          ))
        )}
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

      <SendBar team={team} />
    </div>
  );
});

/* ── Single feed message ── */

const COLLAPSE_THRESHOLD = 150;

function FeedItem({ msg }: { msg: FeedMessage }) {
  const Icon = ROLE_ICON[msg.sender];
  const label = ROLE_LABEL[msg.sender];
  const isRight = msg.sender === "architect" || msg.sender === "user";
  const side = isRight ? "right" : "left";

  const needsCollapse = msg.text.length > COLLAPSE_THRESHOLD;
  const [collapsed, setCollapsed] = useState(needsCollapse);

  const displayText = collapsed
    ? msg.text.slice(0, msg.text.indexOf("\n", 0) > 0 ? msg.text.indexOf("\n", 0) : COLLAPSE_THRESHOLD) + "..."
    : msg.text;

  return (
    <div className={`master-chat__msg-wrap master-chat__msg-wrap--${side}`}>
      <div className={`master-chat__bubble master-chat__bubble--${side}`}>
        <div className="master-chat__msg-header">
          <Icon size={13} className={`master-chat__msg-icon master-chat__msg-icon--${msg.sender}`} />
          <span className="master-chat__msg-sender">{label}</span>
          <span className="master-chat__msg-time">
            {new Date(msg.timestamp).toLocaleTimeString()}
          </span>
        </div>
        <div className="master-chat__msg-text">{displayText}</div>
        {needsCollapse && (
          <button
            className="master-chat__expand-btn"
            onClick={() => setCollapsed((p) => !p)}
          >
            {collapsed ? "Show more \u25B6" : "Show less \u25BC"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Send bar ── */

function SendBar({ team }: { team: { name: string; agents: { agent_id: string; role: AgentRole }[] } }) {
  const [text, setText] = useState("");
  const [to, setTo] = useState("all");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 210) + "px";
  }, [text]);

  const handleSend = useCallback(async () => {
    if (!text.trim()) return;
    try {
      const store = useTeamStore.getState();
      if (to === "all") {
        const ids = team.agents.map((a) => a.agent_id);
        await store.broadcastMessage(team.name, "user", text.trim(), ids);
      } else {
        await store.sendMessage(team.name, "user", to, text.trim());
      }
      setText("");
    } catch (e) {
      console.error("[MasterChat] sendMessage:", e);
    }
  }, [team.name, team.agents, to, text]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.code === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend().catch(console.error);
      }
    },
    [handleSend],
  );

  return (
    <div className="chat-bottom">
      <div className="input-bar">
        <div className="input-bar-row">
          <textarea
            ref={textareaRef}
            className="input-bar-textarea"
            rows={1}
            placeholder="Message..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKey}
          />
        </div>
        <div className="input-bar-bottom">
          <div className="input-bar-cell--btns">
            <select
              className="input-bar-label-btn"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            >
              <option value="all">All agents</option>
              {team.agents.map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {ROLE_LABEL[a.role] ?? a.role}
                </option>
              ))}
            </select>
          </div>
          <div className="input-bar-cell--btns input-bar-cell--end">
            <button
              className="input-bar-btn input-bar-send"
              onClick={() => handleSend().catch(console.error)}
              disabled={!text.trim()}
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
