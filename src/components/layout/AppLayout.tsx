import { useEffect, useCallback } from "react";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { ChatView } from "../chat/ChatView";
import { SettingsView } from "../settings/SettingsView";
import { useLayoutStore } from "../../stores/layoutStore";

export function AppLayout() {
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const activeView = useLayoutStore((s) => s.activeView);

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

  return (
    <div className="app-layout">
      <Header />
      <Sidebar />
      <main className="app-main">
        {activeView === "settings" ? <SettingsView /> : <ChatView />}
      </main>
      <StatusBar />
    </div>
  );
}
