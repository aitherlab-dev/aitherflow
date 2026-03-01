import { useRef, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderPlus, FolderOpen } from "lucide-react";
import { useAgentStore } from "../../stores/agentStore";
import { useShallow } from "zustand/react/shallow";

interface ProjectDropdownProps {
  open: boolean;
  onClose: () => void;
}

export function ProjectDropdown({ open: isOpen, onClose }: ProjectDropdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  const bookmarks = useAgentStore(useShallow((s) => s.bookmarks));
  const agents = useAgentStore(useShallow((s) => s.agents));
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const addProject = useAgentStore((s) => s.addProject);
  const openProject = useAgentStore((s) => s.openProject);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [isOpen, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [isOpen, onClose]);

  const handleNewProject = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        await addProject(selected);
        onClose();
      }
    } catch (e) {
      console.error("[ProjectDropdown] folder dialog error:", e);
    }
  }, [addProject, onClose]);

  const handleSelectProject = useCallback((bookmarkId: string) => {
    openProject(bookmarkId);
    onClose();
  }, [openProject, onClose]);

  if (!isOpen) return null;

  // Workspace first, then the rest
  const workspace = bookmarks.find((b) => b.id === "workspace");
  const projects = bookmarks.filter((b) => b.id !== "workspace");

  // Set of currently open agent IDs (to show which are active)
  const openAgentIds = new Set(agents.map((a) => a.id));

  return (
    <div className="project-dropdown" ref={ref}>
      <button
        className="project-dropdown-new"
        onClick={handleNewProject}
      >
        <FolderPlus size={14} />
        <span>New Project</span>
      </button>

      {workspace && (
        <>
          <div className="project-dropdown-divider" />
          <button
            className={`project-dropdown-item ${activeAgentId === workspace.id ? "project-dropdown-item-active" : ""}`}
            onClick={() => handleSelectProject(workspace.id)}
          >
            <FolderOpen size={14} />
            <span>{workspace.name}</span>
            <span className="project-dropdown-path">(default)</span>
          </button>
        </>
      )}

      {projects.length > 0 && <div className="project-dropdown-divider" />}
      {projects.map((bm) => (
        <button
          key={bm.id}
          className={`project-dropdown-item ${activeAgentId === bm.id ? "project-dropdown-item-active" : ""} ${!openAgentIds.has(bm.id) ? "project-dropdown-item-closed" : ""}`}
          onClick={() => handleSelectProject(bm.id)}
        >
          <FolderOpen size={14} />
          <span>{bm.name}</span>
          <span className="project-dropdown-path" title={bm.path}>
            {shortenPath(bm.path)}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Shorten a path for display: keep last 2 segments */
function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return ".../" + parts.slice(-2).join("/");
}
