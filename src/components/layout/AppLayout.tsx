import { useEffect, useCallback } from "react";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { ChatView } from "../chat/ChatView";
import { useLayoutStore } from "../../stores/layoutStore";
import { useChatStore } from "../../stores/chatStore";
import { useAgentStore } from "../../stores/agentStore";

export function AppLayout() {
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const activeChatId = useChatStore((s) => s.activeChatId);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.altKey && e.code === "KeyB") {
        e.preventDefault();
        toggleSidebar();
      }
      if (e.altKey && e.code === "KeyN") {
        e.preventDefault();
        const agentId = useAgentStore.getState().activeAgentId;
        if (agentId) {
          useAgentStore.getState().createChat(agentId);
        }
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
        <ChatView key={activeChatId ?? "empty"} />
      </main>
      <StatusBar />
    </div>
  );
}
