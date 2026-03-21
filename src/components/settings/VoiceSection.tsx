import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "../../lib/transport";
import { invalidateSettingsCache } from "../../stores/chatService";
import { Tooltip } from "../shared/Tooltip";

import type { AppSettings } from "../../types/settings";

/** Keys kept separate from AppSettings — only loaded in this component */
interface VoiceSettings extends AppSettings {
  groqApiKey: string;
  deepgramApiKey: string;
}

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
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [authStatus, setAuthStatus] = useState<AnthropicAuthStatus | null>(null);
  /** Real API keys kept out of React state (not visible in DevTools) */
  const realGroqKeyRef = useRef<string>("");
  const realDeepgramKeyRef = useRef<string>("");

  useEffect(() => {
    invoke<VoiceSettings>("load_settings")
      .then((s) => {
        realGroqKeyRef.current = s.groqApiKey || "";
        realDeepgramKeyRef.current = s.deepgramApiKey || "";
        const maskedGroq = s.groqApiKey ? `****${s.groqApiKey.slice(-4)}` : "";
        const maskedDeepgram = s.deepgramApiKey ? `****${s.deepgramApiKey.slice(-4)}` : "";
        setSettings({ ...s, groqApiKey: maskedGroq, deepgramApiKey: maskedDeepgram });
      })
      .catch(console.error);
    invoke<AnthropicAuthStatus>("voice_check_anthropic_auth")
      .then(setAuthStatus)
      .catch(console.error);
  }, []);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(saveTimerRef.current), []);
  const save = useCallback((updated: VoiceSettings) => {
    setSettings(updated);
    invalidateSettingsCache();
    // Resolve real keys: if user entered a new value (not masked), use it; otherwise keep existing
    const groqKey = updated.groqApiKey;
    if (groqKey && !groqKey.startsWith("****")) {
      realGroqKeyRef.current = groqKey;
    } else if (!groqKey) {
      realGroqKeyRef.current = "";
    }
    const dgKey = updated.deepgramApiKey;
    if (dgKey && !dgKey.startsWith("****")) {
      realDeepgramKeyRef.current = dgKey;
    } else if (!dgKey) {
      realDeepgramKeyRef.current = "";
    }
    const toSave = { ...updated, groqApiKey: realGroqKeyRef.current, deepgramApiKey: realDeepgramKeyRef.current };
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      invoke("save_settings", { settings: toSave }).catch(console.error);
    }, 400);
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
              <Tooltip text={showKey ? "Hide" : "Show"}>
                <button
                  className="settings-input-toggle"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </Tooltip>
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
            <Tooltip text={showKey ? "Hide" : "Show"}>
              <button
                className="settings-input-toggle"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </Tooltip>
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
