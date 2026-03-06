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
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;

      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // F-keys work without modifiers anywhere (non-typeable)
      const isFKey = /^F\d{1,2}$/.test(e.code);
      if (isInput && !e.altKey && !e.ctrlKey && !isFKey) return;

      const action = useHotkeyStore.getState().findAction(e);
      if (!action) return;

      e.preventDefault();
      dispatch(action);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      // Push-to-talk: release voice hotkey → stop recording (only in PTT mode)
      const store = useHotkeyStore.getState();
      if (!store.voicePushToTalk) return;
      if (!store.matches("toggleVoice", e)) return;
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("hotkey:voiceStop"));
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
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

    case "toggleVoice": {
      const ptt = useHotkeyStore.getState().voicePushToTalk;
      if (ptt) {
        // Push-to-talk: keydown starts, keyup stops (see onKeyUp above)
        window.dispatchEvent(new CustomEvent("hotkey:voiceStart"));
      } else {
        // Toggle mode: press to start, press again to stop
        window.dispatchEvent(new CustomEvent("hotkey:toggleVoice"));
      }
      break;
    }

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
