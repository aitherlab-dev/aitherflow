import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff } from "lucide-react";
import { invoke } from "../../lib/transport";

interface TelegramConfig {
  bot_token: string | null;
  chat_id: number | null;
  groq_api_key: string | null;
  enabled: boolean;
  notify_on_complete: boolean;
}

interface TelegramStatus {
  running: boolean;
  connected: boolean;
  error: string | null;
  bot_username: string | null;
}

export function TelegramSection() {
  const [config, setConfig] = useState<TelegramConfig>({
    bot_token: null,
    chat_id: null,
    groq_api_key: null,
    enabled: false,
    notify_on_complete: false,
  });
  const [status, setStatus] = useState<TelegramStatus>({
    running: false,
    connected: false,
    error: null,
    bot_username: null,
  });
  const [loaded, setLoaded] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [showGroqKey, setShowGroqKey] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      invoke<TelegramConfig>("load_telegram_config"),
      invoke<TelegramStatus>("get_telegram_status"),
    ])
      .then(([cfg, st]) => {
        setConfig(cfg);
        setStatus(st);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  const save = useCallback((updated: TelegramConfig) => {
    setConfig(updated);
    invoke("save_telegram_config", { config: updated }).catch(console.error);
  }, []);

  const handleToggle = useCallback(() => {
    setStartError(null);
    if (!status.running) {
      // Save config first, then start
      const updated = { ...config, enabled: true };
      save(updated);
      invoke<TelegramStatus>("start_telegram_bot")
        .then((st) => setStatus(st))
        .catch((e) => {
          setStartError(String(e));
          setStatus({ running: false, connected: false, error: String(e), bot_username: null });
        });
    } else {
      invoke("stop_telegram_bot")
        .then(() => {
          setStatus({ running: false, connected: false, error: null, bot_username: null });
          save({ ...config, enabled: false });
        })
        .catch(console.error);
    }
  }, [config, status, save]);

  const handleFieldChange = useCallback(
    (field: keyof TelegramConfig, value: string | number | boolean | null) => {
      save({ ...config, [field]: value });
    },
    [config, save],
  );

  if (!loaded) return null;

  return (
    <div className="webserver-section">
      {/* Enable / disable toggle */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Enable Telegram bot</span>
          <span className="settings-toggle-desc">
            Send messages to the agent via Telegram.
            {status.running && status.bot_username && ` Connected as @${status.bot_username}.`}
            {status.running && !status.bot_username && " Bot is running."}
          </span>
        </div>
        <label className="toggle-switch">
          <input type="checkbox" checked={status.running} onChange={handleToggle} />
          <span className="toggle-switch-track" />
        </label>
      </div>

      {startError && (
        <div className="webserver-note" style={{ color: "var(--error, #e55)" }}>
          {startError}
        </div>
      )}

      {/* Bot token */}
      <div className="webserver-field">
        <label className="webserver-field-label">Bot token (from @BotFather)</label>
        <div className="webserver-token-row">
          <input
            type={showToken ? "text" : "password"}
            className="webserver-input webserver-token-input"
            value={config.bot_token ?? ""}
            onChange={(e) =>
              handleFieldChange("bot_token", e.target.value || null)
            }
            placeholder="123456:ABC-DEF..."
          />
          <button
            className="webserver-icon-btn"
            onClick={() => setShowToken(!showToken)}
            title={showToken ? "Hide" : "Show"}
          >
            {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </div>

      {/* Chat ID */}
      <div className="webserver-field">
        <label className="webserver-field-label">Your Telegram chat ID</label>
        <input
          type="text"
          className="webserver-input"
          value={config.chat_id ?? ""}
          onChange={(e) => {
            const val = e.target.value.trim();
            const num = parseInt(val, 10);
            handleFieldChange("chat_id", val === "" ? null : isNaN(num) ? config.chat_id : num);
          }}
          placeholder="e.g. 123456789"
          style={{ width: "200px" }}
        />
        <span className="webserver-note">
          Send /start to @userinfobot in Telegram to get your ID.
        </span>
      </div>

      {/* Groq API key */}
      <div className="webserver-field">
        <label className="webserver-field-label">Groq API key (for voice messages)</label>
        <div className="webserver-token-row">
          <input
            type={showGroqKey ? "text" : "password"}
            className="webserver-input webserver-token-input"
            value={config.groq_api_key ?? ""}
            onChange={(e) =>
              handleFieldChange("groq_api_key", e.target.value || null)
            }
            placeholder="gsk_..."
          />
          <button
            className="webserver-icon-btn"
            onClick={() => setShowGroqKey(!showGroqKey)}
            title={showGroqKey ? "Hide" : "Show"}
          >
            {showGroqKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <span className="webserver-note">
          Optional. Required only for voice message transcription via Whisper.
        </span>
      </div>

      {/* Notify on complete */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Notify on completion</span>
          <span className="settings-toggle-desc">
            Send a Telegram message when the agent finishes a task.
          </span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={config.notify_on_complete}
            onChange={() => handleFieldChange("notify_on_complete", !config.notify_on_complete)}
          />
          <span className="toggle-switch-track" />
        </label>
      </div>
    </div>
  );
}
