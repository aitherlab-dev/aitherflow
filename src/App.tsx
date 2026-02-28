import { useEffect } from "react";
import { AppLayout } from "./components/layout/AppLayout";
import { useAgentStore } from "./stores/agentStore";

export function App() {
  const init = useAgentStore((s) => s.init);

  useEffect(() => {
    init().catch(console.error);
  }, [init]);

  return <AppLayout />;
}
