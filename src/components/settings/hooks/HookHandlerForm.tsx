import { useCallback, useRef, useState } from "react";
import { Play, Trash2, ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { invoke } from "../../../lib/transport";
import { useTranslationStore } from "../../../stores/translationStore";
import type { HookHandler, HandlerType, HookTestResult, HookEvent, HookScope } from "../../../types/hooks";

interface Props {
  handler: HookHandler;
  onUpdate: (handler: HookHandler) => void;
  onDelete: () => void;
  projectPath?: string;
  scope: HookScope;
  event: HookEvent;
  entryIndex: number;
  handlerIndex: number;
}

const HANDLER_TYPES: { value: HandlerType; label: string }[] = [
  { value: "command", label: "Command" },
  { value: "prompt", label: "Prompt" },
  { value: "agent", label: "Agent" },
  { value: "http", label: "HTTP" },
];

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  /sudo\s/,
  /chmod\s+777/,
  /:\(\)\s*\{\s*:\|:/,
  /mkfs\./,
  /dd\s+if=/,
];

function validateCommand(command: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return "Warning: potentially dangerous command";
    }
  }
  return null;
}

function validateUrl(url: string): string | null {
  if (!url) return null;
  try {
    new URL(url);
    return null;
  } catch {
    return "Invalid URL format";
  }
}

export function HookHandlerForm({ handler, onUpdate, onDelete, projectPath, scope, event, entryIndex, handlerIndex }: Props) {
  const translationKey = `hook:${scope}:${event}:${entryIndex}:${handlerIndex}`;
  const translated = useTranslationStore((s) => s.cache.entries[translationKey]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testResult, setTestResult] = useState<HookTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const commandInputRef = useRef<HTMLInputElement>(null);

  const handleTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newType = e.target.value as HandlerType;
      // Preserve common fields
      const base = {
        timeout: handler.timeout,
        once: handler.once,
        statusMessage: handler.statusMessage,
      };
      switch (newType) {
        case "command":
          onUpdate({ ...base, type: "command", command: "" });
          break;
        case "prompt":
          onUpdate({ ...base, type: "prompt", prompt: "" });
          break;
        case "agent":
          onUpdate({ ...base, type: "agent", prompt: "" });
          break;
        case "http":
          onUpdate({ ...base, type: "http", url: "" });
          break;
      }
    },
    [handler, onUpdate],
  );

  const handleTest = useCallback(async () => {
    if (handler.type !== "command" || !handler.command) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invoke<HookTestResult>("test_hook_command", {
        command: handler.command,
        cwd: projectPath,
      });
      setTestResult(result);
    } catch (e) {
      setTestResult({ exit_code: -1, stdout: "", stderr: String(e) });
    }
    setTesting(false);
  }, [handler, projectPath]);

  const commandWarning = handler.type === "command" ? validateCommand(handler.command) : null;
  const urlError = handler.type === "http" ? validateUrl(handler.url) : null;

  return (
    <div className="hooks-handler-form">
      <div className="hooks-handler-top-row">
        <select
          className="hooks-select hooks-type-select"
          value={handler.type}
          onChange={handleTypeChange}
        >
          {HANDLER_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <button
          className="hooks-delete-btn"
          onClick={onDelete}
          title="Remove handler"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Description field */}
      <div className="hooks-field">
        <input
          type="text"
          className="hooks-input hooks-description-input"
          value={handler.statusMessage ?? ""}
          onChange={(e) => onUpdate({ ...handler, statusMessage: e.target.value || undefined })}
          placeholder="What does this hook do?"
        />
        {translated && (
          <span className="hooks-translated-desc">{translated}</span>
        )}
      </div>

      {/* Type-specific fields */}
      {handler.type === "command" && (
        <div className="hooks-field">
          <label className="hooks-field-label">Shell command</label>
          <input
            ref={commandInputRef}
            type="text"
            className={`hooks-input hooks-input-mono ${commandWarning ? "hooks-input--warning" : ""}`}
            value={handler.command}
            onChange={(e) => onUpdate({ ...handler, command: e.target.value })}
            placeholder="echo 'hello'"
          />
          {commandWarning && (
            <span className="hooks-validation-warning">{commandWarning}</span>
          )}
          <div className="hooks-handler-actions">
            <button
              className="hooks-test-btn"
              onClick={handleTest}
              disabled={testing || !handler.command}
            >
              <Play size={12} />
              {testing ? "Running..." : "Test"}
            </button>
            {handler.async !== undefined && (
              <label className="hooks-checkbox-label">
                <input
                  type="checkbox"
                  checked={handler.async ?? false}
                  onChange={(e) => onUpdate({ ...handler, async: e.target.checked })}
                />
                Async (don't wait)
              </label>
            )}
          </div>
          {testResult && (
            <div className={`hooks-test-result ${testResult.exit_code === 0 ? "hooks-test-result--ok" : "hooks-test-result--error"}`}>
              <div className="hooks-test-header">
                <span>Exit code: {testResult.exit_code}</span>
                <button
                  className="hooks-test-edit-btn"
                  onClick={() => {
                    commandInputRef.current?.focus();
                    commandInputRef.current?.select();
                  }}
                >
                  <Pencil size={11} />
                  Edit & Retest
                </button>
              </div>
              {testResult.stdout && (
                <div className="hooks-test-output">
                  <span className="hooks-test-label">stdout:</span>
                  <pre>{testResult.stdout}</pre>
                </div>
              )}
              {testResult.stderr && (
                <div className="hooks-test-output">
                  <span className="hooks-test-label">stderr:</span>
                  <pre>{testResult.stderr}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {handler.type === "prompt" && (
        <div className="hooks-field">
          <label className="hooks-field-label">Prompt text</label>
          <textarea
            className="hooks-textarea"
            value={handler.prompt}
            onChange={(e) => onUpdate({ ...handler, prompt: e.target.value })}
            placeholder="Check if this action is safe..."
            rows={3}
          />
          <div className="hooks-field">
            <label className="hooks-field-label">Model (optional)</label>
            <input
              type="text"
              className="hooks-input"
              value={handler.model ?? ""}
              onChange={(e) => onUpdate({ ...handler, model: e.target.value || undefined })}
              placeholder="claude-sonnet-4-6"
            />
          </div>
        </div>
      )}

      {handler.type === "agent" && (
        <div className="hooks-field">
          <label className="hooks-field-label">Agent prompt</label>
          <textarea
            className="hooks-textarea"
            value={handler.prompt}
            onChange={(e) => onUpdate({ ...handler, prompt: e.target.value })}
            placeholder="Validate this action..."
            rows={3}
          />
        </div>
      )}

      {handler.type === "http" && (
        <div className="hooks-field">
          <label className="hooks-field-label">URL</label>
          <input
            type="text"
            className={`hooks-input ${urlError ? "hooks-input--error" : ""}`}
            value={handler.url}
            onChange={(e) => onUpdate({ ...handler, url: e.target.value })}
            placeholder="http://localhost:8080/hooks"
          />
          {urlError && <span className="hooks-validation-error">{urlError}</span>}
        </div>
      )}

      {/* Advanced settings (collapsible) */}
      <button
        className="hooks-advanced-toggle"
        onClick={() => setShowAdvanced(!showAdvanced)}
      >
        {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Advanced
      </button>

      {showAdvanced && (
        <div className="hooks-advanced">
          <div className="hooks-field-row">
            <div className="hooks-field hooks-field--small">
              <label className="hooks-field-label">Timeout (sec)</label>
              <input
                type="number"
                className="hooks-input"
                value={handler.timeout ?? ""}
                onChange={(e) => {
                  const v = e.target.value ? parseInt(e.target.value, 10) : undefined;
                  onUpdate({ ...handler, timeout: v });
                }}
                placeholder="600"
                min={1}
              />
            </div>
            <label className="hooks-checkbox-label">
              <input
                type="checkbox"
                checked={handler.once ?? false}
                onChange={(e) => onUpdate({ ...handler, once: e.target.checked || undefined })}
              />
              Run once per session
            </label>
          </div>
          {handler.type === "command" && (
            <label className="hooks-checkbox-label">
              <input
                type="checkbox"
                checked={handler.async ?? false}
                onChange={(e) => onUpdate({ ...handler, async: e.target.checked || undefined })}
              />
              Async (don't wait for result)
            </label>
          )}
          {handler.type === "http" && (
            <div className="hooks-field">
              <label className="hooks-field-label">Allowed env vars (comma-separated)</label>
              <input
                type="text"
                className="hooks-input"
                value={handler.allowedEnvVars?.join(", ") ?? ""}
                onChange={(e) => {
                  const vars = e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  onUpdate({ ...handler, allowedEnvVars: vars.length ? vars : undefined });
                }}
                placeholder="MY_TOKEN, API_KEY"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
