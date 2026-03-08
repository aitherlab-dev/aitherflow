import { memo, useCallback, useState } from "react";
import {
  ChevronRight,
  Plus,
  X,
  FolderPlus,
} from "lucide-react";
import { openDialog } from "../../lib/transport";
import { useProjectStore } from "../../stores/projectStore";
import type { ProjectBookmark } from "../../types/projects";

/** Shorten an absolute path for display: remove /home/<user>/ prefix */
function shortenPath(fullPath: string): string {
  const home = fullPath.match(/^\/home\/[^/]+\//)?.[0];
  if (home) return fullPath.slice(home.length);
  return fullPath;
}

const ProjectItem = memo(function ProjectItem({
  project,
  isFirst,
}: {
  project: ProjectBookmark;
  isFirst: boolean;
}) {
  const renameProject = useProjectStore((s) => s.renameProject);
  const removeProject = useProjectStore((s) => s.removeProject);
  const addDirectory = useProjectStore((s) => s.addDirectory);
  const removeDirectory = useProjectStore((s) => s.removeDirectory);

  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(project.name);

  const dirs = project.additionalDirs ?? [];

  const handleToggle = useCallback(() => setExpanded((v) => !v), []);

  const handleDoubleClick = useCallback(() => {
    setEditName(project.name);
    setEditing(true);
  }, [project.name]);

  const handleRenameConfirm = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== project.name) {
      renameProject(project.path, trimmed).catch(console.error);
    }
    setEditing(false);
  }, [editName, project.name, project.path, renameProject]);

  const handleRenameKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Enter") handleRenameConfirm();
      if (e.code === "Escape") setEditing(false);
    },
    [handleRenameConfirm],
  );

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      removeProject(project.path).catch(console.error);
    },
    [project.path, removeProject],
  );

  const handleAddDir = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected) {
      await addDirectory(project.path, selected as string);
    }
  }, [project.path, addDirectory]);

  const handleRemoveDir = useCallback(
    (dir: string) => {
      removeDirectory(project.path, dir).catch(console.error);
    },
    [project.path, removeDirectory],
  );

  return (
    <div className="project-item">
      <div className="project-item-header" onClick={handleToggle}>
        <ChevronRight
          size={14}
          className={`project-item-chevron ${expanded ? "project-item-chevron--open" : ""}`}
        />
        {editing ? (
          <input
            className="project-item-name-input"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRenameConfirm}
            onKeyDown={handleRenameKey}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="project-item-name"
            onDoubleClick={handleDoubleClick}
          >
            {project.name}
          </span>
        )}
        <span className="project-item-path">{shortenPath(project.path)}</span>
        {dirs.length > 0 && (
          <span className="project-item-badge">
            +{dirs.length} dir{dirs.length > 1 ? "s" : ""}
          </span>
        )}
        {!isFirst && (
          <button
            className="project-item-remove"
            onClick={handleRemove}
            title="Remove project"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="project-item-body">
          <div className="project-dirs-label">Additional directories</div>
          {dirs.map((dir) => (
            <div key={dir} className="project-dir">
              <span className="project-dir-path">{dir}</span>
              <button
                className="project-dir-remove"
                onClick={() => handleRemoveDir(dir)}
                title="Remove directory"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button className="project-add-dir" onClick={handleAddDir}>
            <FolderPlus size={14} />
            <span>Add directory</span>
          </button>
        </div>
      )}
    </div>
  );
});

export function ProjectsSection() {
  const projects = useProjectStore((s) => s.projects);
  const addProject = useProjectStore((s) => s.addProject);

  const handleAdd = useCallback(async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (selected) {
        const path = selected as string;
        const name = path.split("/").pop() ?? path;
        await addProject(path, name);
      }
    } catch (e) {
      console.error("Add project dialog failed:", e);
    }
  }, [addProject]);

  return (
    <div className="projects-section">
      <div className="projects-section-header">
        <h3 className="projects-section-title">Projects</h3>
        <button className="projects-add-btn" onClick={handleAdd}>
          <Plus size={14} />
          <span>Add</span>
        </button>
      </div>
      <div className="projects-list">
        {projects.map((project, idx) => (
          <ProjectItem key={project.path} project={project} isFirst={idx === 0} />
        ))}
      </div>
    </div>
  );
}
