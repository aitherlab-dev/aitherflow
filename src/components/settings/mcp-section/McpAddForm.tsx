import { useCallback, useState } from "react";
import { useMcpStore } from "../../../stores/mcpStore";
import type { McpServerConfig } from "../../../types/mcp";
import type { McpScope } from "./types";
import { McpEditForm } from "./McpEditForm";

export function McpAddForm({
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
      console.error("Failed to add MCP server:", e);
      setError("Failed to add server. Check console for details.");
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
