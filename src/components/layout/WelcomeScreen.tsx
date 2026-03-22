import { useState, useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  FolderOpen,
  FolderPlus,
  Plus,
  X,
  Sparkles,
  User,
  Users,
  Settings,
} from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { useAgentStore } from "../../stores/agentStore";
import { switchChat } from "../../stores/chatService";
import { useLayoutStore } from "../../stores/layoutStore";
import { useSkillStore } from "../../stores/skillStore";
import { invoke, openDialog } from "../../lib/transport";
import type { TeamPreset } from "../../types/projects";
import { PresetManagerModal } from "./PresetManagerModal";

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
    setSelectedProject(path);
  }, []);

  const handleSoloLaunch = useCallback(async () => {
    if (!selectedProject) return;
    const project = projects.find((p) => p.path === selectedProject);
    if (!project) return;

    const chatId =
      selectedProject === lastOpenedProject ? lastOpenedChatId : null;
    await openProject(project.path, project.name, chatId);
  }, [selectedProject, projects, lastOpenedProject, lastOpenedChatId, openProject]);

  const handlePresetLaunch = useCallback(
    async (preset: TeamPreset) => {
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
    [selectedProject],
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
        <div className="welcome-row">
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
              className="welcome-card welcome-card--action"
              onClick={() => setShowPicker(true)}
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
          <div className="welcome-row">
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

            {/* Settings [⚙] */}
            <button
              className="welcome-card welcome-card--action"
              onClick={() => setShowPresetManager(true)}
            >
              <Settings size={20} />
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
