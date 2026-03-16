import { create } from "zustand";

const SIDEBAR_MIN = 250;
const SIDEBAR_MAX = 350;
const SIDEBAR_DEFAULT = 350;

const FV_RIGHT_MIN = 250;
const FV_RIGHT_DEFAULT = 480;
const FV_BOTTOM_MIN = 150;
const FV_BOTTOM_DEFAULT = 300;

export type ActiveView = "welcome" | "chat" | "settings";
export type SidebarPanel = "agents" | "files";
export type FileViewerPosition = "right" | "bottom";

interface LayoutState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  activeView: ActiveView;
  settingsSection: string;
  sidebarPanel: SidebarPanel;

  // File viewer panel
  fileViewerVisible: boolean;
  fileViewerPosition: FileViewerPosition;
  fileViewerSize: number;
  fileViewerHasContent: boolean;

  // Agent log panel
  agentLogOpen: boolean;

  // Chat panel
  chatPanelVisible: boolean;

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  openWelcome: () => void;
  closeWelcome: () => void;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  setSettingsSection: (section: string) => void;
  setSidebarPanel: (panel: SidebarPanel) => void;

  // Agent log actions
  toggleAgentLog: () => void;

  // Chat panel actions
  toggleChatPanel: () => void;

  // File viewer actions
  toggleFileViewer: () => void;
  setFileViewerPosition: (pos: FileViewerPosition) => void;
  setFileViewerSize: (size: number) => void;
  setFileViewerHasContent: (has: boolean) => void;
}

/** Restore persisted file viewer settings from localStorage */
function loadFileViewerPrefs(): {
  fileViewerVisible: boolean;
  fileViewerPosition: FileViewerPosition;
} {
  try {
    const raw = localStorage.getItem("aitherflow:fileviewer");
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        fileViewerVisible: parsed.visible ?? true,
        fileViewerPosition: parsed.position ?? "right",
      };
    }
  } catch {
    // ignore
  }
  return { fileViewerVisible: true, fileViewerPosition: "right" };
}

/** Persist file viewer settings to localStorage */
function saveFileViewerPrefs(visible: boolean, position: FileViewerPosition) {
  try {
    localStorage.setItem(
      "aitherflow:fileviewer",
      JSON.stringify({ visible, position }),
    );
  } catch {
    // ignore
  }
}

/** Restore chat panel visibility from localStorage */
function loadChatPanelVisible(): boolean {
  try {
    const raw = localStorage.getItem("aitherflow:chatpanel");
    if (raw !== null) return JSON.parse(raw) as boolean;
  } catch {
    // ignore
  }
  return true;
}

const prefs = loadFileViewerPrefs();

export const useLayoutStore = create<LayoutState>((set, get) => ({
  sidebarOpen: window.innerWidth >= 768,
  sidebarWidth: SIDEBAR_DEFAULT,
  activeView: "welcome",
  settingsSection: "projects",
  sidebarPanel: "agents",

  fileViewerVisible: prefs.fileViewerVisible,
  fileViewerPosition: prefs.fileViewerPosition,
  fileViewerSize:
    prefs.fileViewerPosition === "right" ? FV_RIGHT_DEFAULT : FV_BOTTOM_DEFAULT,
  fileViewerHasContent: false,

  agentLogOpen: false,
  chatPanelVisible: loadChatPanelVisible(),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  setSidebarWidth: (width: number) =>
    set({ sidebarWidth: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width)) }),

  openWelcome: () => set({ activeView: "welcome" }),

  closeWelcome: () => set({ activeView: "chat" }),

  openSettings: (section?: string) =>
    set({
      activeView: "settings",
      ...(section ? { settingsSection: section } : {}),
    }),

  closeSettings: () => set({ activeView: "chat" }),

  setSettingsSection: (section: string) => set({ settingsSection: section }),

  setSidebarPanel: (panel) => set({ sidebarPanel: panel }),

  toggleAgentLog: () => set((s) => ({ agentLogOpen: !s.agentLogOpen })),

  toggleChatPanel: () => {
    const next = !get().chatPanelVisible;
    set({ chatPanelVisible: next });
    try { localStorage.setItem("aitherflow:chatpanel", JSON.stringify(next)); } catch { /* ignore */ }
  },

  toggleFileViewer: () => {
    const next = !get().fileViewerVisible;
    set({ fileViewerVisible: next });
    saveFileViewerPrefs(next, get().fileViewerPosition);
  },

  setFileViewerPosition: (pos: FileViewerPosition) => {
    const size = pos === "right" ? FV_RIGHT_DEFAULT : FV_BOTTOM_DEFAULT;
    set({ fileViewerPosition: pos, fileViewerSize: size });
    saveFileViewerPrefs(get().fileViewerVisible, pos);
  },

  setFileViewerSize: (size: number) => {
    const state = get();
    if (state.fileViewerPosition === "right") {
      set({ fileViewerSize: Math.max(FV_RIGHT_MIN, size) });
    } else {
      set({ fileViewerSize: Math.max(FV_BOTTOM_MIN, size) });
    }
  },

  setFileViewerHasContent: (has: boolean) => set({ fileViewerHasContent: has }),
}));
