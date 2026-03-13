import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Home, Settings, FolderOpen, GitBranch } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { useLayoutStore } from "../../../stores/layoutStore";
import { useChatStore } from "../../../stores/chatStore";
import { useAgentStore } from "../../../stores/agentStore";
import { ResizeHandle } from "../ResizeHandle";
import { FilesPanel } from "../files-panel";

import { DashboardPanel } from "../../dashboard/DashboardPanel";
import { WorktreePanel } from "../../chat/WorktreePanel";
import { AgentTab } from "./AgentTab";
import { WorktreeTab } from "./WorktreeTab";
import { TeamSection } from "./TeamSection";

export const Sidebar = memo(function Sidebar() {
  const isMobile = useIsMobile();
  const {
    sidebarOpen: open,
    sidebarWidth: width,
    toggleSidebar,
    activeView,
    openSettings,
    closeSettings,
    openWelcome,
    closeWelcome,
  } = useLayoutStore(useShallow((s) => ({
    sidebarOpen: s.sidebarOpen,
    sidebarWidth: s.sidebarWidth,
    toggleSidebar: s.toggleSidebar,
    activeView: s.activeView,
    openSettings: s.openSettings,
    closeSettings: s.closeSettings,
    openWelcome: s.openWelcome,
    closeWelcome: s.closeWelcome,
  })));

  /** Close sidebar on mobile after navigation actions */
  const closeMobile = useCallback(() => {
    if (isMobile && open) toggleSidebar();
  }, [isMobile, open, toggleSidebar]);

  const {
    agents,
    activeAgentId,
  } = useAgentStore(useShallow((s) => ({
    agents: s.agents,
    activeAgentId: s.activeAgentId,
  })));

  // Split agents into root (no parent, no team) and children grouped by parent
  const rootAgents = useMemo(
    () => agents.filter((a) => !a.parentAgentId && !a.teamId),
    [agents],
  );
  const childrenByParent = useMemo(() => {
    const map = new Map<string, typeof agents>();
    for (const a of agents) {
      if (a.parentAgentId) {
        const list = map.get(a.parentAgentId) ?? [];
        list.push(a);
        map.set(a.parentAgentId, list);
      }
    }
    return map;
  }, [agents]);

  const { isThinking, thinkingAgentIds } = useChatStore(
    useShallow((s) => ({
      isThinking: s.isThinking,
      thinkingAgentIds: s.thinkingAgentIds,
    })),
  );

  const [filesOpen, setFilesOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);

  const handleActivateAgent = useCallback(
    (agentId: string) => {
      if (activeView === "settings") closeSettings();
      if (activeView === "welcome") closeWelcome();
      useAgentStore.getState().setActiveAgent(agentId).catch(console.error);
      closeMobile();
    },
    [activeView, closeSettings, closeWelcome, closeMobile],
  );

  const handleCloseAgent = useCallback(
    (agentId: string) => {
      if (agents.length === 1) openWelcome();
      useAgentStore.getState().removeAgent(agentId).catch(console.error);
    },
    [agents.length, openWelcome],
  );

  const handleSettingsClick = useCallback(() => {
    if (activeView === "settings") {
      closeSettings();
    } else {
      openSettings();
    }
    closeMobile();
  }, [activeView, closeSettings, openSettings, closeMobile]);

  const handleWelcomeClick = useCallback(() => {
    if (activeView === "welcome") {
      closeWelcome();
    } else {
      openWelcome();
    }
    closeMobile();
  }, [activeView, closeWelcome, openWelcome, closeMobile]);

  const handleFilesClick = useCallback(() => {
    setFilesOpen((prev) => !prev);
  }, []);

  const handleBranchesClick = useCallback(() => {
    setBranchesOpen((prev) => !prev);
  }, []);

  // ── Shift+drag reorder for agent tabs ──

  const agentDragRef = useRef<{
    fromIndex: number;
    el: HTMLElement;
    startY: number;
    offsetY: number;
  } | null>(null);
  const [agentDragIndex, setAgentDragIndex] = useState<number | null>(null);
  const [agentDropIndex, setAgentDropIndex] = useState<number | null>(null);
  const agentRefs = useRef<(HTMLElement | null)[]>([]);

  const handleAgentMouseDown = useCallback(
    (e: React.MouseEvent, index: number) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      const el = agentRefs.current[index];
      if (!el) return;

      const rect = el.getBoundingClientRect();
      agentDragRef.current = {
        fromIndex: index,
        el,
        startY: rect.top,
        offsetY: e.clientY - rect.top,
      };
      setAgentDragIndex(index);
      setAgentDropIndex(index);
      document.body.classList.add("select-none");
    },
    [],
  );

  useEffect(() => {
    if (agentDragIndex === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!agentDragRef.current) return;

      const refs = agentRefs.current;
      let newDrop = agentDragRef.current.fromIndex;
      for (let i = 0; i < Math.min(refs.length, agents.length); i++) {
        const ref = refs[i];
        if (!ref) continue;
        const rect = ref.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (e.clientY < mid) {
          newDrop = i;
          break;
        }
        newDrop = i + 1;
      }
      newDrop = Math.max(0, Math.min(newDrop, agents.length - 1));
      setAgentDropIndex(newDrop);
    };

    const handleMouseUp = () => {
      if (agentDragRef.current && agentDropIndex !== null) {
        const from = agentDragRef.current.fromIndex;
        if (from !== agentDropIndex) {
          useAgentStore.getState().reorderAgent(from, agentDropIndex).catch(console.error);
        }
      }
      agentDragRef.current = null;
      setAgentDragIndex(null);
      setAgentDropIndex(null);
      document.body.classList.remove("select-none");
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [agentDragIndex, agentDropIndex, agents.length]);

  return (
    <aside
      className="app-sidebar"
      style={{ width: open ? width : 0 }}
    >
      {open && (
        <>
          {/* Home — pinned to top */}
          <div
            className="dash-card dash-card--home sidebar-nav-card"
            onClick={handleWelcomeClick}
          >
            <div className="dash-card__header">
              <Home size={14} className="dash-card__icon" />
              <span className="dash-card__title">Home</span>
            </div>
          </div>

          {/* Agent block */}
          <div className="sidebar-content">
            {rootAgents.map((agent, index) => {
              const children = childrenByParent.get(agent.id) ?? [];
              return (
                <div key={agent.id}>
                  <div
                    ref={(el) => { agentRefs.current[index] = el; }}
                    className={`sidebar-agent-slot ${agentDragIndex === index ? "sidebar-agent-slot--dragging" : ""} ${agentDropIndex === index && agentDragIndex !== null && agentDragIndex !== index ? "sidebar-agent-slot--drop-target" : ""}`}
                    onMouseDown={(e) => handleAgentMouseDown(e, index)}
                  >
                    <AgentTab
                      agentId={agent.id}
                      projectName={agent.projectName}
                      isActive={agent.id === activeAgentId}
                      isThinking={agent.id === activeAgentId && isThinking}
                      isBackgroundThinking={thinkingAgentIds.includes(agent.id)}
                      onActivate={handleActivateAgent}
                      onClose={handleCloseAgent}
                    />
                  </div>
                  {children.map((child) => (
                    <WorktreeTab
                      key={child.id}
                      agentId={child.id}
                      branchName={child.projectName}
                      isActive={child.id === activeAgentId}
                      isBackgroundThinking={thinkingAgentIds.includes(child.id)}
                      onActivate={handleActivateAgent}
                      onClose={handleCloseAgent}
                    />
                  ))}
                </div>
              );
            })}

          </div>

          {/* Branches — dash-card style, accordion expands below */}
          <div
            className={`dash-card sidebar-branches-toggle ${branchesOpen ? "dash-card--expanded" : ""}`}
            onClick={handleBranchesClick}
          >
            <div className="dash-card__header">
              <GitBranch size={14} className="dash-card__icon" />
              <span className="dash-card__title">Branches</span>
            </div>
          </div>
          {branchesOpen && (
            <div className="worktree-accordion">
              <WorktreePanel embedded />
            </div>
          )}

          {/* Files — dash-card style button, accordion expands below */}
          <div
            className={`dash-card sidebar-files-toggle ${filesOpen ? "dash-card--expanded" : ""}`}
            onClick={handleFilesClick}
          >
            <div className="dash-card__header">
              <FolderOpen size={14} className="dash-card__icon" />
              <span className="dash-card__title">Files</span>
            </div>
          </div>
          {filesOpen && (
            <div className="files-accordion">
              <FilesPanel />
            </div>
          )}

          {/* Teams — dash-card style, accordion expands below */}
          <TeamSection />

          {/* Spacer — absorbs free space between agents and bottom items */}
          <div className="sidebar-spacer" />
          <div className="dashboard-accordion">
            <DashboardPanel />
          </div>
          <div
            className="dash-card sidebar-nav-card"
            onClick={handleSettingsClick}
          >
            <div className="dash-card__header">
              <Settings size={14} className="dash-card__icon" />
              <span className="dash-card__title">Settings</span>
            </div>
          </div>

          <ResizeHandle />
        </>
      )}
    </aside>
  );
});
