import { memo, useCallback, useState } from "react";
import {
  ChevronRight,
  Trash2,
  Play,
  Check,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { useMcpStore } from "../../../stores/mcpStore";
import type { McpServer, McpServerConfig } from "../../../types/mcp";
import type { McpScope } from "./types";
import { McpEditForm } from "./McpEditForm";

export const McpServerCard = memo(function McpServerCard({
  server,
  scope,
  expanded,
  onToggle,
  onRemove,
  onTest,
  isTesting,
  testResult,
  projectDir,
}: {
  server: McpServer;
  scope: McpScope;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onTest: () => void;
  isTesting: boolean;
  testResult?: { ok: boolean; message: string };
  projectDir?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editConfig, setEditConfig] = useState<McpServerConfig | null>(null);
  const addServer = useMcpStore((s) => s.addServer);
  const removeServer = useMcpStore((s) => s.removeServer);

  const startEdit = useCallback(() => {
    setEditConfig({
      serverType: server.serverType,
      command: server.command,
      args: server.args,
      url: server.url,
      headers: server.headers,
      env: server.env,
    });
    setEditing(true);
  }, [server]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setEditConfig(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editConfig) return;
    try {
      // Remove old and add updated
      await removeServer(scope, server.name, projectDir);
      await addServer(scope, server.name, editConfig, projectDir);
      setEditing(false);
      setEditConfig(null);
    } catch (e) {
      console.error("Failed to update server:", e);
    }
  }, [editConfig, scope, server.name, projectDir, removeServer, addServer]);

  const summary =
    server.serverType === "stdio"
      ? server.command || ""
      : server.url || "";

  return (
    <div className="mcp-card">
      <div className="mcp-card-header" onClick={onToggle}>
        <ChevronRight
          size={14}
          className={`mcp-card-chevron ${expanded ? "mcp-card-chevron--open" : ""}`}
        />
        <span className="mcp-card-name">{server.name}</span>
        <span className="mcp-badge mcp-badge--type">{server.serverType}</span>
        <span className="mcp-card-summary">{summary}</span>
      </div>

      {expanded && !editing && (
        <div className="mcp-card-body">
          {server.serverType === "stdio" && (
            <>
              {server.command && (
                <div className="mcp-card-field">
                  <span className="mcp-card-label">Command</span>
                  <span className="mcp-card-value">{server.command}</span>
                </div>
              )}
              {server.args && server.args.length > 0 && (
                <div className="mcp-card-field">
                  <span className="mcp-card-label">Args</span>
                  <span className="mcp-card-value">{server.args.join(" ")}</span>
                </div>
              )}
            </>
          )}
          {(server.serverType === "sse" || server.serverType === "http") && server.url && (
            <div className="mcp-card-field">
              <span className="mcp-card-label">URL</span>
              <span className="mcp-card-value">{server.url}</span>
            </div>
          )}
          {Object.keys(server.env).length > 0 && (
            <div className="mcp-card-field">
              <span className="mcp-card-label">Environment</span>
              <div className="mcp-card-env">
                {Object.entries(server.env).map(([k, v]) => (
                  <span key={k} className="mcp-card-env-entry">
                    {k}={/KEY|TOKEN|SECRET|PASSWORD/i.test(k) ? "****" : v.length > 20 ? v.slice(0, 20) + "…" : v}
                  </span>
                ))}
              </div>
            </div>
          )}
          {server.headers && Object.keys(server.headers).length > 0 && (
            <div className="mcp-card-field">
              <span className="mcp-card-label">Headers</span>
              <div className="mcp-card-env">
                {Object.entries(server.headers).map(([k, v]) => (
                  <span key={k} className="mcp-card-env-entry">
                    {k}: {/^authorization$/i.test(k) ? "Bearer ****" : v.length > 30 ? v.slice(0, 30) + "…" : v}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div className={`mcp-test-result ${testResult.ok ? "mcp-test-result--ok" : "mcp-test-result--fail"}`}>
              {testResult.ok ? <Check size={14} /> : <AlertCircle size={14} />}
              <span>{testResult.message}</span>
            </div>
          )}

          {/* Actions */}
          <div className="mcp-card-actions">
            <button
              className="mcp-card-btn mcp-card-btn--test"
              onClick={onTest}
              disabled={isTesting}
            >
              {isTesting ? <Loader2 size={14} className="spinning" /> : <Play size={14} />}
              <span>{isTesting ? "Testing..." : "Test"}</span>
            </button>
            <button className="mcp-card-btn" onClick={startEdit}>
              Edit
            </button>
            <button className="mcp-card-btn mcp-card-btn--danger" onClick={onRemove}>
              <Trash2 size={14} />
              <span>Delete</span>
            </button>
          </div>
        </div>
      )}

      {expanded && editing && editConfig && (
        <div className="mcp-card-body">
          <McpEditForm
            config={editConfig}
            onChange={setEditConfig}
            onSave={saveEdit}
            onCancel={cancelEdit}
          />
        </div>
      )}
    </div>
  );
});
