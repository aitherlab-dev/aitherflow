import { memo, useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Plus, RotateCcw, Star, Mic, MicOff, ArrowUp, Square, X, MessageSquarePlus, Sparkles, Brain, Zap, Loader2, Slash } from "lucide-react";
import { openDialog, invoke, getCurrentWindow } from "../../lib/transport";
import { useChatStore, getToolLabel, selectRecentTools } from "../../stores/chatStore";
import { useShallow } from "zustand/react/shallow";
import { useAttachmentStore } from "../../stores/attachmentStore";
import { useFileAttach } from "../../hooks/useFileAttach";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ModelMenu } from "./ModelMenu";
import { SkillsMenu } from "./SkillsMenu";
import { CommandsMenu } from "./CommandsMenu";
import { useConductorStore } from "../../stores/conductorStore";
import { useVoice } from "../../hooks/useVoice";


/** Max textarea height in px (8 full lines) */
const MAX_HEIGHT = 210;

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
  const [modelMenuRect, setModelMenuRect] = useState<DOMRect | null>(null);
  const [skillsMenuRect, setSkillsMenuRect] = useState<DOMRect | null>(null);
  const [commandsMenuRect, setCommandsMenuRect] = useState<DOMRect | null>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const skillsBtnRef = useRef<HTMLButtonElement>(null);
  const commandsBtnRef = useRef<HTMLButtonElement>(null);
  const { attachments, processFromPaths, addAttachment, removeAttachment, clearAttachments } = useFileAttach();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const isThinking = useChatStore((s) => s.isThinking);
  const newChat = useChatStore((s) => s.newChat);
  const restartSession = useChatStore((s) => s.restartSession);
  const selectedModel = useConductorStore((s) => s.selectedModel);
  const selectedEffort = useConductorStore((s) => s.selectedEffort);
  const selectedPermissionMode = useConductorStore((s) => s.selectedPermissionMode);
  const activeModel = useConductorStore((s) => s.model);
  const hasSession = useChatStore((s) => s.hasSession);
  const planMode = useChatStore((s) => s.planMode);
  const switchPermissionMode = useChatStore((s) => s.switchPermissionMode);

  // Voice input — insert appends, replace overwrites (for streaming interim)
  const handleVoiceInsert = useCallback((transcribed: string) => {
    setText((prev) => (prev ? prev + " " + transcribed : transcribed));
  }, []);
  const handleVoiceReplace = useCallback((newText: string) => {
    setText(newText);
  }, []);
  // Ref to always have current text for voice prefix (avoids stale closure)
  const textRef = useRef("");
  textRef.current = text;
  const getVoicePrefix = useCallback(() => textRef.current, []);
  const { voiceState, toggleVoice, resetStream } = useVoice(handleVoiceInsert, handleVoiceReplace, getVoicePrefix);

  // Focus textarea when voice recording stops (so user can hit Enter immediately)
  const prevVoiceRef = useRef(voiceState);
  useEffect(() => {
    if (prevVoiceRef.current !== "idle" && voiceState === "idle") {
      textareaRef.current?.focus();
    }
    prevVoiceRef.current = voiceState;
  }, [voiceState]);

  // Listen for hotkey:focusInput custom event from central hotkey handler
  useEffect(() => {
    const handler = () => textareaRef.current?.focus();
    window.addEventListener("hotkey:focusInput", handler);
    return () => window.removeEventListener("hotkey:focusInput", handler);
  }, []);

  // Show actual model from CLI during active session, user's choice otherwise
  const displayModel = useMemo(() => {
    if (hasSession && activeModel) {
      const lower = activeModel.toLowerCase();
      if (lower.includes("opus")) return "Opus";
      if (lower.includes("haiku")) return "Haiku";
      return "Sonnet";
    }
    return selectedModel.charAt(0).toUpperCase() + selectedModel.slice(1);
  }, [hasSession, activeModel, selectedModel]);

  // Last 2 tool activities from the latest assistant message
  const recentTools = useChatStore(useShallow(selectRecentTools));

  // Auto-resize textarea and keep cursor visible
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + "px";
    // Scroll to caret so the typing line is always visible
    if (el.scrollHeight > MAX_HEIGHT) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  // Listen for Tauri drag-drop events (gives real file paths)
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    getCurrentWindow().then((win) => {
      if (cancelled || !win) return;
      const unlisten = win.onDragDropEvent(async (event: { payload: { type: string; paths: string[] } }) => {
        if (event.payload.type === "drop") {
          setIsDragOver(false);
          processFromPaths(event.payload.paths);
        } else if (event.payload.type === "over") {
          setIsDragOver(true);
        } else if (event.payload.type === "leave") {
          setIsDragOver(false);
        }
      });
      unlisten.then((fn: () => void) => {
        if (cancelled) fn();
        else cleanup = fn;
      });
    });

    return () => {
      cancelled = true;
      cleanup?.();
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
      const selected = await openDialog({
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

      // Try text first
      try {
        const clipText = await invoke<string>("read_clipboard_text");
        if (clipText) {
          const ta = textareaRef.current;
          if (ta) {
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            const before = text.slice(0, start);
            const after = text.slice(end);
            setText(before + clipText + after);
            // Restore cursor position after inserted text
            requestAnimationFrame(() => {
              const pos = start + clipText.length;
              ta.selectionStart = pos;
              ta.selectionEnd = pos;
            });
          } else {
            setText((prev) => prev + clipText);
          }
          return;
        }
      } catch {
        // No text — try image below
      }

      // Try image
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
        // No image in clipboard either — nothing to paste
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
    resetStream(); // Clear accumulated voice text so stream doesn't refill textarea
    sendMessage(finalPrompt.trim(), attachments.length > 0 ? [...attachments] : undefined).catch(console.error);
  }, [text, attachments, isThinking, sendMessage, clearAttachments, resetStream]);

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
        {/* ── Row 1 ── */}
        <div className="input-bar-cell input-bar-cell--btns">
          <button
            className="input-bar-btn"
            title="Add file"
            aria-label="Add file"
            onClick={handleAddFile}
          >
            <Plus size={18} />
          </button>
          {hasSession && (
            <>
              <button
                className="input-bar-btn"
                title="Restart session"
                aria-label="Restart session"
                onClick={() => restartSession().catch(console.error)}
              >
                <RotateCcw size={16} />
              </button>
              <button
                ref={commandsBtnRef}
                className="input-bar-btn"
                title="CLI commands"
                aria-label="CLI commands"
                onClick={() => {
                  if (commandsMenuRect) {
                    setCommandsMenuRect(null);
                  } else if (commandsBtnRef.current) {
                    setCommandsMenuRect(commandsBtnRef.current.getBoundingClientRect());
                  }
                }}
              >
                <Slash size={16} />
              </button>
            </>
          )}
          <ThinkingIndicator />
        </div>
        <div className="input-bar-cell input-bar-cell--status">
          {recentTools[0] && (
            <div className={`tool-status ${recentTools[0].result !== undefined ? "tool-status--done" : ""}`}>
              <span className="tool-status-dot" />
              <span className="tool-status-text">{getToolLabel(recentTools[0])}</span>
            </div>
          )}
        </div>
        <div className="input-bar-cell input-bar-cell--btns input-bar-cell--end">
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
          <button
            className={`input-bar-btn input-bar-btn--icon${voiceState === "recording" || voiceState === "streaming" ? " voice-recording" : ""}`}
            title={voiceState === "recording" || voiceState === "streaming" ? "Stop recording" : voiceState === "processing" ? "Processing..." : "Voice input"}
            aria-label="Voice input"
            onClick={toggleVoice}
            disabled={voiceState === "processing"}
          >
            {voiceState === "processing" ? (
              <Loader2 size={18} className="voice-spinner" />
            ) : voiceState === "recording" || voiceState === "streaming" ? (
              <MicOff size={18} />
            ) : (
              <Mic size={18} />
            )}
          </button>
        </div>

        {/* ── Row 2 ── */}
        <div className="input-bar-cell input-bar-cell--btns">
          <button
            className="input-bar-label-btn"
            onClick={newChat}
            title="New chat"
            aria-label="New chat"
          >
            <MessageSquarePlus size={14} />
            <span>New Chat</span>
          </button>
          <button
            ref={modelBtnRef}
            className="input-bar-label-btn"
            title="Switch model (right-click for effort)"
            aria-label="Switch model"
            onClick={() => {
              if (modelBtnRef.current) {
                setModelMenuRect(modelBtnRef.current.getBoundingClientRect());
              }
            }}
          >
            {selectedEffort === "low" ? <Zap size={14} /> : selectedEffort === "medium" ? <Sparkles size={14} /> : <Brain size={14} />}
            <span>{displayModel}</span>
            {selectedEffort !== "high" && (
              <span className="model-effort-badge">{selectedEffort}</span>
            )}
          </button>
          <button
            className="input-bar-label-btn"
            title={hasSession
              ? (planMode ? "Switch to Edit mode (restarts session)" : "Switch to Plan mode (restarts session)")
              : (selectedPermissionMode === "plan" ? "Will start in Plan mode" : "Will start in Edit mode")}
            aria-label="Toggle plan/edit mode"
            disabled={isThinking}
            onClick={() => {
              const newMode = (planMode || selectedPermissionMode === "plan") ? "default" : "plan";
              if (hasSession) {
                switchPermissionMode(newMode).catch(console.error);
              } else {
                useConductorStore.getState().setSelectedPermissionMode(newMode);
              }
            }}
          >
            <span style={planMode || selectedPermissionMode === "plan" ? { color: "var(--accent-icon)" } : undefined}>
              {planMode || selectedPermissionMode === "plan" ? "Plan" : "Edit"}
            </span>
          </button>
        </div>
        <div className="input-bar-cell input-bar-cell--status">
          {recentTools[1] && (
            <div className={`tool-status ${recentTools[1].result !== undefined ? "tool-status--done" : ""}`}>
              <span className="tool-status-dot" />
              <span className="tool-status-text">{getToolLabel(recentTools[1])}</span>
            </div>
          )}
        </div>
        <div className="input-bar-cell input-bar-cell--btns input-bar-cell--end">
          <button
            ref={skillsBtnRef}
            className="input-bar-label-btn"
            title="Favorite skills"
            aria-label="Favorite skills"
            onClick={() => {
              if (skillsMenuRect) {
                setSkillsMenuRect(null);
              } else if (skillsBtnRef.current) {
                setSkillsMenuRect(skillsBtnRef.current.getBoundingClientRect());
              }
            }}
          >
            <Star size={14} />
            <span>Skills</span>
          </button>
        </div>
      </div>
      {modelMenuRect && (
        <ModelMenu
          anchorRect={modelMenuRect}
          onClose={() => setModelMenuRect(null)}
        />
      )}
      {skillsMenuRect && (
        <SkillsMenu
          anchorRect={skillsMenuRect}
          onClose={() => setSkillsMenuRect(null)}
        />
      )}
      {commandsMenuRect && (
        <CommandsMenu
          anchorRect={commandsMenuRect}
          onClose={() => setCommandsMenuRect(null)}
        />
      )}
    </div>
  );
});
