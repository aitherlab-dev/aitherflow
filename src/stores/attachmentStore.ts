import { create } from "zustand";

interface AttachmentQueueState {
  pendingPaths: string[];
  dragPath: string | null;
  queueAttachment: (path: string) => void;
  clearPending: () => void;
  setDragPath: (path: string | null) => void;
}

export const useAttachmentStore = create<AttachmentQueueState>((set) => ({
  pendingPaths: [],
  dragPath: null,

  queueAttachment: (path: string) =>
    set((s) => ({ pendingPaths: [...s.pendingPaths, path] })),

  clearPending: () => set({ pendingPaths: [] }),

  setDragPath: (path: string | null) => set({ dragPath: path }),
}));
