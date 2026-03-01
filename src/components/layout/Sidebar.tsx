import { memo, useState, useCallback } from "react";
import {
  FolderOpen,
  FileText,
  Zap,
  Server,
  Brain,
  Settings,
  ChevronDown,
} from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { useAgentStore } from "../../stores/agentStore";
import { ResizeHandle } from "./ResizeHandle";
import { AgentCard } from "../sidebar/AgentCard";
import { ProjectDropdown } from "../sidebar/ProjectDropdown";

export const Sidebar = memo(function Sidebar() {
  const open = useLayoutStore((s) => s.sidebarOpen);
  const width = useLayoutStore((s) => s.sidebarWidth);
  const agents = useAgentStore((s) => s.agents);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const toggleDropdown = useCallback(() => setDropdownOpen((v) => !v), []);
  const closeDropdown = useCallback(() => setDropdownOpen(false), []);

  return (
    <aside
      className="app-sidebar"
      style={{ width: open ? width : 0 }}
    >
      {open && (
        <>
          <div className="sidebar-content">
            {/* Open Project button + dropdown */}
            <div className="project-dropdown-wrapper">
              <button className="sidebar-open-project" onClick={toggleDropdown}>
                <FolderOpen size={14} />
                <span>Open Project</span>
                <ChevronDown
                  size={12}
                  className={`sidebar-open-project-chevron ${dropdownOpen ? "open" : ""}`}
                />
              </button>
              <ProjectDropdown open={dropdownOpen} onClose={closeDropdown} />
            </div>

            {/* Agents section */}
            <div className="sidebar-section">
              {agents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
            </div>

            {/* Stub sections */}
            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <FileText size={14} />
                <span>Project Files</span>
              </div>
            </div>
            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <Zap size={14} />
                <span>Skills</span>
              </div>
            </div>
            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <Server size={14} />
                <span>MCP</span>
              </div>
            </div>
            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <Brain size={14} />
                <span>Memory</span>
              </div>
            </div>

            {/* Spacer pushes footer down */}
            <div className="sidebar-spacer" />

            {/* Footer */}
            <div className="sidebar-footer">
              <button className="sidebar-footer-settings">
                <Settings size={14} />
                <span>Settings</span>
              </button>
              <div className="sidebar-footer-brand">
                <span className="brand-name">
                  <span className="brand-aither">aither</span>
                  <span className="brand-flow">flow</span>
                </span>
              </div>
            </div>
          </div>
          <ResizeHandle />
        </>
      )}
    </aside>
  );
});
