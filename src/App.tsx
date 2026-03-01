import { useEffect } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { useChatStore } from "./stores/chatStore";

export function App() {
  const init = useChatStore((s) => s.init);

  useEffect(() => {
    init().catch(console.error);
  }, [init]);

  return <AppLayout />;
}
