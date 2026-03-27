import { create } from "zustand";
import { invoke } from "../lib/transport";
import type { FileTab, FileDiff, DiffEdit } from "../types/fileviewer";
import { isImageFile } from "../types/fileviewer";

const MAX_PINNED_TABS = 10;

/** Result from Rust read_file command */
interface FileContent {
  isBinary: boolean;
  content: string | null;
  size: number;
  language: string | null;
}

interface FileViewerState {
  // Tabs
  tabs: FileTab[];
  activeTabId: string | null;

  // Diffs from CLI agent
  diffs: FileDiff[];
  changedListOpen: boolean;

  // Tab actions
  openPreview: (filePath: string) => Promise<void>;
  openPinned: (filePath: string) => Promise<void>;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  pinTab: (tabId: string) => void;

  // Content editing
  updateTabContent: (tabId: string, newContent: string) => void;
  saveFile: (tabId: string) => Promise<void>;
  // Diff actions
  addDiffFromToolUse: (
    toolUseId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => Promise<void>;
  refreshAfterToolResult: (toolUseId: string) => Promise<void>;
  acceptDiff: (toolUseId: string) => void;
  rejectDiff: (toolUseId: string) => Promise<void>;
  acceptAllPending: () => void;

  // Changed list
  toggleChangedList: () => void;
  openDiffFile: (toolUseId: string) => void;

  // Cleanup
  clearAll: () => void;
}

/** Extract file name from full path */
function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Generate unique tab ID */
function tabId(): string {
  return crypto.randomUUID();
}

/** Notify layoutStore about content availability */
function notifyHasContent(has: boolean) {
  // Lazy import to avoid circular deps at module init time
  import("./layoutStore")
    .then(({ useLayoutStore }) => {
      useLayoutStore.getState().setFileViewerHasContent(has);
    })
    .catch(console.error);
}

export const useFileViewerStore = create<FileViewerState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  diffs: [],
  changedListOpen: false,

  openPreview: async (filePath: string) => {
    const state = get();

    // If already open as pinned, just focus it
    const existingPinned = state.tabs.find(
      (t) => t.filePath === filePath && !t.isPreview,
    );
    if (existingPinned) {
      set({ activeTabId: existingPinned.id });
      return;
    }

    // If already open as preview, just focus it
    const existingPreview = state.tabs.find(
      (t) => t.filePath === filePath && t.isPreview,
    );
    if (existingPreview) {
      set({ activeTabId: existingPreview.id });
      return;
    }

    // Load file content
    const tab = await loadFileTab(filePath, true);
    if (!tab) return;

    // Replace existing preview tab, or add new one (use fresh state after await)
    set((s) => {
      const oldPreviewIdx = s.tabs.findIndex((t) => t.isPreview);
      let newTabs: FileTab[];
      if (oldPreviewIdx >= 0) {
        newTabs = [...s.tabs];
        newTabs[oldPreviewIdx] = tab;
      } else {
        newTabs = [...s.tabs, tab];
      }
      return { tabs: newTabs, activeTabId: tab.id };
    });
    notifyHasContent(true);
  },

  openPinned: async (filePath: string) => {
    const state = get();

    // If already open as pinned, focus it
    const existingPinned = state.tabs.find(
      (t) => t.filePath === filePath && !t.isPreview,
    );
    if (existingPinned) {
      set({ activeTabId: existingPinned.id });
      return;
    }

    // If open as preview, promote to pinned
    const existingPreview = state.tabs.find(
      (t) => t.filePath === filePath && t.isPreview,
    );
    if (existingPreview) {
      const newTabs = state.tabs.map((t) =>
        t.id === existingPreview.id ? { ...t, isPreview: false } : t,
      );
      set({ tabs: newTabs, activeTabId: existingPreview.id });
      return;
    }

    // Load file content
    const tab = await loadFileTab(filePath, false);
    if (!tab) return;

    // Enforce max pinned tabs and add new tab (use fresh state after await)
    set((s) => {
      const pinnedCount = s.tabs.filter((t) => !t.isPreview).length;
      let tabs = [...s.tabs];
      if (pinnedCount >= MAX_PINNED_TABS) {
        const oldest = tabs.find(
          (t) => !t.isPreview && t.id !== s.activeTabId,
        );
        if (oldest) {
          tabs = tabs.filter((t) => t.id !== oldest.id);
        }
      }
      tabs.push(tab);
      return { tabs, activeTabId: tab.id };
    });
    notifyHasContent(true);
  },

  closeTab: (tabId: string) => {
    const state = get();
    const newTabs = state.tabs.filter((t) => t.id !== tabId);
    let newActiveId = state.activeTabId;
    if (state.activeTabId === tabId) {
      // Focus next tab or last tab
      const closedIdx = state.tabs.findIndex((t) => t.id === tabId);
      newActiveId =
        newTabs[closedIdx]?.id ?? newTabs[newTabs.length - 1]?.id ?? null;
    }
    set({ tabs: newTabs, activeTabId: newActiveId });
    if (newTabs.length === 0) {
      notifyHasContent(false);
    }
  },

  setActiveTab: (tabId: string) => {
    set({ activeTabId: tabId });
  },

  pinTab: (tabId: string) => {
    const state = get();
    const newTabs = state.tabs.map((t) =>
      t.id === tabId ? { ...t, isPreview: false } : t,
    );
    set({ tabs: newTabs });
  },

  updateTabContent: (tabId: string, newContent: string) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const newTabs = state.tabs.map((t) =>
      t.id === tabId ? { ...t, content: newContent, isModified: true } : t,
    );

    // Auto-pin if preview
    if (tab.isPreview) {
      const pinned = newTabs.map((t) =>
        t.id === tabId ? { ...t, isPreview: false } : t,
      );
      set({ tabs: pinned });
    } else {
      set({ tabs: newTabs });
    }
  },

  saveFile: async (tabId: string) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab || !tab.content || !tab.isModified) return;

    try {
      await invoke("write_file", { path: tab.filePath, content: tab.content });
      // Use fresh state after await
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, isModified: false, isPreview: false } : t,
        ),
      }));
    } catch (e) {
      console.error("Failed to save file:", e);
    }
  },

  addDiffFromToolUse: async (
    toolUseId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ) => {
    const rawPath = toolInput.file_path ?? toolInput.path;
    const filePath = typeof rawPath === "string" ? rawPath : undefined;
    if (!filePath) return;

    const state = get();

    // Auto-accept any existing pending diff for this file
    const existingPending = state.diffs.find(
      (d) => d.filePath === filePath && d.status === "pending",
    );
    if (existingPending) {
      get().acceptDiff(existingPending.toolUseId);
    }

    // Take snapshot before CLI applies the change
    let snapshot: string | null = null;
    try {
      snapshot = await invoke<string | null>("file_snapshot", { path: filePath });
    } catch (e) {
      console.error("Failed to take file snapshot:", e);
    }

    // Build edits array
    let edits: DiffEdit[];
    if (toolName === "Edit") {
      edits = [
        {
          oldString: (toolInput.old_string as string) ?? "",
          newString: (toolInput.new_string as string) ?? "",
        },
      ];
    } else if (toolName === "Write") {
      edits = [
        {
          oldString: snapshot ?? "",
          newString: (toolInput.content as string) ?? "",
        },
      ];
    } else if (toolName === "MultiEdit") {
      const rawEdits = toolInput.edits as
        | Array<{ old_string: string; new_string: string }>
        | undefined;
      edits = (rawEdits ?? []).map((e) => ({
        oldString: e.old_string,
        newString: e.new_string,
      }));
    } else {
      return;
    }

    const diff: FileDiff = {
      toolUseId,
      filePath,
      fileName: fileName(filePath),
      toolName: toolName as "Edit" | "Write" | "MultiEdit",
      edits,
      status: "pending",
      snapshot,
    };

    set((s) => ({ diffs: [...s.diffs, diff] }));
    notifyHasContent(true);

    // Open diff in preview tab, but don't steal focus from user's pinned tab
    const currentTab = get().tabs.find((t) => t.id === get().activeTabId);
    const userHasPinnedFocus = currentTab && !currentTab.isPreview;

    await get().openPreview(filePath);

    // If user had a pinned tab focused, restore focus to it
    if (userHasPinnedFocus && currentTab) {
      set({ activeTabId: currentTab.id });
    }
  },

  refreshAfterToolResult: async (toolUseId: string) => {
    const state = get();
    const diff = state.diffs.find((d) => d.toolUseId === toolUseId);
    if (!diff) return;

    // Re-read the file into the open tab (or open preview if no tab yet — e.g. new file)
    const tab = state.tabs.find((t) => t.filePath === diff.filePath);
    if (!tab) {
      get().openPreview(diff.filePath).catch(console.error);
      return;
    }

    try {
      const result = await invoke<FileContent>("read_file", {
        path: diff.filePath,
      });
      if (result.content !== null) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tab.id ? { ...t, content: result.content } : t,
          ),
        }));
      }
    } catch (e) {
      console.error("Failed to refresh file after tool result:", e);
    }
  },

  acceptDiff: (toolUseId: string) => {
    set((s) => ({
      diffs: s.diffs.map((d) =>
        d.toolUseId === toolUseId ? { ...d, status: "accepted" as const } : d,
      ),
    }));
    // Clean up accepted diffs
    setTimeout(() => {
      set((s) => ({
        diffs: s.diffs.filter((d) => d.status !== "accepted"),
      }));
    }, 300);
  },

  rejectDiff: async (toolUseId: string) => {
    const state = get();
    const diff = state.diffs.find((d) => d.toolUseId === toolUseId);
    if (!diff) return;

    try {
      if (diff.snapshot !== null) {
        // Restore the snapshot
        await invoke("write_file", {
          path: diff.filePath,
          content: diff.snapshot,
        });
      } else {
        // File was new — delete it
        await invoke("delete_file", { path: diff.filePath });
      }

      // Re-read the file in the tab (re-fetch tabs after await — they may have changed)
      const freshTabs = get().tabs;
      const tab = freshTabs.find((t) => t.filePath === diff.filePath);
      if (tab && diff.snapshot !== null) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tab.id ? { ...t, content: diff.snapshot } : t,
          ),
        }));
      } else if (tab && diff.snapshot === null) {
        // File was deleted — close the tab
        get().closeTab(tab.id);
      }

      // Mark diff as rejected and remove
      set((s) => ({
        diffs: s.diffs.filter((d) => d.toolUseId !== toolUseId),
      }));

      // Send reject message to CLI
      try {
        const { useChatStore } = await import("./chatStore");
        const chatState = useChatStore.getState();
        if (chatState.hasSession) {
          await invoke("send_message", {
            options: {
              agentId: chatState.agentId,
              prompt: `User rejected changes in \`${diff.fileName}\``,
            },
          });
        }
      } catch (e) {
        console.error("Failed to notify CLI about rejection:", e);
      }
    } catch (e) {
      console.error("Failed to reject diff:", e);
    }
  },

  acceptAllPending: () => {
    const state = get();
    const hasPending = state.diffs.some((d) => d.status === "pending");
    if (!hasPending) return;

    set({
      diffs: state.diffs.filter((d) => d.status !== "pending"),
    });
  },

  toggleChangedList: () => {
    set((s) => ({ changedListOpen: !s.changedListOpen }));
  },

  openDiffFile: (toolUseId: string) => {
    const state = get();
    const diff = state.diffs.find((d) => d.toolUseId === toolUseId);
    if (!diff) return;

    // Open the file as preview
    get().openPreview(diff.filePath).catch(console.error);
    set({ changedListOpen: false });
  },

  clearAll: () => {
    set({ tabs: [], activeTabId: null, diffs: [], changedListOpen: false });
    notifyHasContent(false);
  },
}));

/** Load a file tab from disk */
async function loadFileTab(
  filePath: string,
  isPreview: boolean,
): Promise<FileTab | null> {
  const image = isImageFile(filePath);

  if (image) {
    return {
      id: tabId(),
      filePath,
      fileName: fileName(filePath),
      isPreview,
      isModified: false,
      content: null,
      language: null,
      isImage: true,
    };
  }

  try {
    const result = await invoke<FileContent>("read_file", { path: filePath });

    if (result.isBinary) {
      return {
        id: tabId(),
        filePath,
        fileName: fileName(filePath),
        isPreview,
        isModified: false,
        content: null,
        language: null,
        isImage: false,
      };
    }

    return {
      id: tabId(),
      filePath,
      fileName: fileName(filePath),
      isPreview,
      isModified: false,
      content: result.content,
      language: result.language,
      isImage: false,
    };
  } catch (e) {
    console.error("Failed to read file:", e);
    return null;
  }
}

