import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Plus, RotateCcw } from "lucide-react";
import { useMcpStore } from "../../../stores/mcpStore";
import { useAgentStore } from "../../../stores/agentStore";
import type { McpServer } from "../../../types/mcp";
import type { McpScope } from "./types";
import { McpServerCard } from "./McpServerCard";
import { McpAddForm } from "./McpAddForm";
import { McpResources } from "./McpResources";

export function McpSection() {
  const [scope, setScope] = useState<McpScope>("project");
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [strict, setStrict] = useState(false);

  const globalServers = useMcpStore(useShallow((s) => s.global));
  const projectServers = useMcpStore(useShallow((s) => s.project));
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
