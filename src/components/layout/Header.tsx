import { memo, useCallback, useState } from "react";
import {
  PanelLeftClose,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  PanelBottom,
  PanelBottomClose,
  MessagesSquare,
  Sun,
  Moon,
} from "lucide-react";
import { useLayoutStore } from "../../stores/layoutStore";
import { useHotkeyStore, bindingToString, type HotkeyAction } from "../../stores/hotkeyStore";
import { useShallow } from "zustand/react/shallow";
import { Tooltip } from "../shared/Tooltip";
import { BuildButton, DevButton } from "./DevToolsBar";

function hk(action: HotkeyAction): string {
  const b = useHotkeyStore.getState().bindings[action];
  return b ? ` (${bindingToString(b)})` : "";
}

export const Header = memo(function Header() {
  const {
    sidebarOpen, toggleSidebar,
    fileViewerVisible, fileViewerPosition,
    toggleFileViewer, setFileViewerPosition,
    teamMailboxVisible, toggleTeamMailbox,
  } = useLayoutStore(useShallow((s) => ({
    sidebarOpen: s.sidebarOpen,
    toggleSidebar: s.toggleSidebar,
    fileViewerVisible: s.fileViewerVisible,
    fileViewerPosition: s.fileViewerPosition,
    toggleFileViewer: s.toggleFileViewer,
    setFileViewerPosition: s.setFileViewerPosition,
    teamMailboxVisible: s.teamMailboxVisible,
    toggleTeamMailbox: s.toggleTeamMailbox,
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

  const PanelVisibilityIcon =
    fileViewerPosition === "right"
      ? fileViewerVisible
        ? PanelRightClose
        : PanelRight
      : fileViewerVisible
        ? PanelBottomClose
        : PanelBottom;

  const PanelOrientationIcon =
    fileViewerPosition === "right" ? PanelBottom : PanelRight;

  return (
    <header className="app-header" data-tauri-drag-region>
      <div className="header-left">
        <BuildButton />
        <DevButton />
      </div>

      <div className="header-separator" />

      <div className="header-controls">
        <Tooltip text={(sidebarOpen ? "Hide sidebar" : "Show sidebar") + hk("toggleSidebar")}>
          <button
            className="header-btn"
            onClick={toggleSidebar}
            aria-label="Toggle sidebar"
          >
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
          </button>
        </Tooltip>
        <Tooltip text={(fileViewerVisible ? "Hide file viewer" : "Show file viewer") + hk("toggleFileViewer")}>
          <button
            className={`header-btn ${fileViewerVisible ? "header-btn--active" : ""}`}
            onClick={toggleFileViewer}
            aria-label="Toggle file viewer"
          >
            <PanelVisibilityIcon size={16} />
          </button>
        </Tooltip>
        <Tooltip text={(fileViewerPosition === "right" ? "Move panel to bottom" : "Move panel to right") + hk("toggleFileViewerLayout")}>
          <button
            className="header-btn"
            onClick={handleTogglePosition}
            aria-label="Toggle panel position"
          >
            <PanelOrientationIcon size={16} />
          </button>
        </Tooltip>
        <Tooltip text={teamMailboxVisible ? "Hide team mailbox" : "Show team mailbox"}>
          <button
            className={`header-btn ${teamMailboxVisible ? "header-btn--active" : ""}`}
            onClick={toggleTeamMailbox}
            aria-label="Toggle team mailbox"
          >
            <MessagesSquare size={16} />
          </button>
        </Tooltip>
      </div>

      <div className="header-spacer" />

      <Tooltip text={isDark ? "Switch to light theme" : "Switch to dark theme"}>
        <button
          className="header-btn"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </Tooltip>
    </header>
  );
});
