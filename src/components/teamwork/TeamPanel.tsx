import { memo, useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  X,
  Plus,
  UserPlus,
  Trash2,
  Send,
  CheckCircle,
  Circle,
  Clock,
  Code,
  Eye,
  Compass,
  Play,
  Square,
} from "lucide-react";
import { useTeamStore } from "../../stores/teamStore";
import { useLayoutStore } from "../../stores/layoutStore";
import type { Team, TeamAgent, AgentRole } from "../../types/team";

const ROLE_ICON: Record<AgentRole, React.ElementType> = {
  coder: Code,
  reviewer: Eye,
  architect: Compass,
};

const ROLE_LABEL: Record<AgentRole, string> = {
  coder: "Coder",
  reviewer: "Reviewer",
  architect: "Architect",
};

const STATUS_CLASS: Record<string, string> = {
  idle: "team-dot--gray",
  running: "team-dot--green",
  stopped: "team-dot--red",
};

export const TeamPanel = memo(function TeamPanel() {
  const close = useLayoutStore((s) => s.closeTeamwork);

  const { teams, activeTeamId, setActiveTeam, fetchTeams, messages, tasks } =
    useTeamStore(useShallow((s) => ({
      teams: s.teams,
      activeTeamId: s.activeTeamId,
      setActiveTeam: s.setActiveTeam,
      fetchTeams: s.fetchTeams,
      messages: s.messages,
      tasks: s.tasks,
    })));

  useEffect(() => {
    fetchTeams().catch(console.error);
  }, [fetchTeams]);

  const activeTeam = teams.find((t) => t.id === activeTeamId) ?? null;

  // Load tasks and messages when active team changes
  useEffect(() => {
    if (!activeTeamId) return;
    const team = useTeamStore.getState().teams.find((t) => t.id === activeTeamId);
    if (!team) return;
    useTeamStore.getState().fetchTasks(team.name).catch(console.error);
    useTeamStore.getState().fetchAllMessages(team.name).catch(console.error);
  }, [activeTeamId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        e.preventDefault();
        close();
      }
    },
    [close],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="team-view">
      <div className="team-sidebar">
        <div className="team-sidebar__header">Teams</div>
        <TeamList
          teams={teams}
          activeTeamId={activeTeamId}
          onSelect={setActiveTeam}
        />
        <CreateTeamButton />
      </div>

      <div className="team-content">
        <div className="team-content__header">
          <h2 className="team-content__title">
            {activeTeam ? activeTeam.name : "Select a team"}
          </h2>
          <button className="settings-close" onClick={close} title="Close (Esc)">
            <X size={18} />
          </button>
        </div>

        {activeTeam ? (
          <div className="team-content__body">
            <AgentsSection team={activeTeam} />
            <MessagesSection team={activeTeam} messages={messages} />
            <TasksSection team={activeTeam} tasks={tasks} />
          </div>
        ) : (
          <div className="team-placeholder">
            <p>Create or select a team to get started</p>
          </div>
        )}
      </div>
    </div>
  );
});

/* ── Team list ── */

function TeamList({
  teams,
  activeTeamId,
  onSelect,
}: {
  teams: Team[];
  activeTeamId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="team-list">
      {teams.map((t) => (
        <button
          key={t.id}
          className={`team-list__item ${t.id === activeTeamId ? "team-list__item--active" : ""}`}
          onClick={() => onSelect(t.id)}
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}

/* ── Create team button ── */

function CreateTeamButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");

  const handleCreate = useCallback(async () => {
    if (!name.trim() || !path.trim()) return;
    try {
      await useTeamStore.getState().createTeam(name.trim(), path.trim());
      setName("");
      setPath("");
      setOpen(false);
    } catch (e) {
      console.error("[TeamPanel] createTeam:", e);
    }
  }, [name, path]);

  if (!open) {
    return (
      <button className="team-add-btn" onClick={() => setOpen(true)}>
        <Plus size={14} />
        <span>New Team</span>
      </button>
    );
  }

  return (
    <div className="team-create-form">
      <input
        className="team-input"
        placeholder="Team name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <input
        className="team-input"
        placeholder="Project path"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <div className="team-create-form__actions">
        <button className="team-btn team-btn--primary" onClick={handleCreate}>
          Create
        </button>
        <button className="team-btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ── Agents section ── */

function AgentsSection({ team }: { team: Team }) {
  const [adding, setAdding] = useState(false);
  const [role, setRole] = useState<AgentRole>("coder");

  const handleAdd = useCallback(async () => {
    try {
      await useTeamStore.getState().addAgent(team.id, role);
      setAdding(false);
    } catch (e) {
      console.error("[TeamPanel] addAgent:", e);
    }
  }, [team.id, role]);

  const handleRemove = useCallback(
    async (agentId: string) => {
      try {
        await useTeamStore.getState().removeAgent(team.id, agentId);
      } catch (e) {
        console.error("[TeamPanel] removeAgent:", e);
      }
    },
    [team.id],
  );

  const handleStart = useCallback(
    async (agentId: string) => {
      try {
        await useTeamStore.getState().startAgent(team.id, agentId);
      } catch (e) {
        console.error("[TeamPanel] startAgent:", e);
      }
    },
    [team.id],
  );

  const handleStop = useCallback(
    async (agentId: string) => {
      try {
        await useTeamStore.getState().stopAgent(team.id, agentId);
      } catch (e) {
        console.error("[TeamPanel] stopAgent:", e);
      }
    },
    [team.id],
  );

  return (
    <div className="team-section">
      <div className="team-section__header">
        <h3 className="team-section__title">Agents</h3>
        <button className="team-icon-btn" onClick={() => setAdding(!adding)} title="Add agent">
          <UserPlus size={14} />
        </button>
      </div>

      {adding && (
        <div className="team-add-agent">
          <select
            className="team-select"
            value={role}
            onChange={(e) => setRole(e.target.value as AgentRole)}
          >
            <option value="coder">Coder</option>
            <option value="reviewer">Reviewer</option>
            <option value="architect">Architect</option>
          </select>
          <button className="team-btn team-btn--primary" onClick={handleAdd}>
            Add
          </button>
          <button className="team-btn" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      )}

      <div className="team-agents-grid">
        {team.agents.map((agent) => (
          <AgentCard
            key={agent.agent_id}
            agent={agent}
            onRemove={handleRemove}
            onStart={handleStart}
            onStop={handleStop}
          />
        ))}
        {team.agents.length === 0 && (
          <p className="team-empty">No agents yet</p>
        )}
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  onRemove,
  onStart,
  onStop,
}: {
  agent: TeamAgent;
  onRemove: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const RoleIcon = ROLE_ICON[agent.role];
  const isRunning = agent.status === "running";

  return (
    <div className="team-agent-card">
      <div className="team-agent-card__top">
        <RoleIcon size={14} className="team-agent-card__role-icon" />
        <span className="team-agent-card__role">{ROLE_LABEL[agent.role]}</span>
        <span className={`team-dot ${STATUS_CLASS[agent.status]}`} />
        <span className="team-agent-card__status">{agent.status}</span>
      </div>
      <div className="team-agent-card__bottom">
        <code className="team-agent-card__id">{agent.agent_id.slice(0, 8)}</code>
        {agent.worktree_branch && (
          <span className="team-agent-card__branch">{agent.worktree_branch}</span>
        )}
        {isRunning ? (
          <button
            className="team-icon-btn team-icon-btn--danger"
            onClick={() => onStop(agent.agent_id)}
            title="Stop agent"
          >
            <Square size={12} />
          </button>
        ) : (
          <button
            className="team-icon-btn team-icon-btn--accent"
            onClick={() => onStart(agent.agent_id)}
            title="Start agent"
          >
            <Play size={12} />
          </button>
        )}
        <button
          className="team-icon-btn team-icon-btn--danger"
          onClick={() => onRemove(agent.agent_id)}
          title="Remove agent"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

/* ── Messages section ── */

function MessagesSection({
  team,
  messages,
}: {
  team: Team;
  messages: TeamMessage[];
}) {
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Auto-set from/to from agent list
  useEffect(() => {
    if (team.agents.length > 0 && !from) {
      setFrom(team.agents[0].agent_id);
    }
    if (team.agents.length > 1 && !to) {
      setTo(team.agents[1].agent_id);
    }
  }, [team.agents, from, to]);

  const handleSend = useCallback(async () => {
    if (!text.trim() || !from || !to) return;
    try {
      await useTeamStore.getState().sendMessage(team.name, from, to, text.trim());
      setText("");
    } catch (e) {
      console.error("[TeamPanel] sendMessage:", e);
    }
  }, [team.name, from, to, text]);

  return (
    <div className="team-section">
      <div className="team-section__header">
        <h3 className="team-section__title">Messages</h3>
      </div>

      <div className="team-messages-log">
        {messages.length === 0 ? (
          <p className="team-empty">No messages</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="team-message">
              <span className="team-message__from">{m.from.slice(0, 8)}</span>
              <span className="team-message__arrow">&rarr;</span>
              <span className="team-message__to">{m.to.slice(0, 8)}</span>
              <span className="team-message__text">{m.text}</span>
              <span className="team-message__time">
                {new Date(m.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))
        )}
      </div>

      {team.agents.length >= 2 && (
        <div className="team-send-bar">
          <select
            className="team-select team-select--small"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          >
            {team.agents.map((a) => (
              <option key={a.agent_id} value={a.agent_id}>
                {a.agent_id.slice(0, 8)}
              </option>
            ))}
          </select>
          <span className="team-send-bar__arrow">&rarr;</span>
          <select
            className="team-select team-select--small"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          >
            {team.agents.map((a) => (
              <option key={a.agent_id} value={a.agent_id}>
                {a.agent_id.slice(0, 8)}
              </option>
            ))}
          </select>
          <input
            className="team-input team-input--flex"
            placeholder="Message..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.code === "Enter") handleSend().catch(console.error);
            }}
          />
          <button className="team-icon-btn" onClick={() => handleSend().catch(console.error)} title="Send">
            <Send size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Tasks section ── */

function TasksSection({
  team,
  tasks,
}: {
  team: Team;
  tasks: TeamTask[];
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");

  const handleCreate = useCallback(async () => {
    if (!title.trim()) return;
    try {
      await useTeamStore.getState().createTask(team.name, title.trim(), desc.trim());
      setTitle("");
      setDesc("");
      setAdding(false);
    } catch (e) {
      console.error("[TeamPanel] createTask:", e);
    }
  }, [team.name, title, desc]);

  const statusIcon = (status: string) => {
    if (status === "completed") return <CheckCircle size={14} className="team-task__icon--done" />;
    if (status === "in_progress") return <Clock size={14} className="team-task__icon--progress" />;
    return <Circle size={14} className="team-task__icon--pending" />;
  };

  return (
    <div className="team-section">
      <div className="team-section__header">
        <h3 className="team-section__title">Tasks</h3>
        <button className="team-icon-btn" onClick={() => setAdding(!adding)} title="Add task">
          <Plus size={14} />
        </button>
      </div>

      {adding && (
        <div className="team-create-form">
          <input
            className="team-input"
            placeholder="Task title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <input
            className="team-input"
            placeholder="Description (optional)"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="team-create-form__actions">
            <button className="team-btn team-btn--primary" onClick={handleCreate}>
              Create
            </button>
            <button className="team-btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="team-tasks-list">
        {tasks.length === 0 ? (
          <p className="team-empty">No tasks</p>
        ) : (
          tasks.map((t) => (
            <div key={t.id} className="team-task">
              {statusIcon(t.status)}
              <div className="team-task__info">
                <span className="team-task__title">{t.title}</span>
                {t.description && (
                  <span className="team-task__desc">{t.description}</span>
                )}
              </div>
              {t.owner && (
                <span className="team-task__owner">{t.owner.slice(0, 8)}</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Re-export type for MessagesSection/TasksSection inline usage
type TeamMessage = import("../../types/team").TeamMessage;
type TeamTask = import("../../types/team").TeamTask;
