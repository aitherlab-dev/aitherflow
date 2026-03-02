import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Plus, Trash2, Settings, X } from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore, type ChatMeta } from "../../stores/chatStore";
import { useAgentStore } from "../../stores/agentStore";
import { useProjectStore } from "../../stores/projectStore";
import { ResizeHandle } from "./ResizeHandle";

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
  isFirst,
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
  isFirst: boolean;
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
        {!isFirst && (
          <button
            className="sidebar-project__close"
            onClick={handleClose}
            title="Close agent"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {expanded && isActive && (
        <div className="sidebar-project-body">
          <button
            className={`sidebar-new-chat ${isThinking ? "sidebar-new-chat--disabled" : ""}`}
            onClick={onNewChat}
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
                onSelect={onSelectChat}
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
  onClose,
}: {
  onSelect: (projectPath: string, projectName: string) => void;
  onClose: () => void;
}) {
  const projects = useProjectStore((s) => s.projects);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  return (
    <div className="project-dropdown" ref={ref}>
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

  const chatList = useChatStore((s) => s.chatList);
  const currentChatId = useChatStore((s) => s.currentChatId);
  const isThinking = useChatStore((s) => s.isThinking);
  const newChat = useChatStore((s) => s.newChat);
  const switchChat = useChatStore((s) => s.switchChat);
  const deleteChat = useChatStore((s) => s.deleteChat);

  const [dropdownOpen, setDropdownOpen] = useState(false);

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

  const handleDropdownClose = useCallback(() => {
    setDropdownOpen(false);
  }, []);

  const handleActivateAgent = useCallback(
    (agentId: string) => {
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
    if (activeView === "settings") {
      closeSettings();
    } else {
      openSettings();
    }
  }, [activeView, closeSettings, openSettings]);

  return (
    <aside
      className="app-sidebar"
      style={{ width: open ? width : 0 }}
    >
      {open && (
        <>
          {/* Top: + New Agent */}
          <div className="sidebar-top">
            <div className="sidebar-top__wrapper">
              <button className="sidebar-tab" onClick={handleNewAgent}>
                <Plus size={16} />
                <span>New Agent</span>
              </button>
              {dropdownOpen && (
                <ProjectDropdown
                  onSelect={handleProjectSelect}
                  onClose={handleDropdownClose}
                />
              )}
            </div>
          </div>

          {/* Middle: Agent list */}
          <div className="sidebar-content">
            {agents.map((agent, index) => (
              <AgentTab
                key={agent.id}
                agentId={agent.id}
                projectName={agent.projectName}
                isActive={agent.id === activeAgentId}
                isFirst={index === 0}
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
            ))}
          </div>

          {/* Bottom: Settings */}
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
