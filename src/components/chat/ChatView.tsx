import { memo, useCallback, useRef, useState } from "react";
import { MessageList } from "./MessageList";
import { InputBar } from "./InputBar";
import { TaskBar } from "./TaskBar";
import { useChatStore } from "../../stores/chatStore";
import { useAttachmentStore } from "../../stores/attachmentStore";
import { useTauriDragDrop } from "../../hooks/useTauriDragDrop";

export const ChatView = memo(function ChatView() {
  const error = useChatStore((s) => s.error);
  const isEmpty = useChatStore((s) => s.messages.length === 0);
  const dragCounter = useRef(0);

  // Tauri native drag-drop (files from OS file manager)
  const processFromPaths = useCallback((paths: string[]) => {
    useAttachmentStore.getState().queuePaths(paths);
    return Promise.resolve();
  }, []);
  const { isDragOver: isTauriDrag } = useTauriDragDrop(processFromPaths);

  // Internal drag (from built-in file panel)
  const [isInternalDrag, setIsInternalDrag] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!useAttachmentStore.getState().dragPath) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!useAttachmentStore.getState().dragPath) return;
    e.preventDefault();
    dragCounter.current++;
    setIsInternalDrag(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsInternalDrag(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsInternalDrag(false);
    const path = useAttachmentStore.getState().dragPath;
    if (path) {
      useAttachmentStore.getState().setDragPath(null);
      useAttachmentStore.getState().queueAttachment(path);
    }
  }, []);

  const isDragOver = isTauriDrag || isInternalDrag;

  return (
    <div
      className={`chat-view chat-view-inset ${isEmpty ? "chat-view--empty" : ""}`}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="chat-drop-overlay">
          <div className="chat-drop-zone">Drop file to attach</div>
        </div>
      )}
      <MessageList />

      <div className="chat-bottom">
        {error && (
          <div className="chat-error">{error}</div>
        )}
        <InputBar />
        <TaskBar />
      </div>
    </div>
  );
});
