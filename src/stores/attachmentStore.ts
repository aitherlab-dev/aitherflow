import { create } from "zustand";

interface AttachmentQueueState {
  pendingPaths: string[];
  dragPath: string | null;
  queueAttachment: (path: string) => void;
  queuePaths: (paths: string[]) => void;
  clearPending: () => void;
  setDragPath: (path: string | null) => void;
}

export const useAttachmentStore = create<AttachmentQueueState>((set) => ({
  pendingPaths: [],
  dragPath: null,

  queueAttachment: (path: string) =>
    set((s) => ({ pendingPaths: [...s.pendingPaths, path] })),

  queuePaths: (paths: string[]) =>
    set((s) => ({ pendingPaths: [...s.pendingPaths, ...paths] })),

  clearPending: () => set({ pendingPaths: [] }),

  setDragPath: (path: string | null) => set({ dragPath: path }),
}));
