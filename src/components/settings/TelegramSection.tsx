import { useState, useEffect, useCallback, useRef } from "react";
import { invoke, openUrl } from "../../lib/transport";
import { useMaskedSecret } from "../../hooks/useMaskedSecret";

interface TelegramConfig {
  bot_token: string | null;
  chat_id: number | null;
  enabled: boolean;
  notify_on_complete: boolean;
  groq_api_key?: string | null;
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
    enabled: false,
    notify_on_complete: false,
    groq_api_key: null,
  });
  const [status, setStatus] = useState<TelegramStatus>({
    running: false,
    connected: false,
    error: null,
    bot_username: null,
  });
  const [loaded, setLoaded] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const tokenSecret = useMaskedSecret({ clearOnEmpty: false });
  const groqSecret = useMaskedSecret();

  useEffect(() => {
    Promise.all([
      invoke<TelegramConfig>("load_telegram_config"),
      invoke<TelegramStatus>("get_telegram_status"),
    ])
      .then(([cfg, st]) => {
        tokenSecret.setFromLoad(cfg.bot_token || "");
        groqSecret.setFromLoad(cfg.groq_api_key || "");
        setConfig(cfg);
        setStatus(st);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(saveTimerRef.current), []);
  const save = useCallback((updated: TelegramConfig) => {
    setConfig(updated);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const toSave = {
        ...updated,
        bot_token: tokenSecret.realRef.current || null,
        groq_api_key: groqSecret.realRef.current || null,
      };
      invoke("save_telegram_config", { config: toSave }).catch(console.error);
    }, 400);
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
          console.error("Failed to start Telegram bot:", e);
          const msg = "Failed to start bot. Check console for details.";
          setStartError(msg);
          setStatus({ running: false, connected: false, error: msg, bot_username: null });
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
        <div className="webserver-note" style={{ color: "var(--error)" }}>
          {startError}
        </div>
      )}

      {/* Bot token — always masked, last 4 chars visible */}
      <div className="webserver-field">
        <label className="webserver-field-label">Bot token (from @BotFather)</label>
        <input
          type="password"
          className="webserver-input"
          value={tokenSecret.displayValue}
          onChange={(e) => {
            tokenSecret.setFromInput(e.target.value);
            save(config);
          }}
          placeholder="123456:ABC-DEF..."
          autoComplete="off"
        />
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

      {/* Groq API key for voice transcription */}
      <div className="webserver-field">
        <label className="webserver-field-label">Groq API key (voice transcription)</label>
        <input
          type="password"
          className="webserver-input"
          value={groqSecret.displayValue}
          onChange={(e) => {
            groqSecret.setFromInput(e.target.value);
            save(config);
          }}
          placeholder="gsk_..."
          autoComplete="off"
        />
        <span className="webserver-note">
          Get your key at{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              openUrl("https://console.groq.com/keys").catch(console.error);
            }}
            style={{ color: "var(--accent)" }}
          >
            console.groq.com
          </a>
          . Used to transcribe voice messages via Whisper.
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
