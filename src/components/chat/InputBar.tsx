import { memo, useState, useRef, useCallback, useEffect } from "react";
import { Plus, Star, Mic, ArrowUp, Square } from "lucide-react";
import { useChatStore, getToolLabel } from "../../stores/chatStore";
import { ThinkingIndicator } from "./ThinkingIndicator";

/** Max textarea height in px (~6 lines) */
const MAX_HEIGHT = 168;

export const InputBar = memo(function InputBar() {
  const [text, setText] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const isThinking = useChatStore((s) => s.isThinking);
  const toolActivity = useChatStore((s) => s.currentToolActivity);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + "px";
  }, [text]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isThinking) return;
    setText("");
    sendMessage(trimmed).catch(console.error);
  }, [text, isThinking, sendMessage]);

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
    // File handling will be implemented in a future stage
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
      <div className="input-bar-row">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message..."
          rows={1}
          className="input-bar-textarea"
        />
      </div>
      <div className="input-bar-bottom">
        <div className="input-bar-bottom-left">
          <button className="input-bar-btn" title="Add file" aria-label="Add file">
            <Plus size={18} />
          </button>
          <button className="input-bar-btn" title="Favorite skills" aria-label="Favorite skills">
            <Star size={18} />
          </button>
          <ThinkingIndicator />
        </div>
        <div className="input-bar-bottom-right">
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
              disabled={!text.trim()}
              title="Send"
              aria-label="Send message"
            >
              <ArrowUp size={18} />
            </button>
          )}
          <button className="input-bar-btn" title="Voice input" aria-label="Voice input">
            <Mic size={18} />
          </button>
        </div>
      </div>
    </div>
  );
});
