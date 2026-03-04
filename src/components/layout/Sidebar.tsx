import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Loader, Plus, Trash2, Settings, X, Sparkles, Cable, FolderOpen, Pin, Pencil } from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore, type ChatMeta } from "../../stores/chatStore";
import { useAgentStore } from "../../stores/agentStore";
import { useProjectStore } from "../../stores/projectStore";
import { ResizeHandle } from "./ResizeHandle";
import { FilesPanel } from "./FilesPanel";
import { SkillsPanel } from "./SkillsPanel";

// ── Chat context menu (portal) ──

interface ChatContextMenuProps {
  x: number;
  y: number;
  chat: ChatMeta;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const ChatContextMenu = memo(function ChatContextMenu({
  x,
  y,
  chat,
  onRename,
  onTogglePin,
  onDelete,
  onClose,
}: ChatContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width > vw) nx = vw - rect.width - 4;
    if (ny + rect.height > vh) ny = vh - rect.height - 4;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") onClose();
    };
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return createPortal(
    <div ref={ref} className="chat-context-menu" style={{ left: pos.x, top: pos.y }}>
      <button type="button" className="chat-context-menu__item" onClick={onRename}>
        <Pencil size={14} />
        <span>Rename</span>
      </button>
      <button type="button" className="chat-context-menu__item" onClick={onTogglePin}>
        <Pin size={14} />
        <span>{chat.pinned ? "Unpin" : "Pin to top"}</span>
      </button>
      <div className="chat-context-menu__sep" />
      <button type="button" className="chat-context-menu__item chat-context-menu__item--danger" onClick={onDelete}>
        <Trash2 size={14} />
        <span>Delete</span>
      </button>
    </div>,
    document.body,
  );
});

// ── Chat item (single chat in the list) ──

const ChatItem = memo(function ChatItem({
  chat,
  isCurrent,
  disabled,
  locked,
  isEditing,
  onSelect,
  onDelete,
  onContextMenu,
  onRenameSubmit,
  onRenameCancel,
}: {
  chat: ChatMeta;
  isCurrent: boolean;
  disabled: boolean;
  locked: boolean;
  isEditing: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, chatId: string) => void;
  onRenameSubmit: (id: string, newTitle: string) => void;
  onRenameCancel: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!disabled && !locked) onContextMenu(e, chat.id);
    },
    [chat.id, disabled, locked, onContextMenu],
  );

  // Inline rename
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.code === "Enter") {
        onRenameSubmit(chat.id, (e.target as HTMLInputElement).value);
      } else if (e.code === "Escape") {
        onRenameCancel();
      }
    },
    [chat.id, onRenameSubmit, onRenameCancel],
  );

  const handleRenameBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      onRenameSubmit(chat.id, e.target.value);
    },
    [chat.id, onRenameSubmit],
  );

  const displayTitle = chat.customTitle || chat.title;

  return (
    <div
      className={`chat-item ${isCurrent ? "chat-item--active" : ""} ${disabled ? "chat-item--disabled" : ""} ${locked ? "chat-item--locked" : ""} ${removing ? "chat-item--removing" : ""} ${chat.pinned ? "chat-item--pinned" : ""}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {chat.pinned && <Pin size={10} className="chat-item__pin" />}
      {isEditing ? (
        <input
          ref={inputRef}
          className="chat-item__rename-input"
          defaultValue={displayTitle}
          onKeyDown={handleRenameKeyDown}
          onBlur={handleRenameBlur}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="chat-item__title">{displayTitle}</span>
      )}
      {!disabled && !locked && !isEditing && (
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
  isBackgroundThinking,
  lockedChatIds,
  onActivate,
  onClose,
  onNewChat,
  onSelectChat,
  onDeleteChat,
  onRenameChat,
  onToggleChatPin,
}: {
  agentId: string;
  projectName: string;
  isActive: boolean;
  isOnly: boolean;
  chatList: ChatMeta[];
  currentChatId: string | null;
  isThinking: boolean;
  isBackgroundThinking: boolean;
  lockedChatIds: string[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, newTitle: string) => void;
  onToggleChatPin: (id: string, pinned: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ chatId: string; x: number; y: number } | null>(null);

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

  const handleChatContextMenu = useCallback((e: React.MouseEvent, chatId: string) => {
    setContextMenu({ chatId, x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleContextRename = useCallback(() => {
    if (contextMenu) {
      setEditingChatId(contextMenu.chatId);
      setContextMenu(null);
    }
  }, [contextMenu]);

  const handleContextPin = useCallback(() => {
    if (contextMenu) {
      const chat = chatList.find((c) => c.id === contextMenu.chatId);
      if (chat) onToggleChatPin(chat.id, !chat.pinned);
      setContextMenu(null);
    }
  }, [contextMenu, chatList, onToggleChatPin]);

  const handleContextDelete = useCallback(() => {
    if (contextMenu) {
      onDeleteChat(contextMenu.chatId);
      setContextMenu(null);
    }
  }, [contextMenu, onDeleteChat]);

  const handleRenameSubmit = useCallback(
    (id: string, newTitle: string) => {
      setEditingChatId(null);
      onRenameChat(id, newTitle);
    },
    [onRenameChat],
  );

  const handleRenameCancel = useCallback(() => setEditingChatId(null), []);

  const contextChat = contextMenu ? chatList.find((c) => c.id === contextMenu.chatId) : null;

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
          {isBackgroundThinking && !isActive && (
            <Loader size={14} className="sidebar-project__bg-spinner" />
          )}
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
                isEditing={editingChatId === chat.id}
                onSelect={(id: string) => { onSelectChat(id); setExpanded(false); }}
                onDelete={onDeleteChat}
                onContextMenu={handleChatContextMenu}
                onRenameSubmit={handleRenameSubmit}
                onRenameCancel={handleRenameCancel}
              />
            ))}
          </div>
        </div>
      )}

      {contextMenu && contextChat && (
        <ChatContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          chat={contextChat}
          onRename={handleContextRename}
          onTogglePin={handleContextPin}
          onDelete={handleContextDelete}
          onClose={closeContextMenu}
        />
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
  const thinkingAgentIds = useChatStore((s) => s.thinkingAgentIds);
  const newChat = useChatStore((s) => s.newChat);
  const switchChat = useChatStore((s) => s.switchChat);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const renameChat = useChatStore((s) => s.renameChat);
  const toggleChatPin = useChatStore((s) => s.toggleChatPin);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);

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
  }, [activeView, closeSettings, openSettings]);

  const handleFilesClick = useCallback(() => {
    setDropdownOpen(false);
    setFilesOpen((prev) => !prev);
    if (!filesOpen) setSkillsOpen(false);
  }, [filesOpen]);

  const handleSkillsClick = useCallback(() => {
    setDropdownOpen(false);
    setSkillsOpen((prev) => !prev);
    if (!skillsOpen) setFilesOpen(false);
  }, [skillsOpen]);

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
            className={`sidebar-tab ${skillsOpen ? "sidebar-tab--active" : ""}`}
            onClick={handleSkillsClick}
          >
            <Sparkles size={16} />
            <span>Skills</span>
          </button>

          {/* Skills accordion */}
          {skillsOpen && (
            <div className="skills-accordion">
              <SkillsPanel />
            </div>
          )}
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
