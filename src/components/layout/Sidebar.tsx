import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Plus, Trash2, Settings, X, Brain, Sparkles, Cable, FolderOpen } from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore, type ChatMeta } from "../../stores/chatStore";
import { useAgentStore } from "../../stores/agentStore";
import { useProjectStore } from "../../stores/projectStore";
import { ResizeHandle } from "./ResizeHandle";
import { FilesPanel } from "./FilesPanel";

// ── Chat item (single chat in the list) ──

const ChatItem = memo(function ChatItem({
  chat,
  isCurrent,
  disabled,
  locked,
  onSelect,
  onDelete,
}: {
  chat: ChatMeta;
  isCurrent: boolean;
  disabled: boolean;
  locked: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [removing, setRemoving] = useState(false);

  const handleClick = useCallback(() => {
    if (!disabled && !locked && !isCurrent) onSelect(chat.id);
  }, [chat.id, disabled, locked, isCurrent, onSelect]);

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!disabled && !locked && !removing) {
        setRemoving(true);
        setTimeout(() => onDelete(chat.id), 250);
      }
    },
    [chat.id, disabled, locked, removing, onDelete],
  );

  return (
    <div
      className={`chat-item ${isCurrent ? "chat-item--active" : ""} ${disabled ? "chat-item--disabled" : ""} ${locked ? "chat-item--locked" : ""} ${removing ? "chat-item--removing" : ""}`}
      onClick={handleClick}
    >
      <span className="chat-item__title">{chat.title}</span>
      {!disabled && !locked && (
        <button
          className="chat-item__delete"
          onClick={handleDelete}
          title="Delete chat"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
});

// ── Agent tab (one agent in sidebar with accordion) ──

const AgentTab = memo(function AgentTab({
  agentId,
  projectName,
  isActive,
  isOnly,
  chatList,
  currentChatId,
  isThinking,
  lockedChatIds,
  onActivate,
  onClose,
  onNewChat,
  onSelectChat,
  onDeleteChat,
}: {
  agentId: string;
  projectName: string;
  isActive: boolean;
  isOnly: boolean;
  chatList: ChatMeta[];
  currentChatId: string | null;
  isThinking: boolean;
  lockedChatIds: string[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Collapse chat list when agent becomes inactive
  useEffect(() => {
    if (!isActive) setExpanded(false);
  }, [isActive]);

  const handleClick = useCallback(() => {
    if (isActive) {
      setExpanded((prev) => !prev);
    } else {
      onActivate(agentId);
    }
  }, [isActive, agentId, onActivate]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose(agentId);
    },
    [agentId, onClose],
  );

  return (
    <>
      <div className="sidebar-project-wrapper">
        <button
          className={`sidebar-project ${isActive ? "sidebar-project--active" : ""}`}
          onClick={handleClick}
        >
          <ChevronRight
            size={14}
            className={`sidebar-project__chevron ${expanded && isActive ? "sidebar-project__chevron--open" : ""}`}
          />
          <span className="sidebar-project__name">{projectName}</span>
        </button>
        <button
          className={`sidebar-project__close ${isOnly ? "sidebar-project__close--disabled" : ""}`}
          onClick={handleClose}
          disabled={isOnly}
          title="Close agent"
        >
          <X size={14} />
        </button>
      </div>

      {expanded && isActive && (
        <div className="sidebar-project-body">
          <button
            className={`sidebar-new-chat ${isThinking ? "sidebar-new-chat--disabled" : ""}`}
            onClick={() => { onNewChat(); setExpanded(false); }}
            disabled={isThinking}
          >
            <Plus size={16} />
            <span>New Chat</span>
          </button>

          <div className="sidebar-chat-list">
            {chatList.map((chat) => (
              <ChatItem
                key={chat.id}
                chat={chat}
                isCurrent={chat.id === currentChatId}
                disabled={isThinking}
                locked={lockedChatIds.includes(chat.id)}
                onSelect={(id: string) => { onSelectChat(id); setExpanded(false); }}
                onDelete={onDeleteChat}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
});

// ── Project dropdown (list of projects to create agent from) ──

const ProjectDropdown = memo(function ProjectDropdown({
  onSelect,
}: {
  onSelect: (projectPath: string, projectName: string) => void;
}) {
  const projects = useProjectStore((s) => s.projects);

  return (
    <div className="project-dropdown">
      {projects.map((p) => (
        <button
          key={p.path}
          className="project-dropdown__item"
          onClick={() => onSelect(p.path, p.name)}
        >
          <span className="project-dropdown__dot" />
          <span className="project-dropdown__name">{p.name}</span>
        </button>
      ))}
      {projects.length === 0 && (
        <div className="project-dropdown__empty">No projects yet</div>
      )}
    </div>
  );
});

// ── Main Sidebar ──

export const Sidebar = memo(function Sidebar() {
  const open = useLayoutStore((s) => s.sidebarOpen);
  const width = useLayoutStore((s) => s.sidebarWidth);
  const activeView = useLayoutStore((s) => s.activeView);
  const openSettings = useLayoutStore((s) => s.openSettings);
  const closeSettings = useLayoutStore((s) => s.closeSettings);

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
  const newChat = useChatStore((s) => s.newChat);
  const switchChat = useChatStore((s) => s.switchChat);
  const deleteChat = useChatStore((s) => s.deleteChat);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);

  const handleNewAgent = useCallback(() => {
    setDropdownOpen((prev) => !prev);
  }, []);

  const handleProjectSelect = useCallback(
    (projectPath: string, projectName: string) => {
      setDropdownOpen(false);
      createAgent(projectPath, projectName).catch(console.error);
    },
    [createAgent],
  );

  const handleActivateAgent = useCallback(
    (agentId: string) => {
      setDropdownOpen(false);
      if (activeView === "settings") closeSettings();
      setActiveAgent(agentId).catch(console.error);
    },
    [activeView, closeSettings, setActiveAgent],
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
    },
    [activeView, closeSettings, switchChat],
  );

  const handleDeleteChat = useCallback(
    (id: string) => {
      deleteChat(id).catch(console.error);
    },
    [deleteChat],
  );

  const handleSettingsClick = useCallback(() => {
    setDropdownOpen(false);
    if (activeView === "settings") {
      closeSettings();
    } else {
      openSettings();
    }
  }, [activeView, closeSettings, openSettings]);

  const handleFilesClick = useCallback(() => {
    setDropdownOpen(false);
    setFilesOpen((prev) => !prev);
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
                  lockedChatIds={activeAgentId ? getLockedChatIds(activeAgentId) : []}
                  onActivate={handleActivateAgent}
                  onClose={handleCloseAgent}
                  onNewChat={handleNewChat}
                  onSelectChat={handleSelectChat}
                  onDeleteChat={handleDeleteChat}
                />
              </div>
            ))}
          </div>

          {/* Functional tabs */}
          <button className="sidebar-tab sidebar-tab--disabled" disabled>
            <Brain size={16} />
            <span>Memory</span>
          </button>
          <button className="sidebar-tab sidebar-tab--disabled" disabled>
            <Sparkles size={16} />
            <span>Skills</span>
          </button>
          <button className="sidebar-tab sidebar-tab--disabled" disabled>
            <Cable size={16} />
            <span>MCP</span>
          </button>
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

          {/* Settings — always pinned to bottom */}
          <div className="sidebar-bottom">
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
