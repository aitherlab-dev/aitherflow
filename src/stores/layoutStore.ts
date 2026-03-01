import { create } from "zustand";

const SIDEBAR_MIN = 250;
const SIDEBAR_MAX = 350;
const SIDEBAR_DEFAULT = 350;

export type ActiveView = "chat" | "settings";

interface LayoutState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  activeView: ActiveView;
  settingsSection: string;

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
  setSettingsSection: (section: string) => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  sidebarOpen: true,
  sidebarWidth: SIDEBAR_DEFAULT,
  activeView: "chat",
  settingsSection: "projects",

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  setSidebarWidth: (width: number) =>
    set({ sidebarWidth: Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, width)) }),

  openSettings: (section?: string) =>
    set({
      activeView: "settings",
      ...(section ? { settingsSection: section } : {}),
    }),

  closeSettings: () => set({ activeView: "chat" }),

  setSettingsSection: (section: string) => set({ settingsSection: section }),
}));
