import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Home, Settings, FolderOpen, BookOpen, Cog } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { useLayoutStore } from "../../../stores/layoutStore";
import { useChatStore } from "../../../stores/chatStore";
import { useAgentStore } from "../../../stores/agentStore";
import { useConductorStore } from "../../../stores/conductorStore";
import { ResizeHandle } from "../ResizeHandle";
import { FilesPanel } from "../files-panel";
import { KnowledgePanel } from "../../knowledge/KnowledgePanel";

import { DashboardPanel } from "../../dashboard/DashboardPanel";
import { AgentTab } from "./AgentTab";
import { WorktreeTab } from "./WorktreeTab";

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
  const agentRoles = useConductorStore(useShallow((s) => s.agentRoles));

  // Split agents into root (no parent) and children grouped by parent
  const rootAgents = useMemo(
    () => agents.filter((a) => !a.parentAgentId),
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
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);

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

  const handleKnowledgeClick = useCallback(() => {
    setKnowledgeOpen((prev) => !prev);
  }, []);

  const handleKnowledgeSettings = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    openSettings("knowledge");
    closeMobile();
  }, [openSettings, closeMobile]);


  // ── Shift+drag reorder for agent tabs ──

  const agentDragRef = useRef<{
    fromIndex: number;
    el: HTMLElement;
    startY: number;
    offsetY: number;
  } | null>(null);
  const [agentDragIndex, setAgentDragIndex] = useState<number | null>(null);
  const [agentDropIndex, setAgentDropIndex] = useState<number | null>(null);
  const agentDropRef = useRef<number | null>(null);
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
      agentDropRef.current = index;
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
      agentDropRef.current = newDrop;
      setAgentDropIndex(newDrop);
    };

    const handleMouseUp = () => {
      const dropIdx = agentDropRef.current;
      if (agentDragRef.current && dropIdx !== null) {
        const from = agentDragRef.current.fromIndex;
        if (from !== dropIdx) {
          useAgentStore.getState().reorderAgent(from, dropIdx).catch(console.error);
        }
      }
      agentDragRef.current = null;
      agentDropRef.current = null;
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
  }, [agentDragIndex, agents.length]);

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

          {/* Knowledge — accordion like Files */}
          <div
            className={`dash-card sidebar-files-toggle${knowledgeOpen ? " dash-card--expanded" : ""}`}
            onClick={handleKnowledgeClick}
          >
            <div className="dash-card__header">
              <BookOpen size={14} className="dash-card__icon" />
              <span className="dash-card__title">Knowledge</span>
              <button className="dash-card__action" onClick={handleKnowledgeSettings}>
                <Cog size={12} />
              </button>
            </div>
          </div>
          {knowledgeOpen && (
            <div className="files-accordion">
              <KnowledgePanel />
            </div>
          )}

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
                      projectName={agentRoles[agent.id]?.name ? `${agent.projectName} | ${agentRoles[agent.id]!.name}` : `${agent.projectName} | Agent`}
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

          {/* Spacer — absorbs free space between agents and bottom items */}
          <div className="sidebar-spacer" />
          <DashboardPanel />
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
