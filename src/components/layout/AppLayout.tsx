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
import { ChatPanel } from "./chat-panel";
import { TeamMailboxPanel } from "../teamwork/TeamMailboxPanel";
import { useLayoutStore } from "../../stores/layoutStore";
import { useShallow } from "zustand/react/shallow";
import { BrandFooter } from "./BrandFooter";

export function AppLayout() {
  useTelegramBridge();
  useHotkeys();
  const isMobile = useIsMobile();
  const {
    sidebarOpen, toggleSidebar, activeView,
    fileViewerVisible, fileViewerHasContent, fileViewerPosition, fileViewerSize,
    chatPanelVisible, teamMailboxVisible, teamMailboxWidth,
  } = useLayoutStore(useShallow((s) => ({
    sidebarOpen: s.sidebarOpen,
    toggleSidebar: s.toggleSidebar,
    activeView: s.activeView,
    fileViewerVisible: s.fileViewerVisible,
    fileViewerHasContent: s.fileViewerHasContent,
    fileViewerPosition: s.fileViewerPosition,
    fileViewerSize: s.fileViewerSize,
    chatPanelVisible: s.chatPanelVisible,
    teamMailboxVisible: s.teamMailboxVisible,
    teamMailboxWidth: s.teamMailboxWidth,
  })));

  const showPanel = fileViewerVisible && fileViewerHasContent;

  const panelStyle =
    fileViewerPosition === "right"
      ? { width: fileViewerSize, minWidth: 250 }
      : { height: fileViewerSize, minHeight: 150 };

  return (
    <div className="app-layout">
      <Header />
      <Sidebar />
      <main className="app-main">
        <div className="main-row">
          {activeView === "welcome" ? (
            <WelcomeScreen />
          ) : activeView === "settings" ? (
            <SettingsView />
          ) : (
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
          )}
          {teamMailboxVisible && (
            <div
              className="team-mailbox-wrapper"
              style={{ width: teamMailboxWidth, minWidth: 280 }}
            >
              <TeamMailboxPanel />
            </div>
          )}
        </div>
      </main>
      {chatPanelVisible && (
        <div className="chat-panel-column">
          <ChatPanel />
        </div>
      )}
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
