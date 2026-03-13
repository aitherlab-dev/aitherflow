import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  X,
  Send,
  Code,
  Eye,
  Compass,
  User,
  MessageSquare,
} from "lucide-react";
import { useTeamStore } from "../../stores/teamStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore, agentStates } from "../../stores/chatStore";
import { useAgentStore } from "../../stores/agentStore";
import type { AgentRole } from "../../types/team";
import type { ChatMessage } from "../../types/chat";

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
  source: "mailbox" | "agent-response";
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

  // Force re-render to pick up agent responses (agentStates is a Map, not reactive)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 4000);
    return () => clearInterval(interval);
  }, []);

  // Get active agent's messages from Zustand (for the currently active team agent)
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const zustandMessages = useChatStore((s) => s.messages);

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

  // Build unified feed
  const feed = useMemo(() => {
    if (!team) return [];
    const items: FeedMessage[] = [];

    // 1. Mailbox messages
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
        source: "mailbox",
      });
    }

    // 2. Last assistant message from each running team agent
    for (const agent of team.agents) {
      if (agent.status !== "running") continue;

      let messages: ChatMessage[];
      if (agent.agent_id === activeAgentId) {
        messages = zustandMessages;
      } else {
        messages = agentStates.get(agent.agent_id)?.messages ?? [];
      }

      // Find last assistant text message (skip empty / tool-only)
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "assistant" && m.text.trim()) {
          items.push({
            id: `agent-${agent.agent_id}-${m.id}`,
            sender: agent.role,
            agentId: agent.agent_id,
            text: m.text,
            timestamp: m.timestamp,
            source: "agent-response",
          });
          break;
        }
      }
    }

    // Sort by timestamp
    items.sort((a, b) => a.timestamp - b.timestamp);
    return items;
  }, [team, mailboxMessages, agentRoleMap, activeAgentId, zustandMessages, tick]);

  // Scroll to bottom on new messages
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.length]);

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
        <button className="settings-close" onClick={closeMasterChat} title="Close (Esc)">
          <X size={18} />
        </button>
      </div>

      <div className="master-chat__feed" ref={scrollRef}>
        {feed.length === 0 ? (
          <div className="master-chat__empty">
            No messages yet. Start agents and send a message.
          </div>
        ) : (
          feed.map((msg) => (
            <FeedItem key={msg.id} msg={msg} />
          ))
        )}
      </div>

      <SendBar team={team} />
    </div>
  );
});

/* ── Single feed message ── */

function FeedItem({ msg }: { msg: FeedMessage }) {
  const Icon = ROLE_ICON[msg.sender];
  const label = ROLE_LABEL[msg.sender];

  return (
    <div className={`master-chat__msg master-chat__msg--${msg.sender}`}>
      <div className="master-chat__msg-header">
        <Icon size={13} className="master-chat__msg-icon" />
        <span className="master-chat__msg-sender">{label}</span>
        <span className="master-chat__msg-time">
          {new Date(msg.timestamp).toLocaleTimeString()}
        </span>
        {msg.source === "agent-response" && (
          <span className="master-chat__msg-badge">response</span>
        )}
      </div>
      <div className="master-chat__msg-text">{msg.text}</div>
    </div>
  );
}

/* ── Send bar ── */

function SendBar({ team }: { team: { name: string; agents: { agent_id: string; role: AgentRole }[] } }) {
  const [text, setText] = useState("");
  const [to, setTo] = useState("all");

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

  return (
    <div className="master-chat__send">
      <select
        className="master-chat__send-to"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      >
        <option value="all">All agents</option>
        {team.agents.map((a) => (
          <option key={a.agent_id} value={a.agent_id}>
            {ROLE_LABEL[a.role]} ({a.agent_id.slice(0, 8)})
          </option>
        ))}
      </select>
      <input
        className="master-chat__send-input"
        placeholder="Message..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.code === "Enter") handleSend().catch(console.error);
        }}
      />
      <button
        className="master-chat__send-btn"
        onClick={() => handleSend().catch(console.error)}
        title="Send"
      >
        <Send size={14} />
      </button>
    </div>
  );
}
