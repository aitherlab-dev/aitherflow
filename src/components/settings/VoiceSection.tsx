import { useState, useEffect, useCallback } from "react";
import { invoke } from "../../lib/transport";

import type { AppSettings } from "../../types/settings";

interface AnthropicAuthStatus {
  available: boolean;
  expired: boolean;
}

const LANGUAGES = [
  { value: "", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "ru", label: "Russian" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
  { value: "ko", label: "Korean" },
  { value: "pt", label: "Portuguese" },
  { value: "it", label: "Italian" },
  { value: "uk", label: "Ukrainian" },
];

const POST_MODELS = [
  { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (recommended)" },
  { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B (faster)" },
];

export function VoiceSection() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [authStatus, setAuthStatus] = useState<AnthropicAuthStatus | null>(null);

  useEffect(() => {
    invoke<AppSettings>("load_settings")
      .then(setSettings)
      .catch(console.error);
    invoke<AnthropicAuthStatus>("voice_check_anthropic_auth")
      .then(setAuthStatus)
      .catch(console.error);
  }, []);

  const save = useCallback((updated: AppSettings) => {
    setSettings(updated);
    invoke("save_settings", { settings: updated }).catch(console.error);
  }, []);

  if (!settings) return null;

  const provider = settings.voiceProvider || "groq";

  return (
    <div className="settings-section-general">
      {/* Provider selector */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Voice provider</span>
          <span className="settings-toggle-desc">
            Groq — record and transcribe. Deepgram / Anthropic — realtime streaming.
          </span>
        </div>
        <select
          className="settings-select"
          value={provider}
          onChange={(e) => save({ ...settings, voiceProvider: e.target.value })}
        >
          <option value="groq">Groq Whisper</option>
          <option value="deepgram">Deepgram (streaming)</option>
          <option value="anthropic">Anthropic (streaming)</option>
        </select>
      </div>

      {/* Groq settings */}
      {provider === "groq" && (
        <>
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Groq API Key</span>
              <span className="settings-toggle-desc">
                Required for voice transcription. Get one at{" "}
                <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">
                  console.groq.com
                </a>
              </span>
            </div>
            <div className="settings-input-row">
              <input
                type={showKey ? "text" : "password"}
                className="settings-input"
                value={settings.groqApiKey}
                onChange={(e) => save({ ...settings, groqApiKey: e.target.value })}
                placeholder="gsk_..."
                spellCheck={false}
                autoComplete="off"
              />
              <button
                className="settings-input-toggle"
                onClick={() => setShowKey(!showKey)}
                title={showKey ? "Hide" : "Show"}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">LLM Post-processing</span>
              <span className="settings-toggle-desc">
                Add punctuation, fix grammar, format paragraphs
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings.voicePostProcess ?? true}
                onChange={() => save({ ...settings, voicePostProcess: !settings.voicePostProcess })}
              />
              <span className="toggle-switch-track" />
            </label>
          </div>

          {settings.voicePostProcess !== false && (
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Post-processing model</span>
              </div>
              <select
                className="settings-select"
                value={settings.voicePostModel || "llama-3.3-70b-versatile"}
                onChange={(e) => save({ ...settings, voicePostModel: e.target.value })}
              >
                {POST_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
      )}

      {/* Deepgram settings */}
      {provider === "deepgram" && (
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Deepgram API Key</span>
            <span className="settings-toggle-desc">
              Required for streaming transcription. Get one at{" "}
              <a href="https://console.deepgram.com" target="_blank" rel="noopener noreferrer">
                console.deepgram.com
              </a>
            </span>
          </div>
          <div className="settings-input-row">
            <input
              type={showKey ? "text" : "password"}
              className="settings-input"
              value={settings.deepgramApiKey}
              onChange={(e) => save({ ...settings, deepgramApiKey: e.target.value })}
              placeholder="..."
              spellCheck={false}
              autoComplete="off"
            />
            <button
              className="settings-input-toggle"
              onClick={() => setShowKey(!showKey)}
              title={showKey ? "Hide" : "Show"}
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
        </div>
      )}

      {/* Anthropic settings */}
      {provider === "anthropic" && (
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Claude CLI login</span>
            <span className="settings-toggle-desc">
              {authStatus === null
                ? "Checking..."
                : authStatus.available
                  ? authStatus.expired
                    ? "Token expired. Run `claude` in terminal to refresh."
                    : "Logged in — ready to use."
                  : "Not logged in. Run `claude` in terminal and log in first."}
            </span>
          </div>
          <span
            className="settings-toggle-label"
            style={{
              color: authStatus?.available && !authStatus?.expired
                ? "var(--accent)"
                : "var(--fg-muted)",
            }}
          >
            {authStatus?.available && !authStatus?.expired ? "Ready" : "Not available"}
          </span>
        </div>
      )}

      {/* Language — shared */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Recognition language</span>
          <span className="settings-toggle-desc">
            {provider === "groq"
              ? "Language hint for Whisper. Auto-detect works for most cases."
              : provider === "deepgram"
                ? "Language for Deepgram STT. Auto-detect works well."
                : "Language for Anthropic STT. Defaults to English."}
          </span>
        </div>
        <select
          className="settings-select"
          value={settings.voiceLanguage}
          onChange={(e) => save({ ...settings, voiceLanguage: e.target.value })}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
