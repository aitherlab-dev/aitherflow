import { useState, useEffect, useCallback } from "react";
import { Copy, RefreshCw, Eye, EyeOff } from "lucide-react";
import { invoke } from "../../lib/transport";

interface WebServerConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export function WebServerSection() {
  const [config, setConfig] = useState<WebServerConfig>({ enabled: false, port: 3080, token: "" });
  const [loaded, setLoaded] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    invoke<WebServerConfig>("load_web_config")
      .then((c) => {
        setConfig(c);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  const save = useCallback(
    (updated: WebServerConfig) => {
      setConfig(updated);
      invoke("save_web_config", { config: updated }).catch(console.error);
    },
    [],
  );

  const handleToggle = useCallback(() => {
    const updated = { ...config, enabled: !config.enabled };
    // Auto-generate token on first enable
    if (updated.enabled && !updated.token) {
      invoke<string>("generate_web_token")
        .then((token) => {
          save({ ...updated, token });
        })
        .catch(console.error);
    } else {
      save(updated);
    }
  }, [config, save]);

  const handlePortChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const port = parseInt(e.target.value, 10);
      if (!isNaN(port) && port > 0 && port <= 65535) {
        save({ ...config, port });
      }
    },
    [config, save],
  );

  const handleRegenerate = useCallback(() => {
    invoke<string>("generate_web_token")
      .then((token) => save({ ...config, token }))
      .catch(console.error);
  }, [config, save]);

  const handleCopyUrl = useCallback(() => {
    const url = `http://localhost:${config.port}?token=${config.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(console.error);
  }, [config]);

  if (!loaded) return null;

  return (
    <div className="webserver-section">
      {/* Enable toggle */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Enable web server</span>
          <span className="settings-toggle-desc">
            Access the app from a browser on any device. Requires restart.
          </span>
        </div>
        <label className="toggle-switch">
          <input type="checkbox" checked={config.enabled} onChange={handleToggle} />
          <span className="toggle-switch-track" />
        </label>
      </div>

      {config.enabled && (
        <>
          {/* Port */}
          <div className="webserver-field">
            <label className="webserver-field-label">Port</label>
            <input
              type="number"
              className="webserver-input"
              value={config.port}
              onChange={handlePortChange}
              min={1}
              max={65535}
            />
          </div>

          {/* Token */}
          <div className="webserver-field">
            <label className="webserver-field-label">Access token</label>
            <div className="webserver-token-row">
              <input
                type={showToken ? "text" : "password"}
                className="webserver-input webserver-token-input"
                value={config.token}
                readOnly
              />
              <button
                className="webserver-icon-btn"
                onClick={() => setShowToken(!showToken)}
                title={showToken ? "Hide" : "Show"}
              >
                {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              <button
                className="webserver-icon-btn"
                onClick={handleRegenerate}
                title="Regenerate token"
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>

          {/* Copy URL */}
          <button className="webserver-copy-btn" onClick={handleCopyUrl}>
            <Copy size={14} />
            {copied ? "Copied!" : "Copy access URL"}
          </button>

          <div className="webserver-note">
            Changes to port or token require app restart to take effect.
          </div>
        </>
      )}
    </div>
  );
}
