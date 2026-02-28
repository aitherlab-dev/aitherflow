import { memo } from "react";
import { PanelLeftClose, PanelLeft } from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";

export const Header = memo(function Header() {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  return (
    <header className="app-header" data-tauri-drag-region>
      <div className="header-left">
        <div className="brand-name">
          <span className="brand-aither">aither</span>
          <span className="brand-flow">flow</span>
        </div>
      </div>
      <div className="header-right">
        {/* Buttons will be added in stage 4c */}
        <button
          className="header-btn"
          onClick={toggleSidebar}
          title={sidebarOpen ? "Hide sidebar (Alt+B)" : "Show sidebar (Alt+B)"}
          aria-label="Toggle sidebar"
        >
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
        </button>
      </div>
    </header>
  );
});
