import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Home, Plus, Settings, FolderOpen, LayoutDashboard } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { useLayoutStore } from "../../../stores/layoutStore";
import { useChatStore } from "../../../stores/chatStore";
import { useAgentStore } from "../../../stores/agentStore";
import { ResizeHandle } from "../ResizeHandle";
import { FilesPanel } from "../FilesPanel";
import { DashboardPanel } from "../../dashboard/DashboardPanel";
import { AgentTab } from "./AgentTab";
import { ProjectDropdown } from "./ProjectDropdown";

export const Sidebar = memo(function Sidebar() {
  const isMobile = useIsMobile();
  const open = useLayoutStore((s) => s.sidebarOpen);
  const width = useLayoutStore((s) => s.sidebarWidth);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const activeView = useLayoutStore((s) => s.activeView);
  const openSettings = useLayoutStore((s) => s.openSettings);
  const closeSettings = useLayoutStore((s) => s.closeSettings);
  const openWelcome = useLayoutStore((s) => s.openWelcome);
  const closeWelcome = useLayoutStore((s) => s.closeWelcome);

  /** Close sidebar on mobile after navigation actions */
  const closeMobile = useCallback(() => {
    if (isMobile && open) toggleSidebar();
  }, [isMobile, open, toggleSidebar]);

  const agents = useAgentStore((s) => s.agents);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const createAgent = useAgentStore((s) => s.createAgent);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const setActiveAgent = useAgentStore((s) => s.setActiveAgent);
  const getLockedChatIds = useAgentStore((s) => s.getLockedChatIds);
  const reorderAgent = useAgentStore((s) => s.reorderAgent);

  const chatList = useChatStore((s) => s.chatList);
  const currentChatId = useChatStore((s) => s.currentChatId);
  const isThinking = useChatStore((s) => s.isThinking);
  const thinkingAgentIds = useChatStore(useShallow((s) => s.thinkingAgentIds));
  const newChat = useChatStore((s) => s.newChat);
  const switchChat = useChatStore((s) => s.switchChat);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const renameChat = useChatStore((s) => s.renameChat);
  const toggleChatPin = useChatStore((s) => s.toggleChatPin);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(true);

  const handleNewAgent = useCallback(() => {
    setDropdownOpen((prev) => !prev);
  }, []);

  const handleProjectSelect = useCallback(
    (projectPath: string, projectName: string) => {
      setDropdownOpen(false);
      createAgent(projectPath, projectName).catch(console.error);
      closeMobile();
    },
    [createAgent, closeMobile],
  );

  const handleActivateAgent = useCallback(
    (agentId: string) => {
      setDropdownOpen(false);
      if (activeView === "settings") closeSettings();
      setActiveAgent(agentId).catch(console.error);
      closeMobile();
    },
    [activeView, closeSettings, setActiveAgent, closeMobile],
  );

  const handleCloseAgent = useCallback(
    (agentId: string) => {
      removeAgent(agentId).catch(console.error);
    },
    [removeAgent],
  );

  const handleNewChat = useCallback(() => {
    if (!isThinking) newChat().catch(console.error);
  }, [isThinking, newChat]);

  const handleSelectChat = useCallback(
    (id: string) => {
      if (activeView === "settings") closeSettings();
      switchChat(id).catch(console.error);
      closeMobile();
    },
    [activeView, closeSettings, switchChat, closeMobile],
  );

  const handleDeleteChat = useCallback(
    (id: string) => {
      deleteChat(id).catch(console.error);
    },
    [deleteChat],
  );

  const handleRenameChat = useCallback(
    (id: string, newTitle: string) => {
      renameChat(id, newTitle).catch(console.error);
    },
    [renameChat],
  );

  const handleToggleChatPin = useCallback(
    (id: string, pinned: boolean) => {
      toggleChatPin(id, pinned).catch(console.error);
    },
    [toggleChatPin],
  );

  const handleSettingsClick = useCallback(() => {
    setDropdownOpen(false);
    if (activeView === "settings") {
      closeSettings();
    } else {
      openSettings();
    }
    closeMobile();
  }, [activeView, closeSettings, openSettings, closeMobile]);

  const handleWelcomeClick = useCallback(() => {
    setDropdownOpen(false);
    if (activeView === "welcome") {
      closeWelcome();
    } else {
      openWelcome();
    }
    closeMobile();
  }, [activeView, closeWelcome, openWelcome, closeMobile]);

  const handleFilesClick = useCallback(() => {
    setDropdownOpen(false);
    setFilesOpen((prev) => !prev);
  }, []);

  const handleDashboardClick = useCallback(() => {
    setDropdownOpen(false);
    setDashboardOpen((prev) => !prev);
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
      for (let i = 0; i < refs.length; i++) {
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
          reorderAgent(from, agentDropIndex).catch(console.error);
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
  }, [agentDragIndex, agentDropIndex, agents.length, reorderAgent]);

  return (
    <aside
      className="app-sidebar"
      style={{ width: open ? width : 0 }}
    >
      {open && (
        <>
          {/* Agent block */}
          <div className="sidebar-content">
            {/* Welcome — project switcher */}
            <button
              className={`sidebar-tab ${activeView === "welcome" ? "sidebar-tab--active" : ""}`}
              onClick={handleWelcomeClick}
            >
              <Home size={16} />
              <span>Home</span>
            </button>
            {/* New Agent — pinned to top */}
            <div className="sidebar-agent-top">
              <button
                className={`sidebar-tab ${dropdownOpen ? "sidebar-tab--expanded" : ""}`}
                onClick={handleNewAgent}
              >
                <Plus size={16} />
                <span>New Agent</span>
              </button>
              {dropdownOpen && (
                <ProjectDropdown
                  onSelect={handleProjectSelect}
                />
              )}
            </div>

            {agents.map((agent, index) => (
              <div
                key={agent.id}
                ref={(el) => { agentRefs.current[index] = el; }}
                className={`sidebar-agent-slot ${agentDragIndex === index ? "sidebar-agent-slot--dragging" : ""} ${agentDropIndex === index && agentDragIndex !== null && agentDragIndex !== index ? "sidebar-agent-slot--drop-target" : ""}`}
                onMouseDown={(e) => handleAgentMouseDown(e, index)}
              >
                <AgentTab
                  agentId={agent.id}
                  projectName={agent.projectName}
                  isActive={agent.id === activeAgentId}
                  isOnly={agents.length === 1}
                  chatList={agent.id === activeAgentId ? chatList : []}
                  currentChatId={agent.id === activeAgentId ? currentChatId : null}
                  isThinking={agent.id === activeAgentId && isThinking}
                  isBackgroundThinking={thinkingAgentIds.includes(agent.id)}
                  lockedChatIds={activeAgentId ? getLockedChatIds(activeAgentId) : []}
                  onActivate={handleActivateAgent}
                  onClose={handleCloseAgent}
                  onNewChat={handleNewChat}
                  onSelectChat={handleSelectChat}
                  onDeleteChat={handleDeleteChat}
                  onRenameChat={handleRenameChat}
                  onToggleChatPin={handleToggleChatPin}
                />
              </div>
            ))}
          </div>

          {/* Functional tabs */}
          <button
            className={`sidebar-tab ${filesOpen ? "sidebar-tab--active" : ""}`}
            onClick={handleFilesClick}
          >
            <FolderOpen size={16} />
            <span>Files</span>
          </button>

          {/* Files accordion */}
          {filesOpen && (
            <div className="files-accordion">
              <FilesPanel />
            </div>
          )}

          {/* Dashboard + Settings — pinned to bottom */}
          <div className="sidebar-bottom">
            {dashboardOpen && (
              <div className="dashboard-accordion">
                <DashboardPanel />
              </div>
            )}
            <button
              className={`sidebar-tab ${dashboardOpen ? "sidebar-tab--active" : ""}`}
              onClick={handleDashboardClick}
            >
              <LayoutDashboard size={16} />
              <span>Dashboard</span>
            </button>
            <button
              className={`sidebar-tab ${activeView === "settings" ? "sidebar-tab--active" : ""}`}
              onClick={handleSettingsClick}
            >
              <Settings size={16} />
              <span>Settings</span>
            </button>
          </div>

          <ResizeHandle />
        </>
      )}
    </aside>
  );
});
