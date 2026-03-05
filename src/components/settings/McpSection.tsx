import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Plus,
  Trash2,
  Play,
  Check,
  AlertCircle,
  Loader2,
  RotateCcw,
  ExternalLink,
} from "lucide-react";
import { useMcpStore } from "../../stores/mcpStore";
import { useAgentStore } from "../../stores/agentStore";
import type { McpServer, McpServerConfig } from "../../types/mcp";

type McpScope = "global" | "project";

// ── Server card ──

const McpServerCard = memo(function McpServerCard({
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
                    {k}={v.length > 20 ? v.slice(0, 20) + "…" : v}
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
                    {k}: {v.length > 30 ? v.slice(0, 30) + "…" : v}
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

// ── Edit form (used for both add and edit) ──

function McpEditForm({
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

// ── Add server form ──

function McpAddForm({
  scope,
  projectDir,
  onDone,
}: {
  scope: McpScope;
  projectDir?: string;
  onDone: () => void;
}) {
  const addServer = useMcpStore((s) => s.addServer);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<McpServerConfig>({
    serverType: "stdio",
    env: {},
  });
  const [error, setError] = useState("");

  const handleSave = useCallback(async () => {
    const trimName = name.trim();
    if (!trimName) {
      setError("Name is required");
      return;
    }
    setError("");
    try {
      await addServer(scope, trimName, config, projectDir);
      onDone();
    } catch (e) {
      setError(String(e));
    }
  }, [name, config, scope, projectDir, addServer, onDone]);

  return (
    <div className="mcp-add-form">
      {error && <p className="mcp-add-error">{error}</p>}
      <McpEditForm
        config={config}
        onChange={setConfig}
        onSave={handleSave}
        onCancel={onDone}
        nameValue={name}
        onNameChange={setName}
      />
    </div>
  );
}

// ── Main section ──

export function McpSection() {
  const [scope, setScope] = useState<McpScope>("project");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [strict, setStrict] = useState(false);

  const globalServers = useMcpStore((s) => s.global);
  const projectServers = useMcpStore((s) => s.project);
  const globalPath = useMcpStore((s) => s.globalPath);
  const projectPath = useMcpStore((s) => s.projectPath);
  const needsReload = useMcpStore((s) => s.needsReload);
  const load = useMcpStore((s) => s.load);
  const removeServer = useMcpStore((s) => s.removeServer);
  const testServer = useMcpStore((s) => s.testServer);
  const testing = useMcpStore((s) => s.testing);
  const testResults = useMcpStore((s) => s.testResults);
  const resetChoices = useMcpStore((s) => s.resetChoices);
  const getActiveAgent = useAgentStore((s) => s.getActiveAgent);

  const projectDir = useMemo(() => {
    const agent = getActiveAgent();
    return agent?.projectPath;
  }, [getActiveAgent]);

  useEffect(() => {
    if (needsReload(projectDir)) {
      load(projectDir).catch(console.error);
    }
  }, [needsReload, load, projectDir]);

  const servers = scope === "global" ? globalServers : projectServers;
  const configPath = scope === "global" ? globalPath : projectPath;

  const toggleExpand = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleRemove = useCallback(
    (name: string) => {
      removeServer(scope, name, projectDir).catch(console.error);
    },
    [scope, projectDir, removeServer],
  );

  const handleTest = useCallback(
    (server: McpServer) => {
      testServer(server.name, {
        serverType: server.serverType,
        command: server.command,
        args: server.args,
        url: server.url,
        headers: server.headers,
        env: server.env,
      }).catch(console.error);
    },
    [testServer],
  );

  const handleResetChoices = useCallback(() => {
    if (projectDir) {
      resetChoices(projectDir).catch(console.error);
    }
  }, [projectDir, resetChoices]);

  const handleAddDone = useCallback(() => {
    setAdding(false);
  }, []);

  return (
    <div className="mcp-section">
      {/* Header bar */}
      <div className="mcp-header">
        <div className="mcp-tabs">
          <button
            className={`mcp-tab ${scope === "global" ? "mcp-tab--active" : ""}`}
            onClick={() => setScope("global")}
          >
            Global ({globalServers.length})
          </button>
          <button
            className={`mcp-tab ${scope === "project" ? "mcp-tab--active" : ""}`}
            onClick={() => setScope("project")}
          >
            Project ({projectServers.length})
          </button>
        </div>

        <div className="mcp-header-actions">
          <label className="mcp-strict-toggle">
            <input
              type="checkbox"
              checked={strict}
              onChange={(e) => setStrict(e.target.checked)}
            />
            <span>Strict</span>
          </label>
          <button
            className="mcp-header-btn"
            onClick={() => setAdding(true)}
            disabled={adding}
          >
            <Plus size={14} />
            <span>Add Server</span>
          </button>
        </div>
      </div>

      {/* Config path info */}
      {configPath && (
        <div className="mcp-info-bar">
          <span className="mcp-info-path">
            {scope === "project" ? "Project servers" : "Global servers"} — {configPath}
          </span>
          {scope === "project" && projectDir && (
            <button className="mcp-info-btn" onClick={handleResetChoices}>
              <RotateCcw size={12} />
              <span>Reset choices</span>
            </button>
          )}
        </div>
      )}

      {/* Add form */}
      {adding && (
        <McpAddForm scope={scope} projectDir={projectDir} onDone={handleAddDone} />
      )}

      {/* Server list */}
      {servers.length === 0 && !adding ? (
        <div className="mcp-empty">
          No {scope} MCP servers configured
        </div>
      ) : (
        <div className="mcp-list">
          {servers.map((s) => (
            <McpServerCard
              key={s.name}
              server={s}
              scope={scope}
              expanded={expanded.has(s.name)}
              onToggle={() => toggleExpand(s.name)}
              onRemove={() => handleRemove(s.name)}
              onTest={() => handleTest(s)}
              isTesting={testing.has(s.name)}
              testResult={testResults.get(s.name)}
              projectDir={projectDir}
            />
          ))}
        </div>
      )}

      {/* Resources */}
      <McpResources />
    </div>
  );
}

// ── Resources block ──

const MCP_RESOURCES = [
  {
    name: "Official MCP Servers",
    url: "https://github.com/modelcontextprotocol/servers",
    desc: "Anthropic's official collection",
  },
  {
    name: "Awesome MCP Servers",
    url: "https://github.com/punkpeye/awesome-mcp-servers",
    desc: "Community-curated list",
  },
  {
    name: "Glama MCP Directory",
    url: "https://glama.ai/mcp/servers",
    desc: "Searchable catalog with descriptions",
  },
  {
    name: "mcp.so",
    url: "https://mcp.so",
    desc: "MCP server registry",
  },
  {
    name: "Smithery",
    url: "https://smithery.ai",
    desc: "MCP server marketplace",
  },
];

const McpResources = memo(function McpResources() {
  return (
    <div className="mcp-resources">
      <h4 className="mcp-resources-title">Where to find MCP servers</h4>
      <div className="mcp-resources-list">
        {MCP_RESOURCES.map((r) => (
          <a
            key={r.url}
            className="mcp-resource-link"
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="mcp-resource-name">{r.name}</span>
            <ExternalLink size={11} className="mcp-resource-icon" />
            <span className="mcp-resource-desc">{r.desc}</span>
          </a>
        ))}
      </div>
    </div>
  );
});
