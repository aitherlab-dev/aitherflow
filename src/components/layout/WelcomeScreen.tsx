import { useState, useCallback, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  FolderOpen,
  FolderPlus,
  Plus,
  X,
  Sparkles,
  User,
  Users,
  UserPlus,
} from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { useAgentStore, launchTeam } from "../../stores/agentStore";
import { switchChat } from "../../stores/chatService";
import { useLayoutStore } from "../../stores/layoutStore";
import { useSkillStore } from "../../stores/skillStore";
import { invoke, openDialog } from "../../lib/transport";
import type { TeamPreset } from "../../types/projects";
import { PresetManagerModal } from "./PresetManagerModal";

/** Drag-scroll for a horizontal row via mousedown + document mousemove/mouseup.
 *  Uses a callback ref so listeners attach even when the element mounts later
 *  (e.g. conditionally rendered Team section). */
function useDragScroll() {
  const dragState = useRef({ active: false, startX: 0, scrollLeft: 0, moved: false });
  const cleanupRef = useRef<(() => void) | null>(null);

  const ref = useCallback((el: HTMLDivElement | null) => {
    // Detach previous listeners
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!el) return;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragState.current = { active: true, startX: e.clientX, scrollLeft: el.scrollLeft, moved: false };
      el.classList.add("welcome-row--dragging");
      e.preventDefault(); // prevent text selection
    };

    const onMouseMove = (e: MouseEvent) => {
      const ds = dragState.current;
      if (!ds.active) return;
      const dx = e.clientX - ds.startX;
      if (Math.abs(dx) > 3) ds.moved = true;
      el.scrollLeft = ds.scrollLeft - dx;
    };

    const onMouseUp = () => {
      dragState.current.active = false;
      el.classList.remove("welcome-row--dragging");
    };

    // Convert vertical wheel scroll to horizontal
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };

    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);

    cleanupRef.current = () => {
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("wheel", onWheel);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => () => { cleanupRef.current?.(); }, []);

  /** True if the last pointer sequence included a drag (suppress click) */
  const wasDragged = useCallback(() => dragState.current.moved, []);

  return { ref, wasDragged };
}

export function WelcomeScreen() {
  const projects = useProjectStore(useShallow((s) => s.projects));
  const addProject = useProjectStore((s) => s.addProject);
  const lastOpenedProject = useProjectStore((s) => s.lastOpenedProject);
  const lastOpenedChatId = useProjectStore((s) => s.lastOpenedChatId);
  const welcomeCards = useProjectStore(useShallow((s) => s.welcomeCards));
  const addWelcomeCard = useProjectStore((s) => s.addWelcomeCard);
  const removeWelcomeCard = useProjectStore((s) => s.removeWelcomeCard);

  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [presets, setPresets] = useState<TeamPreset[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showPresetManager, setShowPresetManager] = useState(false);
  const [focusedRow, setFocusedRow] = useState(0); // 0 = projects, 1 = team
  const [focusedIndex, setFocusedIndex] = useState(0);

  const projectsRow = useDragScroll();
  const teamRow = useDragScroll();

  const focusedCardRef = useRef<HTMLButtonElement | null>(null);

  // Workspace is always the first project
  const workspace = projects[0];

  const loadPresets = useCallback(() => {
    invoke<TeamPreset[]>("presets_list")
      .then((result) => {
        setPresets(result);
        setPresetsLoaded(true);
      })
      .catch((e) => {
        console.error("[WelcomeScreen] Failed to load presets:", e);
        setPresets([]);
        setPresetsLoaded(true);
      });
  }, []);

  // Initialize selected project
  useEffect(() => {
    if (selectedProject) return;
    if (lastOpenedProject && projects.some((p) => p.path === lastOpenedProject)) {
      setSelectedProject(lastOpenedProject);
    } else if (workspace) {
      setSelectedProject(workspace.path);
    }
  }, [selectedProject, lastOpenedProject, projects, workspace]);

  // Load presets once on mount
  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  const openProject = useCallback(
    async (projectPath: string, projectName: string, chatId?: string | null) => {
      await useAgentStore.getState().createAgent(projectPath, projectName);

      if (chatId) {
        try {
          await switchChat(chatId);
        } catch (e) {
          console.error("[WelcomeScreen] Chat restore failed:", e);
        }
      }

      const allProjects = useProjectStore.getState().projects;
      useSkillStore
        .getState()
        .load(allProjects.map((p) => ({ path: p.path, name: p.name })))
        .catch(console.error);

      useLayoutStore.getState().closeWelcome();
    },
    [],
  );

  const handleSelectProject = useCallback((path: string) => {
    if (projectsRow.wasDragged()) return;
    setSelectedProject(path);
  }, [projectsRow]);

  const handleSoloLaunch = useCallback(async () => {
    if (teamRow.wasDragged()) return;
    if (!selectedProject) return;
    const project = projects.find((p) => p.path === selectedProject);
    if (!project) return;

    const chatId =
      selectedProject === lastOpenedProject ? lastOpenedChatId : null;
    await openProject(project.path, project.name, chatId);
  }, [teamRow, selectedProject, projects, lastOpenedProject, lastOpenedChatId, openProject]);

  const handlePresetLaunch = useCallback(
    async (preset: TeamPreset) => {
      if (teamRow.wasDragged()) return;
      if (!selectedProject) return;

      try {
        await launchTeam(selectedProject, preset.roles);
        useLayoutStore.getState().closeWelcome();
      } catch (e) {
        console.error("[WelcomeScreen] Failed to launch preset:", e);
      }
    },
    [teamRow, selectedProject],
  );

  const handleDeletePreset = useCallback(
    async (presetId: string) => {
      try {
        await invoke("presets_delete", { id: presetId });
        setPresets((prev) => prev.filter((p) => p.id !== presetId));
      } catch (e) {
        console.error("[WelcomeScreen] Failed to delete preset:", e);
      }
    },
    [],
  );

  const handleNewProject = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected) {
      const path = selected as string;
      const name = path.split("/").pop() ?? path;
      await addProject(path, name);
    }
  }, [addProject]);

  const handleAddCard = useCallback(
    async (project: { path: string; name: string }) => {
      await addWelcomeCard(project.path, project.name);
      setShowPicker(false);
    },
    [addWelcomeCard],
  );

  // Escape handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        if (showPresetManager) {
          setShowPresetManager(false);
        } else if (showPicker) {
          setShowPicker(false);
        } else {
          useLayoutStore.getState().closeWelcome();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showPicker, showPresetManager]);

  // Projects available for adding (not already pinned, not workspace)
  const availableProjects = projects.filter(
    (p) =>
      p !== workspace &&
      !welcomeCards.some((c) => c.projectPath === p.path),
  );

  // Item counts for keyboard navigation
  const projectsCount = (workspace ? 1 : 0) + welcomeCards.length + (availableProjects.length > 0 ? 1 : 0);
  const teamVisible = !!(selectedProject && presetsLoaded);
  const teamCount = teamVisible ? 1 + presets.length + 1 : 0; // solo + presets + "new team"

  // Map focusedIndex in projects row to a project path (for Enter logic)
  const getProjectPathAtIndex = useCallback((index: number): string | null => {
    if (workspace && index === 0) return workspace.path;
    const cardIdx = workspace ? index - 1 : index;
    if (cardIdx >= 0 && cardIdx < welcomeCards.length) return welcomeCards[cardIdx].projectPath;
    return null; // action card "+"
  }, [workspace, welcomeCards]);

  // Initialize focused index to match selectedProject
  useEffect(() => {
    if (!selectedProject) return;
    if (workspace && selectedProject === workspace.path) {
      setFocusedIndex(0);
      return;
    }
    const cardIdx = welcomeCards.findIndex((c) => c.projectPath === selectedProject);
    if (cardIdx >= 0) {
      setFocusedIndex((workspace ? 1 : 0) + cardIdx);
    }
  }, []); // only on mount

  // Scroll focused card into view
  useEffect(() => {
    focusedCardRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusedRow, focusedIndex]);

  // Keyboard navigation
  useEffect(() => {
    if (showPicker || showPresetManager) return;

    const handleNav = (e: KeyboardEvent) => {
      const rowCount = focusedRow === 0 ? projectsCount : teamCount;

      switch (e.code) {
        case "ArrowRight": {
          e.preventDefault();
          setFocusedIndex((prev) => Math.min(prev + 1, rowCount - 1));
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          setFocusedIndex((prev) => Math.max(prev - 1, 0));
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          if (focusedRow === 0 && teamVisible) {
            setFocusedRow(1);
            setFocusedIndex((prev) => Math.min(prev, teamCount - 1));
          }
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          if (focusedRow === 1) {
            setFocusedRow(0);
            setFocusedIndex((prev) => Math.min(prev, projectsCount - 1));
          }
          break;
        }
        case "Enter": {
          e.preventDefault();
          if (focusedRow === 0) {
            // Projects row
            const path = getProjectPathAtIndex(focusedIndex);
            if (path) {
              // Project card: if already selected → launch, else → select
              if (path === selectedProject) {
                const project = projects.find((p) => p.path === path);
                if (project) {
                  const chatId = path === lastOpenedProject ? lastOpenedChatId : null;
                  openProject(project.path, project.name, chatId).catch(console.error);
                }
              } else {
                setSelectedProject(path);
              }
            } else {
              // "+" action card
              setShowPicker(true);
            }
          } else {
            // Team row
            if (focusedIndex === 0) {
              // Solo
              handleSoloLaunch().catch(console.error);
            } else if (focusedIndex <= presets.length) {
              // Preset
              handlePresetLaunch(presets[focusedIndex - 1]).catch(console.error);
            } else {
              // "New team"
              setShowPresetManager(true);
            }
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handleNav);
    return () => window.removeEventListener("keydown", handleNav);
  }, [
    showPicker, showPresetManager, focusedRow, focusedIndex,
    projectsCount, teamCount, teamVisible,
    selectedProject, projects, lastOpenedProject, lastOpenedChatId,
    openProject, getProjectPathAtIndex, presets,
    handleSoloLaunch, handlePresetLaunch,
  ]);

  const selectedProjectName =
    projects.find((p) => p.path === selectedProject)?.name ?? "";

  return (
    <div className="welcome-screen">
      {/* Header */}
      <div
        className="welcome-header welcome-stagger"
        style={{ "--i": 0 } as React.CSSProperties}
      >
        <h1 className="welcome-title">
          <span className="welcome-title-aither">aither</span>
          <span className="welcome-title-flow">flow</span>
        </h1>
      </div>

      {/* New Project — subtle */}
      <button
        className="welcome-new-project welcome-stagger"
        style={{ "--i": 1 } as React.CSSProperties}
        onClick={handleNewProject}
      >
        <FolderPlus size={14} />
        <span>New Project</span>
      </button>

      {/* ── Projects section ── */}
      <div
        className="welcome-section welcome-stagger"
        style={{ "--i": 2 } as React.CSSProperties}
      >
        <div className="welcome-section-title">Projects</div>
        <div className="welcome-row" ref={projectsRow.ref}>
          {/* Workspace — always first */}
          {workspace && (
            <button
              ref={focusedRow === 0 && focusedIndex === 0 ? focusedCardRef : undefined}
              className={`welcome-card${selectedProject === workspace.path ? " welcome-card--selected" : ""}${focusedRow === 0 && focusedIndex === 0 ? " welcome-card--focused" : ""}`}
              onClick={() => handleSelectProject(workspace.path)}
            >
              <div className="welcome-card-icon">
                <Sparkles size={18} />
              </div>
              <div className="welcome-card-name">Workspace</div>
            </button>
          )}

          {/* Pinned project cards */}
          {welcomeCards.map((card, i) => {
            const cardIndex = (workspace ? 1 : 0) + i;
            const isFocused = focusedRow === 0 && focusedIndex === cardIndex;
            return (
            <button
              key={card.projectPath}
              ref={isFocused ? focusedCardRef : undefined}
              className={`welcome-card${selectedProject === card.projectPath ? " welcome-card--selected" : ""}${isFocused ? " welcome-card--focused" : ""}`}
              onClick={() => handleSelectProject(card.projectPath)}
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
                <X size={12} />
              </div>
              <div className="welcome-card-icon">
                <FolderOpen size={18} />
              </div>
              <div className="welcome-card-name">{card.projectName}</div>
            </button>
            );
          })}

          {/* Add project [+] */}
          {availableProjects.length > 0 && (() => {
            const addIndex = (workspace ? 1 : 0) + welcomeCards.length;
            const isFocused = focusedRow === 0 && focusedIndex === addIndex;
            return (
            <button
              ref={isFocused ? focusedCardRef : undefined}
              className={`welcome-card welcome-card--action-sm${isFocused ? " welcome-card--focused" : ""}`}
              onClick={() => { if (!projectsRow.wasDragged()) setShowPicker(true); }}
            >
              <Plus size={20} />
            </button>
            );
          })()}
        </div>
      </div>

      {/* ── Team section ── */}
      {selectedProject && presetsLoaded && (
        <div
          className="welcome-section welcome-stagger"
          style={{ "--i": 3 } as React.CSSProperties}
        >
          <div className="welcome-section-title">
            Team{selectedProjectName ? ` — ${selectedProjectName}` : ""}
          </div>
          <div className="welcome-row" ref={teamRow.ref}>
            {/* Solo card */}
            <button
              ref={focusedRow === 1 && focusedIndex === 0 ? focusedCardRef : undefined}
              className={`welcome-card welcome-card--solo${focusedRow === 1 && focusedIndex === 0 ? " welcome-card--focused" : ""}`}
              onClick={handleSoloLaunch}
            >
              <div className="welcome-card-icon">
                <User size={18} />
              </div>
              <div className="welcome-card-name">Solo</div>
            </button>

            {/* Preset cards */}
            {presets.map((preset, i) => {
              const presetIndex = 1 + i;
              const isFocused = focusedRow === 1 && focusedIndex === presetIndex;
              return (
              <button
                key={preset.id}
                ref={isFocused ? focusedCardRef : undefined}
                className={`welcome-card${isFocused ? " welcome-card--focused" : ""}`}
                onClick={() => handlePresetLaunch(preset)}
              >
                {!preset.is_builtin && (
                  <div
                    role="button"
                    tabIndex={0}
                    className="welcome-card-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeletePreset(preset.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.code === "Enter" || e.code === "Space") {
                        e.stopPropagation();
                        handleDeletePreset(preset.id);
                      }
                    }}
                  >
                    <X size={12} />
                  </div>
                )}
                <span className="welcome-card-badge">
                  {preset.roles.length}
                </span>
                <div className="welcome-card-icon">
                  <Users size={18} />
                </div>
                <div className="welcome-card-name">{preset.name}</div>
                <div className="welcome-card-desc">
                  {preset.roles.join(", ")}
                </div>
              </button>
              );
            })}

            {/* New team */}
            {(() => {
              const newTeamIndex = 1 + presets.length;
              const isFocused = focusedRow === 1 && focusedIndex === newTeamIndex;
              return (
              <button
                ref={isFocused ? focusedCardRef : undefined}
                className={`welcome-card welcome-card--action${isFocused ? " welcome-card--focused" : ""}`}
                onClick={() => { if (!teamRow.wasDragged()) setShowPresetManager(true); }}
              >
                <UserPlus size={20} />
                <div className="welcome-card-name">New team</div>
              </button>
              );
            })()}
          </div>
        </div>
      )}

      {/* Project picker popup */}
      {showPicker && (
        <div
          className="welcome-picker-overlay"
          onClick={() => setShowPicker(false)}
        >
          <div
            className="welcome-picker"
            onClick={(e) => e.stopPropagation()}
          >
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

      {/* Preset manager modal */}
      {showPresetManager && (
        <PresetManagerModal
          projectPath={selectedProject ?? ""}
          onClose={() => {
            setShowPresetManager(false);
            loadPresets();
          }}
        />
      )}
    </div>
  );
}
