import { useMemo } from "react";
import { Menu } from "lucide-react";
import { useTelegramBridge } from "../../hooks/useTelegramBridge";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useHotkeys } from "../../hooks/useHotkeys";
import { Header } from "./Header";
import { Sidebar } from "./sidebar";
import { ChatView } from "../chat/ChatView";
import { SettingsView } from "../settings/SettingsView";
import { WelcomeScreen } from "./WelcomeScreen";
import { FileViewerPanel } from "../fileviewer/FileViewerPanel";
import { FileViewerResizeHandle } from "../fileviewer/FileViewerResizeHandle";
import { useLayoutStore } from "../../stores/layoutStore";
import { useShallow } from "zustand/react/shallow";
import { DevToolsBar } from "./DevToolsBar";
import { BrandFooter } from "./BrandFooter";

export function AppLayout() {
  useTelegramBridge();
  useHotkeys();
  const isMobile = useIsMobile();
  const {
    sidebarOpen, toggleSidebar, activeView,
    fileViewerVisible, fileViewerHasContent, fileViewerPosition, fileViewerSize,
  } = useLayoutStore(useShallow((s) => ({
    sidebarOpen: s.sidebarOpen,
    toggleSidebar: s.toggleSidebar,
    activeView: s.activeView,
    fileViewerVisible: s.fileViewerVisible,
    fileViewerHasContent: s.fileViewerHasContent,
    fileViewerPosition: s.fileViewerPosition,
    fileViewerSize: s.fileViewerSize,
  })));

  const showPanel = fileViewerVisible && fileViewerHasContent;

  const mainContent = useMemo(() => {
    if (activeView === "welcome") {
      return <WelcomeScreen />;
    }
    if (activeView === "settings") {
      return <SettingsView />;
    }
    const panelStyle =
      fileViewerPosition === "right"
        ? { width: fileViewerSize, minWidth: 250 }
        : { height: fileViewerSize, minHeight: 150 };
    return (
      <div className={`main-split main-split--${fileViewerPosition}`}>
        <ChatView />
        {showPanel && (
          <>
            <FileViewerResizeHandle />
            <div className="file-viewer-wrapper" style={panelStyle}>
              <FileViewerPanel />
            </div>
          </>
        )}
      </div>
    );
  }, [activeView, fileViewerPosition, fileViewerSize, showPanel]);

  return (
    <div className="app-layout">
      <DevToolsBar />
      <Header />
      <Sidebar />
      <main className="app-main">
        {mainContent}
      </main>
      <BrandFooter />

      {/* Mobile: backdrop when sidebar is open */}
      {isMobile && sidebarOpen && (
        <div className="mobile-sidebar-backdrop" onClick={toggleSidebar} />
      )}

      {/* Mobile: burger button to open sidebar */}
      {isMobile && !sidebarOpen && (
        <button className="mobile-burger" onClick={toggleSidebar} aria-label="Open menu">
          <Menu size={22} />
        </button>
      )}
    </div>
  );
}
