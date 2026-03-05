import { memo } from "react";
import { useProjectStore } from "../../../stores/projectStore";

export const ProjectDropdown = memo(function ProjectDropdown({
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
