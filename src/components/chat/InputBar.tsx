import { memo, useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Plus, Star, Mic, MicOff, ArrowUp, Square, MessageSquarePlus, Sparkles, Brain, Zap, Loader2 } from "lucide-react";
import { openDialog } from "../../lib/transport";
import { useChatStore } from "../../stores/chatStore";
import { sendMessage, stopGeneration, newChat, switchPermissionMode } from "../../stores/chatService";
import { useAttachmentStore } from "../../stores/attachmentStore";
import { useFileAttach } from "../../hooks/useFileAttach";
import { usePasteHandler } from "../../hooks/usePasteHandler";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { AttachmentList } from "./AttachmentList";
import { ModelMenu } from "./ModelMenu";
import { SkillsMenu } from "./SkillsMenu";
import { CommandsMenu } from "./CommandsMenu";
import { useConductorStore } from "../../stores/conductorStore";
import { useVoice } from "../../hooks/useVoice";
import { IMAGE_EXTENSIONS } from "../../types/fileviewer";


/** Max textarea height in px (8 full lines) */
const MAX_HEIGHT = 210;
/** Text extensions for file picker filter */
const TEXT_EXTENSIONS = [
  "txt", "log", "rs", "ts", "tsx", "js", "jsx", "py", "md", "toml",
  "json", "yaml", "yml", "css", "html", "sh", "bash", "fish", "zsh",
  "c", "h", "cpp", "hpp", "go", "rb", "java", "xml", "csv", "sql",
];

export const InputBar = memo(function InputBar() {
  const [text, setText] = useState("");
  const [modelMenuRect, setModelMenuRect] = useState<DOMRect | null>(null);
  const [skillsMenuRect, setSkillsMenuRect] = useState<DOMRect | null>(null);
  const [commandsMenuRect, setCommandsMenuRect] = useState<DOMRect | null>(null);
  const [modeSwitching, setModeSwitching] = useState(false);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const skillsBtnRef = useRef<HTMLButtonElement>(null);
  const { attachments, processFromPaths, addAttachment, removeAttachment, clearAttachments } = useFileAttach();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const isThinking = useChatStore((s) => s.isThinking);
  const selectedModel = useConductorStore((s) => s.selectedModel);
  const selectedEffort = useConductorStore((s) => s.selectedEffort);
  const activeModel = useConductorStore((s) => s.model);
  const hasSession = useChatStore((s) => s.hasSession);
  const planMode = useChatStore((s) => s.planMode);
  // Voice input — insert appends, replace overwrites (for streaming interim)
  const handleVoiceInsert = useCallback((transcribed: string) => {
    setText((prev) => (prev ? prev + " " + transcribed : transcribed));
  }, []);
  const handleVoiceReplace = useCallback((newText: string) => {
    setText(newText);
  }, []);
  const textRef = useRef("");
  textRef.current = text;
  const getVoicePrefix = useCallback(() => textRef.current, []);
  const { voiceState, toggleVoice, resetStream } = useVoice(handleVoiceInsert, handleVoiceReplace, getVoicePrefix);

  // Focus textarea when voice recording stops
  const prevVoiceRef = useRef(voiceState);
  useEffect(() => {
    if (prevVoiceRef.current !== "idle" && voiceState === "idle") {
      textareaRef.current?.focus();
    }
    prevVoiceRef.current = voiceState;
  }, [voiceState]);

  // Listen for hotkey:focusInput custom event
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

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + "px";
    if (el.scrollHeight > MAX_HEIGHT) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  // Paste handler
  const handlePaste = usePasteHandler(textareaRef, setText, addAttachment);

  // Process files queued from FilesPanel
  useEffect(() => {
    const unsub = useAttachmentStore.subscribe(async (state, prev) => {
      if (state.pendingPaths.length === 0 || state.pendingPaths === prev.pendingPaths) return;
      const paths = [...state.pendingPaths];
      useAttachmentStore.getState().clearPending();
      processFromPaths(paths).catch(console.error);
    });
    return unsub;
  }, [processFromPaths]);

  // Add file via native picker
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
      processFromPaths(paths).catch(console.error);
    } catch (e) {
      console.error("File dialog error:", e);
    }
  }, [processFromPaths]);

  // Send message with attachments
  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    const hasContent = trimmed || attachments.length > 0;
    if (!hasContent || isThinking) return;

    let finalPrompt = "";
    for (const att of attachments) {
      if (att.fileType === "text") {
        finalPrompt += `\`\`\`${att.name}\n${att.content}\n\`\`\`\n\n`;
      }
    }
    finalPrompt += trimmed;

    setText("");
    clearAttachments();
    resetStream();
    sendMessage(finalPrompt.trim(), attachments.length > 0 ? [...attachments] : undefined).catch(console.error);
  }, [text, attachments, isThinking, clearAttachments, resetStream]);

  const handleStop = useCallback(() => {
    stopGeneration().catch(console.error);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      ref={barRef}
      className="input-bar"
    >

      <AttachmentList attachments={attachments} onRemove={removeAttachment} />

      <div className="input-bar-row">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            const val = e.target.value;
            setText(val);
            if (val === "/" && hasSession && barRef.current && !commandsMenuRect) {
              setCommandsMenuRect(barRef.current.getBoundingClientRect());
            } else if (!val.startsWith("/") && commandsMenuRect) {
              setCommandsMenuRect(null);
            }
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Message..."
          rows={1}
          className="input-bar-textarea"
        />
      </div>
      <div className="input-bar-bottom">
        {/* Row 1 */}
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
            <button
              className={`input-bar-mode-badge${modeSwitching ? " input-bar-mode-badge--switching" : ""}`}
              style={planMode ? { color: "var(--blue)" } : undefined}
              disabled={isThinking || modeSwitching}
              title={planMode ? "Switch to Edit mode (restarts session)" : "Switch to Plan mode (restarts session)"}
              onClick={async () => {
                const newMode = planMode ? "default" : "plan";
                setModeSwitching(true);
                try {
                  await switchPermissionMode(newMode);
                } catch (e) {
                  console.error(e);
                } finally {
                  setModeSwitching(false);
                }
              }}
            >
              {modeSwitching ? "..." : (planMode ? "Plan" : "Edit")}
            </button>
          )}
          <ThinkingIndicator />
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

        {/* Row 2 */}
        <div className="input-bar-cell input-bar-cell--btns">
          <button
            className="input-bar-label-btn"
            onClick={() => { if (!isThinking) newChat().catch(console.error); }}
            disabled={isThinking}
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
          onClose={() => {
            setCommandsMenuRect(null);
            if (text === "/") setText("");
          }}
        />
      )}
    </div>
  );
});
