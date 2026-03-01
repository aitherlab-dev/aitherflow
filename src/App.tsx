import { useEffect } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { useChatStore } from "./stores/chatStore";
import { useProjectStore } from "./stores/projectStore";

export function App() {
  const initChat = useChatStore((s) => s.init);
  const initProjects = useProjectStore((s) => s.init);

  useEffect(() => {
    initChat().catch(console.error);
    initProjects().catch(console.error);
  }, [initChat, initProjects]);

  return <AppLayout />;
}
