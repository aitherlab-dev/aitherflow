import { memo, useCallback, useState } from "react";
import {
  PanelLeftClose,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  PanelBottom,
  PanelBottomClose,
  Sun,
  Moon,
} from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { useShallow } from "zustand/react/shallow";

export const Header = memo(function Header() {
  const {
    sidebarOpen, toggleSidebar,
    fileViewerVisible, fileViewerPosition,
    toggleFileViewer, setFileViewerPosition,
  } = useLayoutStore(useShallow((s) => ({
    sidebarOpen: s.sidebarOpen,
    toggleSidebar: s.toggleSidebar,
    fileViewerVisible: s.fileViewerVisible,
    fileViewerPosition: s.fileViewerPosition,
    toggleFileViewer: s.toggleFileViewer,
    setFileViewerPosition: s.setFileViewerPosition,
  })));
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute("data-theme") !== "light",
  );

  const toggleTheme = useCallback(() => {
    const currentlyDark = document.documentElement.getAttribute("data-theme") !== "light";
    document.documentElement.classList.add("theme-transition");
    const next = currentlyDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    setIsDark(!currentlyDark);
    setTimeout(() => {
      document.documentElement.classList.remove("theme-transition");
    }, 400);
  }, []);

  const handleTogglePosition = useCallback(() => {
    setFileViewerPosition(fileViewerPosition === "right" ? "bottom" : "right");
  }, [fileViewerPosition, setFileViewerPosition]);

  // Panel visibility icon: show active state based on position
  const PanelVisibilityIcon =
    fileViewerPosition === "right"
      ? fileViewerVisible
        ? PanelRightClose
        : PanelRight
      : fileViewerVisible
        ? PanelBottomClose
        : PanelBottom;

  // Panel orientation icon
  const PanelOrientationIcon =
    fileViewerPosition === "right" ? PanelBottom : PanelRight;

  return (
    <header className="app-header" data-tauri-drag-region>
      <div className="header-right">
        <button
          className="header-btn"
          onClick={handleTogglePosition}
          title={
            fileViewerPosition === "right"
              ? "Move panel to bottom"
              : "Move panel to right"
          }
          aria-label="Toggle panel position"
        >
          <PanelOrientationIcon size={16} />
        </button>
        <button
          className={`header-btn ${fileViewerVisible ? "header-btn--active" : ""}`}
          onClick={toggleFileViewer}
          title={
            fileViewerVisible ? "Hide file viewer" : "Show file viewer"
          }
          aria-label="Toggle file viewer"
        >
          <PanelVisibilityIcon size={16} />
        </button>
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
