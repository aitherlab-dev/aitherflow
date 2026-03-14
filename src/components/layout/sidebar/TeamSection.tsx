import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Users,
  ChevronRight,
  MessageSquare,
  Settings,
  Play,
  Square,
  Plus,
  Trash2,
  User,
  GitBranch,
} from "lucide-react";
import { useTeamStore } from "../../../stores/teamStore";
import { useAgentStore } from "../../../stores/agentStore";
import { useChatStore } from "../../../stores/chatStore";
import { useLayoutStore } from "../../../stores/layoutStore";
import type { Team, TeamAgent } from "../../../types/team";

const STATUS_CLASS: Record<string, string> = {
  idle: "team-dot--gray",
  running: "team-dot--green",
  stopped: "team-dot--red",
};

export const TeamSection = memo(function TeamSection() {
  const [open, setOpen] = useState(false);

  const { teams, fetchTeams } = useTeamStore(
    useShallow((s) => ({
      teams: s.teams,
      fetchTeams: s.fetchTeams,
    })),
  );

  // Effective project path: chatStore → active agent → first agent fallback
  const chatProjectPath = useChatStore((s) => s.projectPath);
  const projectPath = useMemo(() => {
    if (chatProjectPath) return chatProjectPath;
    const { agents, activeAgentId } = useAgentStore.getState();
    const active = agents.find((a) => a.id === activeAgentId);
    if (active?.projectPath) return active.projectPath;
    if (agents.length > 0) return agents[0].projectPath;
    return "";
  }, [chatProjectPath]);

  // Fetch teams when section opens
  useEffect(() => {
    if (open) {
      fetchTeams().catch(console.error);
    }
  }, [open, fetchTeams]);

  // Filter teams for current workspace; show all if no project context
  const workspaceTeams = useMemo(
    () => projectPath ? teams.filter((t) => t.project_path === projectPath) : teams,
    [teams, projectPath],
  );

  const handleToggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  const handleCreate = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!projectPath) {
        console.error("[TeamSection] createTeam: no project path available");
        return;
      }
      try {
        const defaultName = `Team ${workspaceTeams.length + 1}`;
        await useTeamStore.getState().createTeam(defaultName, projectPath);
        useLayoutStore.getState().openTeamwork();
        if (!open) setOpen(true);
      } catch (e) {
        console.error("[TeamSection] createTeam:", e);
      }
    },
    [projectPath, workspaceTeams.length, open],
  );

  return (
    <>
      <div
        className={`dash-card sidebar-teams-toggle ${open ? "dash-card--expanded" : ""}`}
        onClick={handleToggle}
      >
        <div className="dash-card__header">
          <Users size={14} className="dash-card__icon" />
          <span className="dash-card__title">Teams</span>
          <button
            className="dash-card__action"
            onClick={handleCreate}
            title="New Team"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      {open && (
        <div className="teams-accordion">
          {workspaceTeams.map((team) => (
            <TeamItem key={team.id} team={team} />
          ))}
        </div>
      )}
    </>
  );
});

/* ── Single team with expandable agent list ── */

function TeamItem({ team }: { team: Team }) {
  const [expanded, setExpanded] = useState(true);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleSettings = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      useTeamStore.getState().setActiveTeam(team.id);
      useLayoutStore.getState().openTeamwork();
    },
    [team.id],
  );

  const handleDelete = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        // Unregister team agents from agentStore
        const agentStore = useAgentStore.getState();
        for (const agent of team.agents) {
          if (agentStore.agents.some((a) => a.id === agent.agent_id)) {
            await agentStore.unregisterAgent(agent.agent_id);
          }
        }
        await useTeamStore.getState().deleteTeam(team.id);
      } catch (e) {
        console.error("[TeamSection] deleteTeam:", e);
      }
    },
    [team.id, team.agents],
  );

  return (
    <div className="teams-item">
      <div className="teams-item__header" onClick={handleToggle}>
        <ChevronRight
          size={12}
          className={`teams-item__chevron ${expanded ? "teams-item__chevron--open" : ""}`}
        />
        <span className="teams-item__name">{team.name}</span>
        <button
          className="teams-item__settings"
          onClick={handleDelete}
          title="Delete team"
        >
          <Trash2 size={12} />
        </button>
        <button
          className="teams-item__settings"
          onClick={handleSettings}
          title="Team settings"
        >
          <Settings size={12} />
        </button>
      </div>

      {expanded && (
        <div className="teams-item__agents">
          {/* Master Chat */}
          <div
            className="teams-agent teams-agent--master teams-agent--clickable"
            onClick={() => useLayoutStore.getState().openMasterChat(team.id)}
          >
            <MessageSquare size={12} className="teams-agent__icon" />
            <span className="teams-agent__name">Master Chat</span>
          </div>

          {team.agents.map((agent) => (
            <TeamAgentRow
              key={agent.agent_id}
              agent={agent}
              team={team}
              isActive={agent.agent_id === activeAgentId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Single agent row ── */

function TeamAgentRow({
  agent,
  team,
  isActive,
}: {
  agent: TeamAgent;
  team: Team;
  isActive: boolean;
}) {
  const isRunning = agent.status === "running";

  const handleClick = useCallback(() => {
    // If agent is running and registered, switch to its chat
    const agents = useAgentStore.getState().agents;
    const exists = agents.some((a) => a.id === agent.agent_id);
    if (!exists) return;

    const layout = useLayoutStore.getState();
    if (layout.activeView === "teamwork") layout.closeTeamwork();
    if (layout.activeView === "settings") layout.closeSettings();
    if (layout.activeView === "welcome") layout.closeWelcome();
    if (layout.activeView === "master-chat") layout.closeMasterChat();

    useAgentStore.getState().setActiveAgent(agent.agent_id).catch(console.error);
  }, [agent.agent_id]);

  const handleStart = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await useTeamStore.getState().startAgent(team.id, agent.agent_id);
      } catch (err) {
        if (!String(err).includes("already running")) {
          console.error("[TeamSection] startAgent:", err);
          return;
        }
      }

      await useAgentStore.getState().registerTeamAgent(
        agent.agent_id,
        team.project_path,
        `${agent.role.name} · ${team.name}`,
        team.id,
        agent.role.name,
      );

      if (useLayoutStore.getState().activeView === "teamwork") {
        useLayoutStore.getState().closeTeamwork();
      }
    },
    [agent, team],
  );

  const handleStop = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await useTeamStore.getState().stopAgent(team.id, agent.agent_id);
        if (useAgentStore.getState().agents.some((a) => a.id === agent.agent_id)) {
          await useAgentStore.getState().unregisterAgent(agent.agent_id);
        }
      } catch (err) {
        console.error("[TeamSection] stopAgent:", err);
      }
    },
    [team.id, agent.agent_id],
  );

  return (
    <div
      className={`teams-agent ${isActive ? "teams-agent--active" : ""} ${isRunning ? "teams-agent--clickable" : ""}`}
      onClick={isRunning ? handleClick : undefined}
    >
      <User size={12} className="teams-agent__icon" />
      <span className="teams-agent__name">{agent.role.name}</span>
      {agent.worktree_branch && (
        <span className="teams-agent__branch" title={agent.worktree_branch}>
          <GitBranch size={10} />
          {agent.worktree_branch}
        </span>
      )}
      <span className={`team-dot ${STATUS_CLASS[agent.status]}`} />

      <div className="teams-agent__actions">
        {isRunning ? (
          <button
            className="teams-agent__btn teams-agent__btn--stop"
            onClick={handleStop}
            title="Stop"
          >
            <Square size={10} />
          </button>
        ) : (
          <button
            className="teams-agent__btn teams-agent__btn--play"
            onClick={handleStart}
            title="Start"
          >
            <Play size={10} />
          </button>
        )}
      </div>
    </div>
  );
}
