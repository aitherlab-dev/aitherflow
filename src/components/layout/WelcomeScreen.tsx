import { useState, useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { FolderOpen, FolderPlus, Plus, X, Sparkles, CornerDownLeft } from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { useAgentStore } from "../../stores/agentStore";
import { switchChat } from "../../stores/chatService";
import { useLayoutStore } from "../../stores/layoutStore";
import { useSkillStore } from "../../stores/skillStore";
import { openDialog } from "../../lib/transport";
import { useDragReorder } from "../../hooks/useDragReorder";

export function WelcomeScreen() {
  const projects = useProjectStore(useShallow((s) => s.projects));
  const addProject = useProjectStore((s) => s.addProject);
  const lastOpenedProject = useProjectStore((s) => s.lastOpenedProject);
  const lastOpenedChatId = useProjectStore((s) => s.lastOpenedChatId);
  const welcomeCards = useProjectStore(useShallow((s) => s.welcomeCards));
  const addWelcomeCard = useProjectStore((s) => s.addWelcomeCard);
  const removeWelcomeCard = useProjectStore((s) => s.removeWelcomeCard);
  const reorderWelcomeCards = useProjectStore((s) => s.reorderWelcomeCards);
  const closeWelcome = useLayoutStore((s) => s.closeWelcome);
  const createAgent = useAgentStore((s) => s.createAgent);
  const loadSkills = useSkillStore((s) => s.load);

  const [showPicker, setShowPicker] = useState(false);

  const handleReorder = useCallback(
    (from: number, to: number) => { reorderWelcomeCards(from, to).catch(console.error); },
    [reorderWelcomeCards],
  );
  const {
    dragId: dragIdx, dragPos, dragOffset, dropTargetId: dropTargetIdx, dragging,
    gridRef, dragElRef, handlePointerDown, handlePointerMove, handlePointerUp,
  } = useDragReorder<number>("card-idx", handleReorder);

  // Workspace is always the first project
  const workspace = projects[0];

  // Find last opened project info
  const lastProject = lastOpenedProject
    ? projects.find((p) => p.path === lastOpenedProject)
    : null;

  const openProject = useCallback(
    async (projectPath: string, projectName: string, chatId?: string | null) => {
      // Create agent for this project
      await createAgent(projectPath, projectName);

      // If we have a specific chat to restore, switch to it
      if (chatId) {
        try {
          await switchChat(chatId);
        } catch {
          // Chat may not exist anymore, that's fine — new chat will be shown
        }
      }

      // Reload skills for all projects
      const allProjects = useProjectStore.getState().projects;
      loadSkills(allProjects.map((p) => ({ path: p.path, name: p.name }))).catch(console.error);

      // Switch to chat view
      closeWelcome();
    },
    [createAgent, loadSkills, closeWelcome],
  );

  const openWorkspace = useCallback(async () => {
    if (!workspace) return;
    await openProject(workspace.path, workspace.name);
  }, [workspace, openProject]);

  // Escape: close picker or close welcome screen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        if (showPicker) {
          setShowPicker(false);
        } else {
          closeWelcome();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showPicker, closeWelcome]);

  const openLastProject = useCallback(async () => {
    if (!lastProject) return;
    await openProject(lastProject.path, lastProject.name, lastOpenedChatId);
  }, [lastProject, lastOpenedChatId, openProject]);

  const handleAddCard = useCallback(
    async (project: { path: string; name: string }) => {
      await addWelcomeCard(project.path, project.name);
      setShowPicker(false);
    },
    [addWelcomeCard],
  );

  const handleNewProject = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected) {
      const path = selected as string;
      const name = path.split("/").pop() ?? path;
      await addProject(path, name);
    }
  }, [addProject]);

  // Projects available for adding (not already pinned, not workspace)
  const availableProjects = projects.filter(
    (p) =>
      p !== workspace &&
      !welcomeCards.some((c) => c.projectPath === p.path),
  );

  return (
    <div className="welcome-screen">
      <div className="welcome-header welcome-stagger" style={{ "--i": 0 } as React.CSSProperties}>
        <h1 className="welcome-title">
          <span className="welcome-title-aither">aither</span>
          <span className="welcome-title-flow">flow</span>
        </h1>
      </div>

      <button
        className="welcome-new-project welcome-stagger"
        style={{ "--i": 1 } as React.CSSProperties}
        onClick={handleNewProject}
      >
        <FolderPlus size={16} />
        <span>New Project</span>
      </button>

      <div className="welcome-grid" ref={gridRef}>
        {/* Card 1: Workspace — new chat */}
        <button
          className="welcome-card welcome-card--fixed welcome-stagger"
          style={{ "--i": 2 } as React.CSSProperties}
          onClick={openWorkspace}
        >
          <div className="welcome-card-icon">
            <Sparkles size={20} />
          </div>
          <div className="welcome-card-name">Workspace</div>
          <div className="welcome-card-desc">New chat</div>
        </button>

        {/* Card 2: Last project + last chat */}
        {lastProject ? (
          <button
            className="welcome-card welcome-card--fixed welcome-stagger"
            style={{ "--i": 3 } as React.CSSProperties}
            onClick={openLastProject}
          >
            <div className="welcome-card-icon">
              <CornerDownLeft size={20} />
            </div>
            <div className="welcome-card-name">Return</div>
            <div className="welcome-card-desc">{lastProject.name}</div>
          </button>
        ) : (
          <div
            className="welcome-card welcome-card--empty welcome-card--disabled welcome-stagger"
            style={{ "--i": 3 } as React.CSSProperties}
          >
            <div className="welcome-card-icon">
              <FolderOpen size={20} />
            </div>
            <div className="welcome-card-name">No recent project</div>
          </div>
        )}

        {/* User-pinned cards */}
        {welcomeCards.map((card, idx) => (
          <button
            key={card.projectPath}
            data-card-idx={idx}
            className={`welcome-card welcome-stagger${dragIdx === idx && dragging ? " welcome-card--dragging" : ""}${dropTargetIdx === idx ? " welcome-card--drag-over" : ""}`}
            style={{ "--i": 4 + idx } as React.CSSProperties}
            onPointerDown={(e) => handlePointerDown(e, idx)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onClick={() => { if (!dragging) openProject(card.projectPath, card.projectName); }}
          >
            <div
              role="button"
              tabIndex={0}
              className="welcome-card-remove"
              onClick={(e) => {
                e.stopPropagation();
                removeWelcomeCard(card.projectPath);
              }}
              onKeyDown={(e) => {
                if (e.code === "Enter" || e.code === "Space") {
                  e.stopPropagation();
                  removeWelcomeCard(card.projectPath);
                }
              }}
            >
              <X size={14} />
            </div>
            <div className="welcome-card-icon">
              <FolderOpen size={20} />
            </div>
            <div className="welcome-card-name">{card.projectName}</div>
          </button>
        ))}

        {/* Add project button */}
        {availableProjects.length > 0 && (
          <button
            className="welcome-card welcome-card--add welcome-stagger"
            style={{ "--i": 4 + welcomeCards.length } as React.CSSProperties}
            onClick={() => setShowPicker(true)}
          >
            <Plus size={24} />
            <div className="welcome-card-desc">Add project</div>
          </button>
        )}
      </div>

      {/* Drag ghost */}
      {dragIdx !== null && dragging && dragElRef.current && (
        <div
          className="welcome-card-ghost"
          style={{
            left: dragPos.x - dragOffset.x,
            top: dragPos.y - dragOffset.y,
            width: dragElRef.current.offsetWidth,
            height: dragElRef.current.offsetHeight,
          }}
        >
          <div className="welcome-card-icon">
            <FolderOpen size={20} />
          </div>
          <div className="welcome-card-name">{welcomeCards[dragIdx]?.projectName}</div>
        </div>
      )}

      {/* Project picker popup */}
      {showPicker && (
        <div className="welcome-picker-overlay" onClick={() => setShowPicker(false)}>
          <div className="welcome-picker" onClick={(e) => e.stopPropagation()}>
            <div className="welcome-picker-title">Choose project</div>
            {availableProjects.map((p) => (
              <button
                key={p.path}
                className="welcome-picker-item"
                onClick={() => handleAddCard(p)}
              >
                <FolderOpen size={16} />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
