import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import type { VisionProfile, VisionStrategy } from "../../types/external-models";
import {
  useExternalModelsSettings,
  type ProviderState,
} from "../../hooks/useExternalModelsSettings";

// --- Strategy / resolution constants for VisionSettingsBlock ---

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

const PROVIDER_TYPES = [
  { value: "openai_compatible", label: "OpenAI Compatible" },
  { value: "ollama", label: "Ollama" },
];

// --- Main component ---

export function ExternalModelsSection() {
  const {
    providers,
    visionProfile,
    mcpStatus,
    mcpLoading,
    loaded,
    showKeys,
    actions,
  } = useExternalModelsSettings();

  if (!loaded) return null;

  return (
    <div className="settings-section-general">
      {/* MCP Server */}
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
          onClick={actions.toggleMcp}
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

      {/* Providers */}
      {providers.map((p) => (
        <ProviderCard
          key={p.id}
          state={p}
          showKey={showKeys[p.id] || false}
          onToggleShowKey={() => actions.toggleShowKey(p.id)}
          onToggleCollapsed={() => actions.toggleCollapsed(p.id)}
          onUpdate={(patch) => actions.updateProvider(p.id, patch)}
          onTest={() => actions.testConnection(p.id)}
          onLoadModels={() => actions.loadModels(p.id)}
          onRemove={() => actions.removeProvider(p.id)}
        />
      ))}

      {/* Add Provider */}
      <button
        className="settings-btn"
        onClick={actions.addProvider}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          marginTop: "12px",
        }}
      >
        <Plus size={14} />
        Add Provider
      </button>

      {/* Vision Settings */}
      <VisionSettingsBlock
        profile={visionProfile}
        onUpdate={actions.saveVisionProfile}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider card sub-component
// ---------------------------------------------------------------------------

function ProviderCard({
  state,
  showKey,
  onToggleShowKey,
  onToggleCollapsed,
  onUpdate,
  onTest,
  onLoadModels,
  onRemove,
}: {
  state: ProviderState;
  showKey: boolean;
  onToggleShowKey: () => void;
  onToggleCollapsed: () => void;
  onUpdate: (patch: Partial<ProviderState>) => void;
  onTest: () => void;
  onLoadModels: () => void;
  onRemove: () => void;
}) {
  const isOllama = state.providerType === "ollama";

  return (
    <div style={{ marginTop: "12px" }}>
      {/* Header — always visible */}
      <div className="settings-toggle-row" style={{ cursor: "pointer" }}>
        <div
          className="settings-toggle-info"
          onClick={onToggleCollapsed}
          style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1 }}
        >
          {state.collapsed ? (
            <ChevronRight size={16} style={{ flexShrink: 0 }} />
          ) : (
            <ChevronDown size={16} style={{ flexShrink: 0 }} />
          )}
          <span className="settings-toggle-label">
            {state.name || "New Provider"}
          </span>
          {state.collapsed && state.defaultModel && (
            <span
              className="settings-toggle-desc"
              style={{ marginLeft: "auto", fontSize: "12px" }}
            >
              {state.defaultModel}
            </span>
          )}
        </div>
        <label className="toggle-switch" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={() => onUpdate({ enabled: !state.enabled })}
          />
          <span className="toggle-switch-track" />
        </label>
      </div>

      {/* Expanded content */}
      {!state.collapsed && (
        <div style={{ paddingLeft: "24px" }}>
          {/* Name */}
          <div className="webserver-field">
            <label className="webserver-field-label">Name</label>
            <input
              type="text"
              className="webserver-input"
              value={state.name}
              onChange={(e) => onUpdate({ name: e.target.value })}
              placeholder="e.g. OpenRouter, My Ollama"
              style={{ width: "300px" }}
            />
          </div>

          {/* Provider Type */}
          <div className="webserver-field">
            <label className="webserver-field-label">Type</label>
            <select
              className="settings-select"
              value={state.providerType}
              onChange={(e) =>
                onUpdate({
                  providerType: e.target.value,
                  requiresApiKey: e.target.value !== "ollama",
                })
              }
              style={{ width: "200px" }}
            >
              {PROVIDER_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Base URL */}
          <div className="webserver-field">
            <label className="webserver-field-label">Base URL</label>
            <input
              type="text"
              className="webserver-input"
              value={state.baseUrl}
              onChange={(e) => onUpdate({ baseUrl: e.target.value })}
              placeholder={
                isOllama
                  ? "http://localhost:11434"
                  : "https://openrouter.ai/api/v1"
              }
              style={{ flex: 1 }}
            />
          </div>

          {/* API Key (if required) */}
          {state.requiresApiKey && (
            <div className="webserver-field">
              <label className="webserver-field-label">API Key</label>
              <div
                style={{ display: "flex", gap: "8px", alignItems: "center" }}
              >
                <input
                  type={showKey ? "text" : "password"}
                  className="webserver-input"
                  value={state.apiKey}
                  onChange={(e) => onUpdate({ apiKey: e.target.value })}
                  placeholder="sk-..."
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
              </div>
            </div>
          )}

          {/* Default Model */}
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
                disabled={
                  state.modelsLoading ||
                  (!isOllama && !state.apiKey) ||
                  !state.baseUrl
                }
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

          {/* Test + Delete */}
          <div
            style={{
              display: "flex",
              gap: "8px",
              alignItems: "center",
              marginTop: "8px",
            }}
          >
            <button
              className="settings-btn"
              onClick={onTest}
              disabled={
                state.testing ||
                (state.requiresApiKey && !state.apiKey) ||
                !state.baseUrl
              }
              style={{ whiteSpace: "nowrap" }}
            >
              {state.testing ? "Testing..." : "Test Connection"}
            </button>
            <button
              className="settings-btn-icon"
              onClick={onRemove}
              title="Remove provider"
              style={{ color: "var(--error)", marginLeft: "auto" }}
            >
              <Trash2 size={16} />
            </button>
          </div>

          {state.testResult && (
            <span
              className="webserver-note"
              style={{
                color: state.testResult.ok
                  ? "var(--accent)"
                  : "var(--error)",
                marginTop: "4px",
                display: "block",
              }}
            >
              {state.testResult.ok
                ? `Connected — "${state.testResult.message}"`
                : state.testResult.message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vision Settings sub-component
// ---------------------------------------------------------------------------

function VisionSettingsBlock({
  profile,
  onUpdate,
}: {
  profile: VisionProfile;
  onUpdate: (profile: VisionProfile) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const showFrameSettings = profile.strategy !== "native_video";

  return (
    <div style={{ marginTop: "16px" }}>
      <div
        className="settings-toggle-row"
        style={{ cursor: "pointer" }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <div
          className="settings-toggle-info"
          style={{ display: "flex", alignItems: "center", gap: "8px" }}
        >
          {collapsed ? (
            <ChevronRight size={16} style={{ flexShrink: 0 }} />
          ) : (
            <ChevronDown size={16} style={{ flexShrink: 0 }} />
          )}
          <span className="settings-toggle-label">Vision Settings</span>
          <span className="settings-toggle-desc">
            How video files are processed for vision analysis.
          </span>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Strategy */}
          <div className="webserver-field">
            <label className="webserver-field-label">Strategy</label>
            <select
              className="settings-select"
              value={profile.strategy}
              onChange={(e) =>
                onUpdate({
                  ...profile,
                  strategy: e.target.value as VisionStrategy,
                })
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
                      framesPerClip:
                        val === "" ? null : parseInt(val, 10) || null,
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
                  <span className="settings-toggle-label">
                    Scene detection
                  </span>
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
                    onUpdate({
                      ...profile,
                      resolution: parseInt(e.target.value, 10),
                    })
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
        </>
      )}
    </div>
  );
}

