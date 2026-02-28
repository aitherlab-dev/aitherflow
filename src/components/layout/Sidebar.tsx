import { memo } from "react";
import {
  FolderOpen,
  FileText,
  Zap,
  Server,
  Brain,
  Settings,
} from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { useAgentStore } from "../../stores/agentStore";
import { ResizeHandle } from "./ResizeHandle";
import { AgentCard } from "../sidebar/AgentCard";

export const Sidebar = memo(function Sidebar() {
  const open = useLayoutStore((s) => s.sidebarOpen);
  const width = useLayoutStore((s) => s.sidebarWidth);
  const agents = useAgentStore((s) => s.agents);

  return (
    <aside
      className="app-sidebar"
      style={{ width: open ? width : 0 }}
    >
      {open && (
        <>
          <div className="sidebar-content">
            {/* Open Project button (stub) */}
            <button className="sidebar-open-project">
              <FolderOpen size={14} />
              <span>Open Project</span>
            </button>

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
