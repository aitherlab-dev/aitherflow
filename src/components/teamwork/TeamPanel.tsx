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
  User,
  Play,
  Square,
  UserCheck,
} from "lucide-react";
import { invoke } from "../../lib/transport";
import { useTeamStore } from "../../stores/teamStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useAgentStore } from "../../stores/agentStore";
import type { Team, TeamAgent, RoleEntry, TeamTask, TeamMessage } from "../../types/team";

interface WorktreeEntry {
  path: string;
  branch: string;
  isBare: boolean;
}

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
  const handleDelete = useCallback(
    async (e: React.MouseEvent, teamId: string) => {
      e.stopPropagation();
      try {
        const team = teams.find((t) => t.id === teamId);
        if (team) {
          const agentStore = useAgentStore.getState();
          for (const agent of team.agents) {
            if (agentStore.agents.some((a) => a.id === agent.agent_id)) {
              await agentStore.unregisterAgent(agent.agent_id);
            }
          }
        }
        await useTeamStore.getState().deleteTeam(teamId);
      } catch (e) {
        console.error("[TeamPanel] deleteTeam:", e);
      }
    },
    [teams],
  );

  return (
    <div className="team-list">
      {teams.map((t) => (
        <div
          key={t.id}
          className={`team-list__item ${t.id === activeTeamId ? "team-list__item--active" : ""}`}
          onClick={() => onSelect(t.id)}
        >
          <span className="team-list__name">{t.name}</span>
          <button
            className="team-icon-btn team-icon-btn--danger team-list__delete"
            onClick={(e) => handleDelete(e, t.id).catch(console.error)}
            title="Delete team"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── Create team button ── */

function CreateTeamButton() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    const activeAgent = useAgentStore.getState().getActiveAgent();
    const projectPath = activeAgent?.projectPath ?? "";
    if (!projectPath) return;
    try {
      await useTeamStore.getState().createTeam(name.trim(), projectPath);
      setName("");
      setOpen(false);
    } catch (e) {
      console.error("[TeamPanel] createTeam:", e);
    }
  }, [name]);

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
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [selectedRole, setSelectedRole] = useState<RoleEntry | null>(null);
  const [branch, setBranch] = useState("");
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);

  useEffect(() => {
    if (!adding) return;
    invoke<RoleEntry[]>("roles_list").then((r) => {
      setRoles(r);
      if (r.length > 0) setSelectedRole(r[0]);
    }).catch(console.error);
    invoke<WorktreeEntry[]>("get_worktrees", { projectPath: team.project_path })
      .then(setWorktrees)
      .catch(console.error);
  }, [adding, team.project_path]);

  const handleAdd = useCallback(async () => {
    if (!selectedRole) return;
    try {
      await useTeamStore.getState().addAgent(team.id, selectedRole, branch || null);
      setAdding(false);
      setBranch("");
    } catch (e) {
      console.error("[TeamPanel] addAgent:", e);
    }
  }, [team.id, selectedRole, branch]);

  const handleRemove = useCallback(
    async (agentId: string) => {
      try {
        await useTeamStore.getState().removeAgent(team.id, agentId);
        if (useAgentStore.getState().agents.some((a) => a.id === agentId)) {
          await useAgentStore.getState().unregisterAgent(agentId);
        }
      } catch (e) {
        console.error("[TeamPanel] removeAgent:", e);
      }
    },
    [team.id],
  );

  const handleStart = useCallback(
    async (agentId: string) => {
      const agent = team.agents.find((a) => a.agent_id === agentId);
      if (!agent) return;

      try {
        await useTeamStore.getState().startAgent(team.id, agentId);
      } catch (e) {
        // Already running — still switch to chat
        if (!String(e).includes("already running")) {
          console.error("[TeamPanel] startAgent:", e);
          return;
        }
      }

      await useAgentStore.getState().registerTeamAgent(
        agentId,
        team.project_path,
        `${agent.role.name} · ${team.name}`,
        team.id,
        agent.role.name,
      );
      useLayoutStore.getState().closeTeamwork();
    },
    [team],
  );

  const handleStop = useCallback(
    async (agentId: string) => {
      try {
        await useTeamStore.getState().stopAgent(team.id, agentId);
        if (useAgentStore.getState().agents.some((a) => a.id === agentId)) {
          await useAgentStore.getState().unregisterAgent(agentId);
        }
      } catch (e) {
        console.error("[TeamPanel] stopAgent:", e);
      }
    },
    [team.id],
  );

  const handleCardClick = useCallback(
    (agentId: string) => {
      const agents = useAgentStore.getState().agents;
      const exists = agents.some((a) => a.id === agentId);
      if (!exists) return;
      useAgentStore.getState().setActiveAgent(agentId).catch(console.error);
      useLayoutStore.getState().closeTeamwork();
    },
    [],
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
            value={selectedRole?.name ?? ""}
            onChange={(e) => {
              const found = roles.find((r) => r.name === e.target.value);
              if (found) setSelectedRole(found);
            }}
          >
            {roles.map((r) => (
              <option key={r.name} value={r.name}>{r.name}</option>
            ))}
          </select>
          <select
            className="team-select"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="">main</option>
            {worktrees
              .filter((w) => !w.isBare && w.branch && w.branch !== "(detached)")
              .map((w) => (
                <option key={w.branch} value={w.branch}>
                  {w.branch}
                </option>
              ))}
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
            onCardClick={handleCardClick}
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
  onCardClick,
}: {
  agent: TeamAgent;
  onRemove: (id: string) => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onCardClick: (id: string) => void;
}) {
  const isRunning = agent.status === "running";

  return (
    <div
      className="team-agent-card team-agent-card--clickable"
      onClick={() => onCardClick(agent.agent_id)}
    >
      <div className="team-agent-card__top">
        <User size={14} className="team-agent-card__role-icon" />
        <span className="team-agent-card__role">{agent.role.name}</span>
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
            onClick={(e) => { e.stopPropagation(); onStop(agent.agent_id); }}
            title="Stop agent"
          >
            <Square size={12} />
          </button>
        ) : (
          <button
            className="team-icon-btn team-icon-btn--accent"
            onClick={(e) => { e.stopPropagation(); onStart(agent.agent_id); }}
            title="Start agent"
          >
            <Play size={12} />
          </button>
        )}
        <button
          className="team-icon-btn team-icon-btn--danger"
          onClick={(e) => { e.stopPropagation(); onRemove(agent.agent_id); }}
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
      console.error("[TeamPanel] sendMessage:", e);
    }
  }, [team.name, team.agents, to, text]);

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

      {team.agents.length > 0 && (
        <div className="team-send-bar">
          <span className="team-send-bar__label">user</span>
          <span className="team-send-bar__arrow">&rarr;</span>
          <select
            className="team-select team-select--small"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          >
            <option value="all">All agents</option>
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
  const [assignTo, setAssignTo] = useState("");

  const handleCreate = useCallback(async () => {
    if (!title.trim()) return;
    try {
      const store = useTeamStore.getState();
      const task = await store.createTask(team.name, title.trim(), desc.trim());
      if (assignTo) {
        await store.claimTask(team.name, task.id, assignTo);
      }
      setTitle("");
      setDesc("");
      setAssignTo("");
      setAdding(false);
    } catch (e) {
      console.error("[TeamPanel] createTask:", e);
    }
  }, [team.name, title, desc, assignTo]);

  const handleClaim = useCallback(
    async (taskId: string, agentId: string) => {
      try {
        await useTeamStore.getState().claimTask(team.name, taskId, agentId);
      } catch (e) {
        console.error("[TeamPanel] claimTask:", e);
      }
    },
    [team.name],
  );

  const handleComplete = useCallback(
    async (taskId: string, ownerId: string) => {
      try {
        await useTeamStore.getState().completeTask(team.name, taskId, ownerId);
      } catch (e) {
        console.error("[TeamPanel] completeTask:", e);
      }
    },
    [team.name],
  );

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
          {team.agents.length > 0 && (
            <select
              className="team-select"
              value={assignTo}
              onChange={(e) => setAssignTo(e.target.value)}
            >
              <option value="">Unassigned</option>
              {team.agents.map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {a.role.name} ({a.agent_id.slice(0, 8)})
                </option>
              ))}
            </select>
          )}
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
            <TaskCard
              key={t.id}
              task={t}
              agents={team.agents}
              onClaim={handleClaim}
              onComplete={handleComplete}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TaskCard({
  task,
  agents,
  onClaim,
  onComplete,
}: {
  task: TeamTask;
  agents: TeamAgent[];
  onClaim: (taskId: string, agentId: string) => void;
  onComplete: (taskId: string, ownerId: string) => void;
}) {
  const [assignAgent, setAssignAgent] = useState("");

  const statusIcon = () => {
    if (task.status === "completed") return <CheckCircle size={14} className="team-task__icon--done" />;
    if (task.status === "in_progress") return <Clock size={14} className="team-task__icon--progress" />;
    return <Circle size={14} className="team-task__icon--pending" />;
  };

  const statusClass =
    task.status === "completed"
      ? "team-task--completed"
      : task.status === "in_progress"
        ? "team-task--progress"
        : "";

  return (
    <div className={`team-task ${statusClass}`}>
      {statusIcon()}
      <div className="team-task__info">
        <span className="team-task__title">{task.title}</span>
        {task.description && (
          <span className="team-task__desc">{task.description}</span>
        )}
      </div>
      <div className="team-task__actions">
        {task.owner && (
          <span className="team-task__owner">{task.owner.slice(0, 8)}</span>
        )}
        {task.status === "pending" && agents.length > 0 && (
          <div className="team-task__assign">
            <select
              className="team-select team-select--small"
              value={assignAgent}
              onChange={(e) => setAssignAgent(e.target.value)}
            >
              <option value="">Assign...</option>
              {agents.map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {a.agent_id.slice(0, 8)}
                </option>
              ))}
            </select>
            {assignAgent && (
              <button
                className="team-icon-btn team-icon-btn--accent"
                onClick={() => {
                  onClaim(task.id, assignAgent);
                  setAssignAgent("");
                }}
                title="Assign"
              >
                <UserCheck size={12} />
              </button>
            )}
          </div>
        )}
        {task.status === "in_progress" && task.owner && (
          <button
            className="team-icon-btn team-icon-btn--accent"
            onClick={() => onComplete(task.id, task.owner!)}
            title="Complete"
          >
            <CheckCircle size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
