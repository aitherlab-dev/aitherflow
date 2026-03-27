/**
 * Side-effect module: registers a listener for scheduler:create-agent events.
 * Import this file to activate the listener (same pattern as chatStreamHandler).
 */
import { listen } from "../lib/transport";
import { useAgentStore } from "./agentStore";
import { agentStates } from "./chatStore";
import type { AgentEntry } from "../types/agents";

interface SchedulerAgentEvent {
  agentId: string;
  projectPath: string;
  taskName: string;
}

if (!(globalThis as Record<string, unknown>).__schedulerListenerRegistered) {
  (globalThis as Record<string, unknown>).__schedulerListenerRegistered = true;

  listen<SchedulerAgentEvent>("scheduler:create-agent", async (event) => {
    const { agentId, projectPath, taskName } = event.payload;

    const store = useAgentStore.getState();
    // Don't create duplicate
    if (store.agents.some((a) => a.id === agentId)) return;

    const entry: AgentEntry = {
      id: agentId,
      projectPath,
      projectName: `\u23F0 ${taskName}`,
      createdAt: Date.now(),
      order: store.agents.length,
    };

    // Add agent tab without switching away from current agent
    const updated = [...store.agents, entry];
    useAgentStore.setState({ agents: updated });

    // Create agentStates entry so CLI events are not ignored
    agentStates.set(agentId, {
      messages: [],
      streamingMessage: null,
      chatId: null,
      hasSession: true,
      isThinking: true,
      planMode: false,
      currentToolActivity: null,
      toolCount: 0,
      error: null,
    });
  }).catch(console.error);
}

export {};
