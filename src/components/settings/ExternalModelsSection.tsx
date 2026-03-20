import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "../../lib/transport";
import { Eye, EyeOff, RefreshCw, Play, Square } from "lucide-react";
import type {
  Provider,
  ExternalModelsConfigWithKeys,
  McpStatus,
  ModelInfo,
  VisionProfile,
  VisionStrategy,
} from "../../types/external-models";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "openrouter", label: "OpenRouter" },
  { id: "google", label: "Google Gemini" },
  { id: "ollama", label: "Ollama" },
];

const DEFAULT_VISION_PROFILE: VisionProfile = {
  strategy: "auto",
  framesPerClip: 5,
  fps: null,
  sceneDetection: false,
  sceneThreshold: 0.3,
  resolution: 720,
  jpegQuality: 5,
};

interface ProviderState {
  enabled: boolean;
  apiKey: string;
  defaultModel: string;
  baseUrl: string;
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
    baseUrl: "",
    models: [],
    modelsLoading: false,
    testResult: null,
    testing: false,
  };
}

export function ExternalModelsSection() {
  const [providers, setProviders] = useState<Record<Provider, ProviderState>>({
    openrouter: defaultProviderState(),
    google: defaultProviderState(),
    ollama: defaultProviderState(),
  });
  const [visionProfile, setVisionProfile] = useState<VisionProfile>(
    DEFAULT_VISION_PROFILE,
  );
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({
    running: false,
    port: null,
  });
  const [mcpLoading, setMcpLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [mgmtKey, setMgmtKey] = useState("");
  const [showMgmtKey, setShowMgmtKey] = useState(false);
  const realMgmtKeyRef = useRef("");
  const [showKeys, setShowKeys] = useState<Record<Provider, boolean>>({
    openrouter: false,
    google: false,
    ollama: false,
  });

  const realKeysRef = useRef<Record<Provider, string>>({
    openrouter: "",
    google: "",
    ollama: "",
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
          google: cfg.googleApiKey,
          ollama: "",
        };
        realMgmtKeyRef.current = cfg.openrouterMgmtKey;
        setMgmtKey(cfg.openrouterMgmtKey);

        const updated: Record<Provider, ProviderState> = {
          openrouter: defaultProviderState(),
          google: defaultProviderState(),
          ollama: defaultProviderState(),
        };

        for (const p of cfg.providers) {
          const id = p.provider as Provider;
          if (updated[id]) {
            updated[id].enabled = p.enabled;
            updated[id].defaultModel = p.defaultModel;
            updated[id].baseUrl = p.baseUrl || "";
          }
        }

        updated.openrouter.apiKey = cfg.openrouterApiKey;
        updated.google.apiKey = cfg.googleApiKey;

        setProviders(updated);
        if (cfg.visionProfile) {
          setVisionProfile(cfg.visionProfile);
        }
        setMcpStatus(status);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  // Save config (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(saveTimerRef.current), []);

  const visionProfileRef = useRef(visionProfile);
  visionProfileRef.current = visionProfile;

  const providersRef = useRef(providers);
  providersRef.current = providers;

  const save = useCallback((updated: Record<Provider, ProviderState>) => {
    setProviders(updated);
    clearTimeout(saveTimerRef.current);

    for (const id of ["openrouter", "google", "ollama"] as Provider[]) {
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
        baseUrl: updated[id].baseUrl || null,
      }));

      const orKey = realKeysRef.current.openrouter;
      const mgmt = realMgmtKeyRef.current;
      const gKey = realKeysRef.current.google;

      invoke("external_models_save_config", {
        providersConfig: {
          providers: providersConfig,
          visionProfile: visionProfileRef.current,
        },
        openrouterApiKey: orKey.startsWith("****") ? null : orKey || null,
        openrouterMgmtKey: mgmt.startsWith("****") ? null : mgmt || null,
        googleApiKey: gKey.startsWith("****") ? null : gKey || null,
      }).catch(console.error);
    }, 400);
  }, []);

  const saveVisionProfile = useCallback(
    (profile: VisionProfile) => {
      setVisionProfile(profile);
      visionProfileRef.current = profile;
      // Trigger a save with current providers (via ref to avoid stale closure)
      save({ ...providersRef.current });
    },
    [save],
  );

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

  const testConnection = useCallback((id: Provider) => {
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
  }, []);

  const loadModels = useCallback((id: Provider) => {
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
  }, []);

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
          mgmtKey={id === "openrouter" ? mgmtKey : undefined}
          showMgmtKey={id === "openrouter" ? showMgmtKey : undefined}
          onToggleShowMgmtKey={id === "openrouter" ? () => setShowMgmtKey((v) => !v) : undefined}
          onMgmtKeyChange={id === "openrouter" ? (val: string) => {
            setMgmtKey(val);
            if (val && !val.startsWith("****")) {
              realMgmtKeyRef.current = val;
            }
            // Trigger save
            save({ ...providers });
          } : undefined}
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

      {/* Vision Settings */}
      <VisionSettingsBlock
        profile={visionProfile}
        onUpdate={saveVisionProfile}
      />
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
  mgmtKey,
  showMgmtKey,
  onToggleShowMgmtKey,
  onMgmtKeyChange,
}: {
  id: Provider;
  label: string;
  state: ProviderState;
  showKey: boolean;
  onToggleShowKey: () => void;
  onUpdate: (patch: Partial<ProviderState>) => void;
  onTest: () => void;
  onLoadModels: () => void;
  mgmtKey?: string;
  showMgmtKey?: boolean;
  onToggleShowMgmtKey?: () => void;
  onMgmtKeyChange?: (val: string) => void;
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
              : id === "google"
                ? "Google Gemini models — native vision, video up to 100MB"
                : "Local models via Ollama — no API key required"}
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
          {/* Ollama: server URL; Others: API key */}
          {id === "ollama" ? (
            <div className="webserver-field">
              <label className="webserver-field-label">Server URL</label>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  type="text"
                  className="webserver-input"
                  value={state.baseUrl}
                  onChange={(e) => onUpdate({ baseUrl: e.target.value })}
                  placeholder="http://localhost:11434"
                  style={{ flex: 1 }}
                />
                <button
                  className="settings-btn"
                  onClick={onTest}
                  disabled={state.testing}
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
          ) : (
            <div className="webserver-field">
              <label className="webserver-field-label">API Key</label>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  type={showKey ? "text" : "password"}
                  className="webserver-input"
                  value={state.apiKey}
                  onChange={(e) => onUpdate({ apiKey: e.target.value })}
                  placeholder={
                    id === "openrouter" ? "sk-or-v1-..." : "AIza..."
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
          )}

          {/* Management Key (OpenRouter only) */}
          {mgmtKey !== undefined && onMgmtKeyChange && (
            <div className="webserver-field">
              <label className="webserver-field-label">Management Key (for balance)</label>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  type={showMgmtKey ? "text" : "password"}
                  className="webserver-input"
                  value={mgmtKey}
                  onChange={(e) => onMgmtKeyChange(e.target.value)}
                  placeholder="sk-or-v1-..."
                  autoComplete="off"
                  style={{ flex: 1 }}
                />
                {onToggleShowMgmtKey && (
                  <button
                    className="settings-btn-icon"
                    onClick={onToggleShowMgmtKey}
                    title={showMgmtKey ? "Hide" : "Show"}
                  >
                    {showMgmtKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                )}
              </div>
              <span className="webserver-note">
                Optional. Create at openrouter.ai/settings/keys to show account balance.
              </span>
            </div>
          )}

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
                disabled={state.modelsLoading || (id !== "ollama" && !state.apiKey)}
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

// ---------------------------------------------------------------------------
// Vision Settings sub-component
// ---------------------------------------------------------------------------

const STRATEGY_OPTIONS: { value: VisionStrategy; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "native_video", label: "Native Video" },
  { value: "extract_frames", label: "Extract Frames" },
];

const RESOLUTION_OPTIONS = [
  { value: 360, label: "360p" },
  { value: 720, label: "720p" },
  { value: 1080, label: "1080p" },
];

function VisionSettingsBlock({
  profile,
  onUpdate,
}: {
  profile: VisionProfile;
  onUpdate: (profile: VisionProfile) => void;
}) {
  const showFrameSettings = profile.strategy !== "native_video";

  return (
    <div style={{ marginTop: "16px" }}>
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Vision Settings</span>
          <span className="settings-toggle-desc">
            How video files are processed for vision analysis.
          </span>
        </div>
      </div>

      {/* Strategy */}
      <div className="webserver-field">
        <label className="webserver-field-label">Strategy</label>
        <select
          className="settings-select"
          value={profile.strategy}
          onChange={(e) =>
            onUpdate({ ...profile, strategy: e.target.value as VisionStrategy })
          }
          style={{ width: "240px" }}
        >
          {STRATEGY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="webserver-note">
          {profile.strategy === "auto"
            ? "Gemini models receive native video, others get extracted frames."
            : profile.strategy === "native_video"
              ? "Send video as-is (base64). Best for Gemini. Max 20MB."
              : "Extract frames via ffmpeg and send as images."}
        </span>
      </div>

      {showFrameSettings && (
        <>
          {/* Frames per clip */}
          <div className="webserver-field">
            <label className="webserver-field-label">Frames per clip</label>
            <input
              type="number"
              className="webserver-input"
              value={profile.framesPerClip ?? ""}
              onChange={(e) => {
                const val = e.target.value.trim();
                onUpdate({
                  ...profile,
                  framesPerClip: val === "" ? null : parseInt(val, 10) || null,
                });
              }}
              placeholder="5"
              min={1}
              max={100}
              style={{ width: "100px" }}
            />
          </div>

          {/* Scene detection */}
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Scene detection</span>
              <span className="settings-toggle-desc">
                Use ffmpeg scene change detection instead of fixed intervals.
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={profile.sceneDetection}
                onChange={() =>
                  onUpdate({
                    ...profile,
                    sceneDetection: !profile.sceneDetection,
                  })
                }
              />
              <span className="toggle-switch-track" />
            </label>
          </div>

          {/* Scene threshold */}
          {profile.sceneDetection && (
            <div className="webserver-field">
              <label className="webserver-field-label">
                Scene threshold: {profile.sceneThreshold.toFixed(2)}
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={profile.sceneThreshold}
                onChange={(e) =>
                  onUpdate({
                    ...profile,
                    sceneThreshold: parseFloat(e.target.value),
                  })
                }
                style={{ width: "200px" }}
              />
            </div>
          )}

          {/* Resolution */}
          <div className="webserver-field">
            <label className="webserver-field-label">Resolution</label>
            <select
              className="settings-select"
              value={profile.resolution}
              onChange={(e) =>
                onUpdate({ ...profile, resolution: parseInt(e.target.value, 10) })
              }
              style={{ width: "120px" }}
            >
              {RESOLUTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* JPEG Quality */}
          <div className="webserver-field">
            <label className="webserver-field-label">
              JPEG Quality: {profile.jpegQuality} (lower = better)
            </label>
            <input
              type="range"
              min="2"
              max="31"
              step="1"
              value={profile.jpegQuality}
              onChange={(e) =>
                onUpdate({
                  ...profile,
                  jpegQuality: parseInt(e.target.value, 10),
                })
              }
              style={{ width: "200px" }}
            />
          </div>
        </>
      )}
    </div>
  );
}
