import { useCallback, useState } from "react";
import { Check } from "lucide-react";
import type { McpServerConfig } from "../../../types/mcp";

export function McpEditForm({
  config,
  onChange,
  onSave,
  onCancel,
  nameValue,
  onNameChange,
}: {
  config: McpServerConfig;
  onChange: (c: McpServerConfig) => void;
  onSave: () => void;
  onCancel: () => void;
  nameValue?: string;
  onNameChange?: (v: string) => void;
}) {
  const [envText, setEnvText] = useState(
    Object.entries(config.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [headersText, setHeadersText] = useState(
    config.headers
      ? Object.entries(config.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "",
  );

  const updateType = useCallback(
    (serverType: string) => {
      onChange({ ...config, serverType });
    },
    [config, onChange],
  );

  const updateEnv = useCallback(
    (text: string) => {
      setEnvText(text);
      const env: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0) {
          env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
      onChange({ ...config, env });
    },
    [config, onChange],
  );

  const updateHeaders = useCallback(
    (text: string) => {
      setHeadersText(text);
      const headers: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) {
          headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
      onChange({ ...config, headers });
    },
    [config, onChange],
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.code === "Escape") onCancel();
    },
    [onCancel],
  );

  return (
    <div className="mcp-edit-form" onKeyDown={handleKey}>
      {/* Name (only for add) */}
      {nameValue !== undefined && onNameChange && (
        <div className="mcp-edit-row">
          <label className="mcp-edit-label">Name</label>
          <input
            className="mcp-edit-input"
            value={nameValue}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="my-server"
            spellCheck={false}
            autoFocus
          />
        </div>
      )}

      {/* Type */}
      <div className="mcp-edit-row">
        <label className="mcp-edit-label">Type</label>
        <select
          className="mcp-edit-select"
          value={config.serverType}
          onChange={(e) => updateType(e.target.value)}
        >
          <option value="stdio">stdio</option>
          <option value="sse">sse</option>
          <option value="http">http</option>
        </select>
      </div>

      {/* stdio fields */}
      {config.serverType === "stdio" && (
        <>
          <div className="mcp-edit-row">
            <label className="mcp-edit-label">Command</label>
            <input
              className="mcp-edit-input"
              value={config.command ?? ""}
              onChange={(e) => onChange({ ...config, command: e.target.value })}
              placeholder="npx, node, python..."
              spellCheck={false}
            />
          </div>
          <div className="mcp-edit-row">
            <label className="mcp-edit-label">Args</label>
            <input
              className="mcp-edit-input"
              value={config.args?.join(" ") ?? ""}
              onChange={(e) =>
                onChange({
                  ...config,
                  args: e.target.value ? e.target.value.split(" ") : undefined,
                })
              }
              placeholder="-y @package/name"
              spellCheck={false}
            />
          </div>
        </>
      )}

      {/* sse/http fields */}
      {(config.serverType === "sse" || config.serverType === "http") && (
        <>
          <div className="mcp-edit-row">
            <label className="mcp-edit-label">URL</label>
            <input
              className="mcp-edit-input"
              value={config.url ?? ""}
              onChange={(e) => onChange({ ...config, url: e.target.value })}
              placeholder="https://..."
              spellCheck={false}
            />
          </div>
          <div className="mcp-edit-row">
            <label className="mcp-edit-label">Headers</label>
            <textarea
              className="mcp-edit-textarea"
              value={headersText}
              onChange={(e) => updateHeaders(e.target.value)}
              placeholder="Authorization: Bearer ..."
              rows={2}
              spellCheck={false}
            />
          </div>
        </>
      )}

      {/* Env */}
      <div className="mcp-edit-row">
        <label className="mcp-edit-label">Environment</label>
        <textarea
          className="mcp-edit-textarea"
          value={envText}
          onChange={(e) => updateEnv(e.target.value)}
          placeholder="KEY=value"
          rows={2}
          spellCheck={false}
        />
      </div>

      {/* Actions */}
      <div className="mcp-edit-actions">
        <button className="mcp-edit-btn mcp-edit-btn--save" onClick={onSave}>
          <Check size={14} />
          <span>Save</span>
        </button>
        <button className="mcp-edit-btn mcp-edit-btn--cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
