import { useEffect, useCallback } from "react";
import { useTelegramBridge } from "../../hooks/useTelegramBridge";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { ChatView } from "../chat/ChatView";
import { SettingsView } from "../settings/SettingsView";
import { WelcomeScreen } from "./WelcomeScreen";
import { AgentLog } from "../chat/AgentLog";
import { FileViewerPanel } from "../fileviewer/FileViewerPanel";
import { FileViewerResizeHandle } from "../fileviewer/FileViewerResizeHandle";
import { useLayoutStore } from "../../stores/layoutStore";
import { DevToolsBar } from "./DevToolsBar";
import { BrandFooter } from "./BrandFooter";

export function AppLayout() {
  useTelegramBridge();
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const activeView = useLayoutStore((s) => s.activeView);
  const agentLogOpen = useLayoutStore((s) => s.agentLogOpen);
  const fileViewerVisible = useLayoutStore((s) => s.fileViewerVisible);
  const fileViewerHasContent = useLayoutStore((s) => s.fileViewerHasContent);
  const fileViewerPosition = useLayoutStore((s) => s.fileViewerPosition);
  const fileViewerSize = useLayoutStore((s) => s.fileViewerSize);

  const showPanel = fileViewerVisible && fileViewerHasContent;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.altKey && e.code === "KeyB") {
        e.preventDefault();
        toggleSidebar();
      }
    },
    [toggleSidebar],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const panelStyle =
    fileViewerPosition === "right"
      ? { width: fileViewerSize, minWidth: 250 }
      : { height: fileViewerSize, minHeight: 150 };

  const renderMain = () => {
    if (activeView === "welcome") {
      return <WelcomeScreen />;
    }
    if (activeView === "settings") {
      return <SettingsView />;
    }
    return (
      <>
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
        {agentLogOpen && <AgentLog />}
      </>
    );
  };

  return (
    <div className="app-layout">
      <DevToolsBar />
      <Header />
      <Sidebar />
      <main className="app-main">
        {renderMain()}
      </main>
      <BrandFooter />
      <StatusBar />
    </div>
  );
}
