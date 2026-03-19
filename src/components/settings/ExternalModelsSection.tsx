import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "../../lib/transport";
import { Eye, EyeOff, RefreshCw, Play, Square } from "lucide-react";
import type {
  Provider,
  ExternalModelsConfigWithKeys,
  McpStatus,
  ModelInfo,
} from "../../types/external-models";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "openrouter", label: "OpenRouter" },
  { id: "groq", label: "Groq" },
];

interface ProviderState {
  enabled: boolean;
  apiKey: string;
  defaultModel: string;
  models: ModelInfo[];
  modelsLoading: boolean;
  testResult: { ok: boolean; message: string } | null;
  testing: boolean;
}

function defaultProviderState(): ProviderState {
  return {
    enabled: false,
    apiKey: "",
    defaultModel: "",
    models: [],
    modelsLoading: false,
    testResult: null,
    testing: false,
  };
}

export function ExternalModelsSection() {
  const [providers, setProviders] = useState<Record<Provider, ProviderState>>({
    openrouter: defaultProviderState(),
    groq: defaultProviderState(),
  });
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({
    running: false,
    port: null,
  });
  const [mcpLoading, setMcpLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showKeys, setShowKeys] = useState<Record<Provider, boolean>>({
    openrouter: false,
    groq: false,
  });

  const realKeysRef = useRef<Record<Provider, string>>({
    openrouter: "",
    groq: "",
  });

  // Load config and MCP status
  useEffect(() => {
    Promise.all([
      invoke<ExternalModelsConfigWithKeys>("external_models_load_config"),
      invoke<McpStatus>("external_models_mcp_status"),
    ])
      .then(([cfg, status]) => {
        realKeysRef.current = {
          openrouter: cfg.openrouterApiKey,
          groq: cfg.groqApiKey,
        };

        const updated: Record<Provider, ProviderState> = {
          openrouter: defaultProviderState(),
          groq: defaultProviderState(),
        };

        for (const p of cfg.providers) {
          const id = p.provider as Provider;
          if (updated[id]) {
            updated[id].enabled = p.enabled;
            updated[id].defaultModel = p.defaultModel;
          }
        }

        updated.openrouter.apiKey = cfg.openrouterApiKey;
        updated.groq.apiKey = cfg.groqApiKey;

        setProviders(updated);
        setMcpStatus(status);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  // Save config (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(saveTimerRef.current), []);

  const save = useCallback((updated: Record<Provider, ProviderState>) => {
    setProviders(updated);
    clearTimeout(saveTimerRef.current);

    // Track real keys
    for (const id of ["openrouter", "groq"] as Provider[]) {
      const key = updated[id].apiKey;
      if (key && !key.startsWith("****")) {
        realKeysRef.current[id] = key;
      }
    }

    saveTimerRef.current = setTimeout(() => {
      const providersConfig = PROVIDERS.map(({ id }) => ({
        provider: id,
        enabled: updated[id].enabled,
        defaultModel: updated[id].defaultModel,
      }));

      const orKey = realKeysRef.current.openrouter;
      const grKey = realKeysRef.current.groq;

      invoke("external_models_save_config", {
        providersConfig: { providers: providersConfig },
        openrouterApiKey: orKey.startsWith("****") ? null : orKey || null,
        groqApiKey: grKey.startsWith("****") ? null : grKey || null,
      }).catch(console.error);
    }, 400);
  }, []);

  const updateProvider = useCallback(
    (id: Provider, patch: Partial<ProviderState>) => {
      const updated = {
        ...providers,
        [id]: { ...providers[id], ...patch },
      };
      save(updated);
    },
    [providers, save],
  );

  const testConnection = useCallback(
    (id: Provider) => {
      setProviders((prev) => ({
        ...prev,
        [id]: { ...prev[id], testing: true, testResult: null },
      }));

      invoke<string>("external_models_test_connection", { provider: id })
        .then((reply) => {
          setProviders((prev) => ({
            ...prev,
            [id]: {
              ...prev[id],
              testing: false,
              testResult: { ok: true, message: reply },
            },
          }));
        })
        .catch((e) => {
          setProviders((prev) => ({
            ...prev,
            [id]: {
              ...prev[id],
              testing: false,
              testResult: { ok: false, message: String(e) },
            },
          }));
        });
    },
    [],
  );

  const loadModels = useCallback(
    (id: Provider) => {
      setProviders((prev) => ({
        ...prev,
        [id]: { ...prev[id], modelsLoading: true },
      }));

      invoke<ModelInfo[]>("external_models_list_models", { provider: id })
        .then((models) => {
          setProviders((prev) => ({
            ...prev,
            [id]: { ...prev[id], models, modelsLoading: false },
          }));
        })
        .catch((e) => {
          console.error(`Failed to load models for ${id}:`, e);
          setProviders((prev) => ({
            ...prev,
            [id]: { ...prev[id], modelsLoading: false },
          }));
        });
    },
    [],
  );

  const toggleMcp = useCallback(() => {
    setMcpLoading(true);
    if (mcpStatus.running) {
      invoke("external_models_stop_mcp")
        .then(() => setMcpStatus({ running: false, port: null }))
        .catch(console.error)
        .finally(() => setMcpLoading(false));
    } else {
      invoke<number>("external_models_start_mcp")
        .then((port) => setMcpStatus({ running: true, port }))
        .catch(console.error)
        .finally(() => setMcpLoading(false));
    }
  }, [mcpStatus]);

  if (!loaded) return null;

  return (
    <div className="settings-section-general">
      {/* Providers */}
      {PROVIDERS.map(({ id, label }) => (
        <ProviderBlock
          key={id}
          id={id}
          label={label}
          state={providers[id]}
          showKey={showKeys[id]}
          onToggleShowKey={() =>
            setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }))
          }
          onUpdate={(patch) => updateProvider(id, patch)}
          onTest={() => testConnection(id)}
          onLoadModels={() => loadModels(id)}
        />
      ))}

      {/* MCP Server */}
      <div style={{ marginTop: "16px" }}>
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">MCP Server</span>
            <span className="settings-toggle-desc">
              {mcpStatus.running
                ? `Running on port ${mcpStatus.port}. Claude CLI can use external models as tools.`
                : "Start to expose external models as MCP tools for Claude CLI."}
            </span>
          </div>
          <button
            className="settings-btn"
            onClick={toggleMcp}
            disabled={mcpLoading}
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
          >
            {mcpStatus.running ? <Square size={14} /> : <Play size={14} />}
            {mcpLoading
              ? "..."
              : mcpStatus.running
                ? "Stop"
                : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider sub-component
// ---------------------------------------------------------------------------

function ProviderBlock({
  id,
  label,
  state,
  showKey,
  onToggleShowKey,
  onUpdate,
  onTest,
  onLoadModels,
}: {
  id: Provider;
  label: string;
  state: ProviderState;
  showKey: boolean;
  onToggleShowKey: () => void;
  onUpdate: (patch: Partial<ProviderState>) => void;
  onTest: () => void;
  onLoadModels: () => void;
}) {
  return (
    <div style={{ marginBottom: "16px" }}>
      {/* Enable toggle */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">{label}</span>
          <span className="settings-toggle-desc">
            {id === "openrouter"
              ? "Access 200+ models via OpenRouter (GPT-4o, Gemini, Llama, etc.)"
              : "Fast inference on Groq hardware (Llama, Mixtral, Gemma)"}
          </span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={() => onUpdate({ enabled: !state.enabled })}
          />
          <span className="toggle-switch-track" />
        </label>
      </div>

      {state.enabled && (
        <>
          {/* API key */}
          <div className="webserver-field">
            <label className="webserver-field-label">API Key</label>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                type={showKey ? "text" : "password"}
                className="webserver-input"
                value={state.apiKey}
                onChange={(e) => onUpdate({ apiKey: e.target.value })}
                placeholder={
                  id === "openrouter"
                    ? "sk-or-v1-..."
                    : "gsk_..."
                }
                autoComplete="off"
                style={{ flex: 1 }}
              />
              <button
                className="settings-btn-icon"
                onClick={onToggleShowKey}
                title={showKey ? "Hide" : "Show"}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              <button
                className="settings-btn"
                onClick={onTest}
                disabled={state.testing || !state.apiKey}
                style={{ whiteSpace: "nowrap" }}
              >
                {state.testing ? "Testing..." : "Test"}
              </button>
            </div>
            {state.testResult && (
              <span
                className="webserver-note"
                style={{
                  color: state.testResult.ok
                    ? "var(--accent)"
                    : "var(--error)",
                }}
              >
                {state.testResult.ok
                  ? `Connected — "${state.testResult.message}"`
                  : state.testResult.message}
              </span>
            )}
          </div>

          {/* Models */}
          <div className="webserver-field">
            <label className="webserver-field-label">Default Model</label>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              {state.models.length > 0 ? (
                <select
                  className="settings-select"
                  value={state.defaultModel}
                  onChange={(e) => onUpdate({ defaultModel: e.target.value })}
                  style={{ flex: 1 }}
                >
                  <option value="">— Select model —</option>
                  {state.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}
                      {m.context_length
                        ? ` (${Math.round(m.context_length / 1000)}k)`
                        : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className="webserver-input"
                  value={state.defaultModel}
                  onChange={(e) => onUpdate({ defaultModel: e.target.value })}
                  placeholder="e.g. openai/gpt-4o"
                  style={{ flex: 1 }}
                />
              )}
              <button
                className="settings-btn"
                onClick={onLoadModels}
                disabled={state.modelsLoading || !state.apiKey}
                title="Load available models"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  whiteSpace: "nowrap",
                }}
              >
                <RefreshCw
                  size={14}
                  className={state.modelsLoading ? "spinning" : ""}
                />
                {state.modelsLoading ? "Loading..." : "Load Models"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
