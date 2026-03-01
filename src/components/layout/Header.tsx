import { memo, useCallback, useState } from "react";
import { PanelLeftClose, PanelLeft, Sun, Moon } from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";

export const Header = memo(function Header() {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const [isDark, setIsDark] = useState(
    () => !document.documentElement.hasAttribute("data-theme"),
  );

  const toggleTheme = useCallback(() => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.add("theme-transition");
    if (next) {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", "light");
    }
    setTimeout(() => {
      document.documentElement.classList.remove("theme-transition");
    }, 400);
  }, [isDark]);

  return (
    <header className="app-header" data-tauri-drag-region>
      <div className="header-left">
        <div className="brand-name">
          <span className="brand-aither">aither</span>
          <span className="brand-flow">flow</span>
        </div>
      </div>
      <div className="header-right">
        <button
          className="header-btn"
          onClick={toggleTheme}
          title={isDark ? "Switch to light theme" : "Switch to dark theme"}
          aria-label="Toggle theme"
        >
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
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
