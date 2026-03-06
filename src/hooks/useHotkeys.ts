import { useEffect } from "react";
import { useHotkeyStore, type HotkeyAction } from "../stores/hotkeyStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useAgentStore } from "../stores/agentStore";
import { useChatStore } from "../stores/chatStore";

/**
 * Central hotkey handler — mount once in AppLayout.
 * Listens for keydown, matches against configured bindings, dispatches actions.
 */
export function useHotkeys() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea (except for our global hotkeys)
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // Only modifiers (Alt/Ctrl) combos work in inputs
      if (isInput && !e.altKey && !e.ctrlKey) return;

      const action = useHotkeyStore.getState().findAction(e);
      if (!action) return;

      e.preventDefault();
      dispatch(action);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

function dispatch(action: HotkeyAction) {
  const layout = useLayoutStore.getState();

  switch (action) {
    case "toggleSidebar":
      layout.toggleSidebar();
      break;

    case "toggleAgentLog":
      layout.toggleAgentLog();
      break;

    case "toggleVoice":
      // Dispatch custom event that useVoice listens to
      window.dispatchEvent(new CustomEvent("hotkey:toggleVoice"));
      break;

    case "openSettings":
      if (layout.activeView === "settings") {
        layout.closeSettings();
      } else {
        layout.openSettings();
      }
      break;

    case "focusInput":
      window.dispatchEvent(new CustomEvent("hotkey:focusInput"));
      break;

    case "newChat":
      useChatStore.getState().newChat().catch(console.error);
      break;

    default: {
      // switchAgent1..9
      const match = action.match(/^switchAgent(\d)$/);
      if (match) {
        const index = parseInt(match[1], 10) - 1;
        const agents = useAgentStore.getState().agents;
        if (index < agents.length) {
          useAgentStore.getState().setActiveAgent(agents[index].id).catch(console.error);
          // Also ensure we're on chat view
          if (layout.activeView === "settings") {
            layout.closeSettings();
          }
        }
      }
    }
  }
}
