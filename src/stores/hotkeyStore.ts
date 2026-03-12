import { create } from "zustand";

// ── Action IDs ──────────────────────────────────────────────────────
export type HotkeyAction =
  | "toggleSidebar"
  | "toggleAgentLog"
  | "toggleVoice"
  | "openSettings"
  | "openHome"
  | "focusInput"
  | "newChat"
  | "newAgent"
  | "restartSession"
  | "stopGeneration"
  | "toggleFileViewer"
  | "toggleFileViewerLayout"
  | "toggleChatPanel"
  | "switchAgent1"
  | "switchAgent2"
  | "switchAgent3"
  | "switchAgent4"
  | "switchAgent5"
  | "switchAgent6"
  | "switchAgent7"
  | "switchAgent8"
  | "switchAgent9";

// ── Human-readable labels ───────────────────────────────────────────
export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggleSidebar: "Toggle Sidebar",
  toggleAgentLog: "Toggle Agent Log",
  toggleVoice: "Toggle Voice Input",
  openSettings: "Open Settings",
  openHome: "Open Home",
  focusInput: "Focus Chat Input",
  newChat: "New Chat",
  newAgent: "New Agent",
  restartSession: "Restart Session",
  stopGeneration: "Stop Generation",
  toggleFileViewer: "Toggle File Viewer",
  toggleFileViewerLayout: "Toggle File Viewer Layout",
  toggleChatPanel: "Toggle Chat Panel",
  switchAgent1: "Switch to Agent 1",
  switchAgent2: "Switch to Agent 2",
  switchAgent3: "Switch to Agent 3",
  switchAgent4: "Switch to Agent 4",
  switchAgent5: "Switch to Agent 5",
  switchAgent6: "Switch to Agent 6",
  switchAgent7: "Switch to Agent 7",
  switchAgent8: "Switch to Agent 8",
  switchAgent9: "Switch to Agent 9",
};

// ── Binding: modifier flags + key code ──────────────────────────────
export interface HotkeyBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  code: string; // e.g. "KeyB", "Digit1", "Backquote"
}

/** Serialize a binding to a display string like "Alt+B" or "Ctrl+`" */
export function bindingToString(b: HotkeyBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push("Ctrl");
  if (b.alt) parts.push("Alt");
  if (b.shift) parts.push("Shift");
  parts.push(codeToLabel(b.code));
  return parts.join("+");
}

function codeToLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const map: Record<string, string> = {
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Space: "Space",
    Enter: "Enter",
    Escape: "Esc",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Tab: "Tab",
  };
  return map[code] ?? code;
}

// ── Defaults ────────────────────────────────────────────────────────
const DEFAULT_BINDINGS: Record<HotkeyAction, HotkeyBinding> = {
  toggleSidebar: { ctrl: false, alt: true, shift: false, code: "KeyB" },
  toggleAgentLog: { ctrl: false, alt: true, shift: false, code: "KeyL" },
  toggleVoice: { ctrl: false, alt: false, shift: false, code: "F1" },
  openSettings: { ctrl: false, alt: true, shift: false, code: "Comma" },
  openHome: { ctrl: false, alt: true, shift: false, code: "KeyH" },
  focusInput: { ctrl: false, alt: true, shift: false, code: "KeyI" },
  newChat: { ctrl: false, alt: true, shift: false, code: "KeyN" },
  newAgent: { ctrl: false, alt: true, shift: false, code: "KeyA" },
  restartSession: { ctrl: false, alt: true, shift: false, code: "KeyR" },
  stopGeneration: { ctrl: false, alt: false, shift: false, code: "Escape" },
  toggleFileViewer: { ctrl: false, alt: true, shift: false, code: "KeyE" },
  toggleFileViewerLayout: { ctrl: false, alt: true, shift: false, code: "KeyW" },
  toggleChatPanel: { ctrl: false, alt: true, shift: false, code: "KeyC" },
  switchAgent1: { ctrl: false, alt: true, shift: false, code: "Digit1" },
  switchAgent2: { ctrl: false, alt: true, shift: false, code: "Digit2" },
  switchAgent3: { ctrl: false, alt: true, shift: false, code: "Digit3" },
  switchAgent4: { ctrl: false, alt: true, shift: false, code: "Digit4" },
  switchAgent5: { ctrl: false, alt: true, shift: false, code: "Digit5" },
  switchAgent6: { ctrl: false, alt: true, shift: false, code: "Digit6" },
  switchAgent7: { ctrl: false, alt: true, shift: false, code: "Digit7" },
  switchAgent8: { ctrl: false, alt: true, shift: false, code: "Digit8" },
  switchAgent9: { ctrl: false, alt: true, shift: false, code: "Digit9" },
};

const STORAGE_KEY = "aitherflow:hotkeys";
const PTT_KEY = "aitherflow:voicePushToTalk";

// ── Persistence ─────────────────────────────────────────────────────
type SerializedBindings = Partial<Record<HotkeyAction, HotkeyBinding>>;

function loadBindings(): Record<HotkeyAction, HotkeyBinding> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SerializedBindings;
      return { ...DEFAULT_BINDINGS, ...parsed };
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_BINDINGS };
}

function saveBindings(bindings: Record<HotkeyAction, HotkeyBinding>) {
  // Only save non-default bindings to keep storage minimal
  const diff: SerializedBindings = {};
  for (const [action, binding] of Object.entries(bindings)) {
    const def = DEFAULT_BINDINGS[action as HotkeyAction];
    if (
      binding.ctrl !== def.ctrl ||
      binding.alt !== def.alt ||
      binding.shift !== def.shift ||
      binding.code !== def.code
    ) {
      diff[action as HotkeyAction] = binding;
    }
  }
  if (Object.keys(diff).length === 0) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(diff));
  }
}

// ── Store ───────────────────────────────────────────────────────────
interface HotkeyState {
  bindings: Record<HotkeyAction, HotkeyBinding>;

  /** Push-to-talk mode: hold key to record, release to stop. Toggle mode: press to start/stop */
  voicePushToTalk: boolean;

  /** Check if a keyboard event matches a given action */
  matches: (action: HotkeyAction, e: KeyboardEvent) => boolean;

  /** Find which action matches a keyboard event (if any) */
  findAction: (e: KeyboardEvent) => HotkeyAction | null;

  /** Update binding for an action */
  setBinding: (action: HotkeyAction, binding: HotkeyBinding) => void;

  /** Reset a single action to default */
  resetBinding: (action: HotkeyAction) => void;

  /** Reset all bindings to defaults */
  resetAll: () => void;

  /** Toggle voice hotkey mode */
  setVoicePushToTalk: (ptt: boolean) => void;
}

export const useHotkeyStore = create<HotkeyState>((set, get) => ({
  bindings: loadBindings(),
  voicePushToTalk: localStorage.getItem(PTT_KEY) !== "false",

  matches: (action, e) => {
    if (e.metaKey) return false;
    const b = get().bindings[action];
    return (
      e.ctrlKey === b.ctrl &&
      e.altKey === b.alt &&
      e.shiftKey === b.shift &&
      e.code === b.code
    );
  },

  findAction: (e) => {
    if (e.metaKey) return null;
    const { bindings } = get();
    for (const [action, b] of Object.entries(bindings)) {
      if (
        e.ctrlKey === b.ctrl &&
        e.altKey === b.alt &&
        e.shiftKey === b.shift &&
        e.code === b.code
      ) {
        return action as HotkeyAction;
      }
    }
    return null;
  },

  setBinding: (action, binding) => {
    const next = { ...get().bindings, [action]: binding };
    set({ bindings: next });
    saveBindings(next);
  },

  resetBinding: (action) => {
    const next = { ...get().bindings, [action]: DEFAULT_BINDINGS[action] };
    set({ bindings: next });
    saveBindings(next);
  },

  resetAll: () => {
    const next = { ...DEFAULT_BINDINGS };
    set({ bindings: next });
    localStorage.removeItem(STORAGE_KEY);
  },

  setVoicePushToTalk: (ptt) => {
    set({ voicePushToTalk: ptt });
    if (ptt) {
      localStorage.removeItem(PTT_KEY);
    } else {
      localStorage.setItem(PTT_KEY, "false");
    }
  },
}));

/** Ordered list of actions for the settings UI */
export const HOTKEY_ACTION_ORDER: HotkeyAction[] = [
  "toggleSidebar",
  "toggleAgentLog",
  "toggleVoice",
  "openSettings",
  "openHome",
  "focusInput",
  "newChat",
  "newAgent",
  "restartSession",
  "stopGeneration",
  "toggleFileViewer",
  "toggleFileViewerLayout",
  "toggleChatPanel",
  "switchAgent1",
  "switchAgent2",
  "switchAgent3",
  "switchAgent4",
  "switchAgent5",
  "switchAgent6",
  "switchAgent7",
  "switchAgent8",
  "switchAgent9",
];

export { DEFAULT_BINDINGS };
