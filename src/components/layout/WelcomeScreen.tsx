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
import { useAgentStore } from "../../stores/agentStore";
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

  const projectsRow = useDragScroll();
  const teamRow = useDragScroll();

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
        await invoke("presets_launch", {
          projectPath: selectedProject,
          presetId: preset.id,
        });
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
        <div className="welcome-row" ref={projectsRow.ref} onWheel={(e) => {
          if (e.deltaY !== 0) {
            e.currentTarget.scrollLeft += e.deltaY;
            e.preventDefault();
          }
        }}>
          {/* Workspace — always first */}
          {workspace && (
            <button
              className={`welcome-card${selectedProject === workspace.path ? " welcome-card--selected" : ""}`}
              onClick={() => handleSelectProject(workspace.path)}
            >
              <div className="welcome-card-icon">
                <Sparkles size={18} />
              </div>
              <div className="welcome-card-name">Workspace</div>
            </button>
          )}

          {/* Pinned project cards */}
          {welcomeCards.map((card) => (
            <button
              key={card.projectPath}
              className={`welcome-card${selectedProject === card.projectPath ? " welcome-card--selected" : ""}`}
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
          ))}

          {/* Add project [+] */}
          {availableProjects.length > 0 && (
            <button
              className="welcome-card welcome-card--action-sm"
              onClick={() => { if (!projectsRow.wasDragged()) setShowPicker(true); }}
            >
              <Plus size={20} />
            </button>
          )}
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
          <div className="welcome-row" ref={teamRow.ref} onWheel={(e) => {
            if (e.deltaY !== 0) {
              e.currentTarget.scrollLeft += e.deltaY;
              e.preventDefault();
            }
          }}>
            {/* Solo card */}
            <button
              className="welcome-card welcome-card--solo"
              onClick={handleSoloLaunch}
            >
              <div className="welcome-card-icon">
                <User size={18} />
              </div>
              <div className="welcome-card-name">Solo</div>
            </button>

            {/* Preset cards */}
            {presets.map((preset) => (
              <button
                key={preset.id}
                className="welcome-card"
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
            ))}

            {/* New team */}
            <button
              className="welcome-card welcome-card--action"
              onClick={() => { if (!teamRow.wasDragged()) setShowPresetManager(true); }}
            >
              <UserPlus size={20} />
              <div className="welcome-card-name">New team</div>
            </button>
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
          onClose={() => {
            setShowPresetManager(false);
            loadPresets();
          }}
        />
      )}
    </div>
  );
}
