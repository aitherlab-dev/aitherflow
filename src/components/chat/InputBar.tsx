import { memo, useState, useRef, useCallback, useEffect } from "react";
import { Plus, Star, Mic, ArrowUp, Square, X, MessageSquarePlus } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useChatStore, getToolLabel } from "../../stores/chatStore";
import { useAttachmentStore } from "../../stores/attachmentStore";
import { useFileAttach } from "../../hooks/useFileAttach";
import { ThinkingIndicator } from "./ThinkingIndicator";


/** Max textarea height in px (~6 lines) */
const MAX_HEIGHT = 168;

/** Image extensions for file picker filter */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
/** Text extensions for file picker filter */
const TEXT_EXTENSIONS = [
  "txt", "log", "rs", "ts", "tsx", "js", "jsx", "py", "md", "toml",
  "json", "yaml", "yml", "css", "html", "sh", "bash", "fish", "zsh",
  "c", "h", "cpp", "hpp", "go", "rb", "java", "xml", "csv", "sql",
];

/** Read a File (blob) into a data URI string */
function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export const InputBar = memo(function InputBar() {
  const [text, setText] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const { attachments, processFromPaths, addAttachment, removeAttachment, clearAttachments } = useFileAttach();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const isThinking = useChatStore((s) => s.isThinking);
  const toolActivity = useChatStore((s) => s.currentToolActivity);
  const newChat = useChatStore((s) => s.newChat);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + "px";
  }, [text]);

  // Listen for Tauri drag-drop events (gives real file paths)
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onDragDropEvent(async (event) => {
      if (event.payload.type === "drop") {
        setIsDragOver(false);
        processFromPaths(event.payload.paths);
      } else if (event.payload.type === "over") {
        setIsDragOver(true);
      } else if (event.payload.type === "leave") {
        setIsDragOver(false);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [processFromPaths]);

  // ── Process files queued from FilesPanel ──
  useEffect(() => {
    const unsub = useAttachmentStore.subscribe(async (state, prev) => {
      if (state.pendingPaths.length === 0 || state.pendingPaths === prev.pendingPaths) return;
      const paths = [...state.pendingPaths];
      useAttachmentStore.getState().clearPending();
      processFromPaths(paths);
    });
    return unsub;
  }, [processFromPaths]);

  // ── Add file via native picker ──
  const handleAddFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "Images", extensions: IMAGE_EXTENSIONS },
          { name: "Text files", extensions: TEXT_EXTENSIONS },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      processFromPaths(paths);
    } catch (e) {
      console.error("File dialog error:", e);
    }
  }, [processFromPaths]);

  // ── Paste handler (Ctrl+V) ──
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const cd = e.clipboardData;
    const types = Array.from(cd.types);

    // If text + image together (e.g. Telegram copy), prioritize text
    if (types.includes("text/plain") && types.some((t) => t.startsWith("image/"))) {
      // Let default paste handle the text
      return;
    }

    // Branch 1: explicit File with image MIME
    if (types.includes("Files")) {
      const files = cd.files;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.type.startsWith("image/")) {
          e.preventDefault();
          try {
            const dataUri = await readFileAsDataUri(file);
            addAttachment({
              id: crypto.randomUUID(),
              name: file.name || "pasted-image.png",
              content: dataUri,
              size: file.size,
              fileType: "image",
            });
          } catch (err) {
            console.error("Failed to read pasted file:", err);
          }
          return;
        }
      }
    }

    // Branch 2: raw image type in clipboard items (screenshot)
    if (types.some((t) => t.startsWith("image/"))) {
      e.preventDefault();
      const items = cd.items;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;
          try {
            const dataUri = await readFileAsDataUri(file);
            addAttachment({
              id: crypto.randomUUID(),
              name: "screenshot.png",
              content: dataUri,
              size: file.size,
              fileType: "image",
            });
          } catch (err) {
            console.error("Failed to read pasted image:", err);
          }
          return;
        }
      }
    }

    // Branch 3: empty types (Wayland/WebKitGTK bug) — fallback to Rust clipboard
    if (types.length === 0) {
      e.preventDefault();
      try {
        const result = await invoke<{
          path: string;
          preview: string;
          size: number;
          filename: string;
        }>("read_clipboard_image");
        addAttachment({
          id: crypto.randomUUID(),
          name: result.filename,
          content: result.preview,
          size: result.size,
          fileType: "image",
        });
      } catch {
        // No image in clipboard — do nothing
      }
      return;
    }

    // Default: let the browser handle text paste normally
  }, [addAttachment]);

  // ── Send message with attachments ──
  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    const hasContent = trimmed || attachments.length > 0;
    if (!hasContent || isThinking) return;

    // Build final prompt: text attachments inline as code blocks (for CLI)
    let finalPrompt = "";
    for (const att of attachments) {
      if (att.fileType === "text") {
        finalPrompt += `\`\`\`${att.name}\n${att.content}\n\`\`\`\n\n`;
      }
    }
    finalPrompt += trimmed;

    setText("");
    clearAttachments();
    sendMessage(finalPrompt.trim(), attachments.length > 0 ? [...attachments] : undefined).catch(console.error);
  }, [text, attachments, isThinking, sendMessage, clearAttachments]);

  const handleStop = useCallback(() => {
    stopGeneration().catch(console.error);
  }, [stopGeneration]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // DOM drag events (visual feedback only — actual file handling via Tauri events)
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    // Actual file processing handled by Tauri onDragDropEvent (OS drops)
    // or ChatView drop handler (internal FilesPanel drops)
  }, []);

  return (
    <div
      className={`input-bar ${isDragOver ? "input-bar-dragover" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="input-bar-drop-overlay">Drop files here</div>
      )}

      {/* Attachment cards */}
      {attachments.length > 0 && (
        <div className="attachment-chips">
          {attachments.map((att) => (
            <div key={att.id} className={`attachment-chip ${att.fileType === "image" ? "attachment-chip--image" : "attachment-chip--file"}`}>
              <button
                className="attachment-chip-remove"
                onClick={() => removeAttachment(att.id)}
                title="Remove"
              >
                <X size={10} />
              </button>
              {att.fileType === "image" ? (
                <img
                  src={att.content}
                  alt={att.name}
                  className="attachment-chip-preview"
                />
              ) : (
                <>
                  <span className="attachment-chip-name">{att.name}</span>
                  <span className="attachment-chip-ext">
                    {att.name.includes(".") ? att.name.split(".").pop()!.toUpperCase() : "FILE"}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="input-bar-row">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Message..."
          rows={1}
          className="input-bar-textarea"
        />
      </div>
      <div className="input-bar-bottom">
        <div className="input-bar-bottom-left">
          <button
            className="input-bar-btn"
            title="Add file"
            aria-label="Add file"
            onClick={handleAddFile}
          >
            <Plus size={18} />
          </button>
          <button className="input-bar-btn" title="Favorite skills" aria-label="Favorite skills">
            <Star size={18} />
          </button>
          <ThinkingIndicator />
        </div>
        <div className="input-bar-bottom-right">
          {!isThinking && (
            <button
              className="input-bar-btn"
              onClick={newChat}
              title="New chat"
              aria-label="New chat"
            >
              <MessageSquarePlus size={18} />
            </button>
          )}
          {toolActivity && (
            <div className="tool-status">
              <span className="tool-status-dot" />
              <span className="tool-status-text">{getToolLabel(toolActivity)}</span>
            </div>
          )}
          <button
            className="input-bar-btn input-bar-model"
            title="Switch model"
            aria-label="Switch model"
          >
            <span className="input-bar-model-label">Sonnet</span>
          </button>
          {isThinking ? (
            <button
              className="input-bar-btn input-bar-stop"
              onClick={handleStop}
              title="Stop"
              aria-label="Stop generation"
            >
              <Square size={18} />
            </button>
          ) : (
            <button
              className="input-bar-btn input-bar-send"
              onClick={handleSend}
              disabled={!text.trim() && attachments.length === 0}
              title="Send"
              aria-label="Send message"
            >
              <ArrowUp size={18} />
            </button>
          )}
          <button className="input-bar-btn input-bar-btn--icon" title="Voice input" aria-label="Voice input">
            <Mic size={18} />
          </button>
        </div>
      </div>
    </div>
  );
});
