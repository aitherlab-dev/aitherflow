import { create } from "zustand";

interface AttachmentQueueState {
  pendingPaths: string[];
  queueAttachment: (path: string) => void;
  clearPending: () => void;
}

export const useAttachmentStore = create<AttachmentQueueState>((set) => ({
  pendingPaths: [],

  queueAttachment: (path: string) =>
    set((s) => ({ pendingPaths: [...s.pendingPaths, path] })),

  clearPending: () => set({ pendingPaths: [] }),
}));
