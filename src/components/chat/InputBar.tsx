import { memo, useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Plus, Star, Mic, MicOff, ArrowUp, Square, MessageSquarePlus, Sparkles, Brain, Zap, Loader2, UserCog, Radio } from "lucide-react";
import { openDialog, invoke } from "../../lib/transport";
import { useChatStore, agentStates } from "../../stores/chatStore";
import { sendMessage, stopGeneration, newChat, switchPermissionMode } from "../../stores/chatService";
import { useAttachmentStore } from "../../stores/attachmentStore";
import { useFileAttach } from "../../hooks/useFileAttach";
import { usePasteHandler } from "../../hooks/usePasteHandler";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { AttachmentList } from "./AttachmentList";
import { ModelMenu } from "./ModelMenu";
import { RoleMenu } from "./RoleMenu";
import { SkillsMenu } from "./SkillsMenu";
import { CommandsMenu } from "./CommandsMenu";
import { useConductorStore } from "../../stores/conductorStore";
import { useVoice } from "../../hooks/useVoice";
import { useAgentStore } from "../../stores/agentStore";
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
  const [roleMenuRect, setRoleMenuRect] = useState<DOMRect | null>(null);
  const [skillsMenuRect, setSkillsMenuRect] = useState<DOMRect | null>(null);
  const [commandsMenuRect, setCommandsMenuRect] = useState<DOMRect | null>(null);
  const [modeSwitching, setModeSwitching] = useState(false);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const roleBtnRef = useRef<HTMLButtonElement>(null);
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
  const agentId = useChatStore((s) => s.agentId);
  const agentRoles = useConductorStore((s) => s.agentRoles);
  const currentRoleName = agentRoles[agentId]?.name ?? null;
  const projectPath = useChatStore((s) => s.projectPath);
  const agents = useAgentStore((s) => s.agents);
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

  // Broadcast message to team mailbox (Ctrl+Enter)
  const handleBroadcast = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || !projectPath) return;

    try {
      // Auto-start agents that don't have a session yet
      const projectAgents = agents.filter((a) => a.projectPath === projectPath);
      const currentAgentId = useChatStore.getState().agentId;
      const unstartedAgents = projectAgents.filter((a) => {
        if (a.id === currentAgentId) return !useChatStore.getState().hasSession;
        return !(agentStates.get(a.id)?.hasSession ?? false);
      });

      // Ensure agentStates entries exist so chatStreamHandler doesn't drop events
      for (const agent of unstartedAgents) {
        if (!agentStates.has(agent.id)) {
          agentStates.set(agent.id, {
            messages: [],
            streamingMessage: null,
            chatId: null,
            hasSession: false,
            isThinking: false,
            planMode: false,
            currentToolActivity: null,
            toolCount: 0,
            error: null,
          });
        }
      }

      if (unstartedAgents.length > 0) {
        const settings = await invoke<{ bypassPermissions: boolean; enableChrome: boolean }>("load_settings");
        const conductor = useConductorStore.getState();

        const startPromises = unstartedAgents.map((agent) => {
          const role = conductor.getAgentRole(agent.id);
          return invoke("start_session", { options: {
            agentId: agent.id,
            prompt: trimmed,
            projectPath: agent.projectPath,
            model: conductor.selectedModel,
            effort: conductor.selectedEffort !== "high" ? conductor.selectedEffort : undefined,
            permissionMode: settings.bypassPermissions ? "bypassPermissions" : undefined,
            chrome: settings.enableChrome ?? false,
            roleSystemPrompt: role?.system_prompt || undefined,
            roleAllowedTools: role?.allowed_tools?.length ? role.allowed_tools : undefined,
          }});
        });
        const results = await Promise.allSettled(startPromises);
        for (const r of results) {
          if (r.status === "rejected") console.error("Agent start failed:", r.reason);
        }
      }

      const teamSlug = await invoke<string>("get_teamwork_slug", { projectPath });
      const agentIds = projectAgents.map((a) => a.id);
      await invoke("team_broadcast", {
        team: teamSlug,
        from: "user",
        text: trimmed,
        agentIds,
      });

      // Send to already-running agents via stdin
      const alreadyRunning = projectAgents.filter(a => !unstartedAgents.some(u => u.id === a.id));
      if (alreadyRunning.length > 0) {
        const sendResults = await Promise.allSettled(
          alreadyRunning.map((agent) =>
            invoke("send_message", { options: { agentId: agent.id, prompt: trimmed } })
          ),
        );
        for (const r of sendResults) {
          if (r.status === "rejected") console.error("Send to agent failed:", r.reason);
        }
      }

      setText("");
      resetStream();
    } catch (e) {
      console.error("Broadcast failed:", e);
    }
  }, [text, projectPath, agents, resetStream]);

  const handleStop = useCallback(() => {
    stopGeneration().catch(console.error);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Enter" && e.ctrlKey) {
        e.preventDefault();
        handleBroadcast().catch(console.error);
      } else if (e.code === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, handleBroadcast],
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
            <>
              {agents.length > 0 && (
                <button
                  className="input-bar-btn"
                  onClick={handleBroadcast}
                  disabled={!text.trim() || !projectPath}
                  title="Broadcast to team (Ctrl+Enter)"
                  aria-label="Broadcast to team"
                >
                  <Radio size={18} />
                </button>
              )}
              <button
                className="input-bar-btn input-bar-send"
                onClick={handleSend}
                disabled={!text.trim() && attachments.length === 0}
                title="Send"
                aria-label="Send message"
              >
                <ArrowUp size={18} />
              </button>
            </>
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
          <button
            ref={roleBtnRef}
            className="input-bar-label-btn"
            title="Select role"
            aria-label="Select role"
            onClick={() => {
              if (roleBtnRef.current) {
                setRoleMenuRect(roleBtnRef.current.getBoundingClientRect());
              }
            }}
          >
            <UserCog size={14} />
            <span>{currentRoleName ?? "No role"}</span>
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
      {roleMenuRect && (
        <RoleMenu
          anchorRect={roleMenuRect}
          onClose={() => setRoleMenuRect(null)}
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
