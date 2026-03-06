import { useState, useEffect, useCallback } from "react";
import { Copy, RefreshCw, Eye, EyeOff, Link } from "lucide-react";
import { invoke } from "../../lib/transport";
import { useWebServerStore } from "../../stores/webServerStore";

export function WebServerSection() {
  const { config, running, loaded, refresh, saveConfig, start, stop } = useWebServerStore();
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggle = useCallback(async () => {
    if (!config.enabled) {
      let token = config.token;
      if (!token) {
        token = await invoke<string>("generate_web_token");
      }
      saveConfig({ ...config, enabled: true, token });
      start().catch(console.error);
    } else {
      stop().catch(console.error);
      saveConfig({ ...config, enabled: false });
    }
  }, [config, saveConfig, start, stop]);

  const handlePortChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const port = parseInt(e.target.value, 10);
      if (!isNaN(port) && port > 0 && port <= 65535) {
        saveConfig({ ...config, port });
      }
    },
    [config, saveConfig],
  );

  const handleRegenerate = useCallback(() => {
    invoke<string>("generate_web_token")
      .then((token) => saveConfig({ ...config, token }))
      .catch(console.error);
  }, [config, saveConfig]);

  const handleCopyToken = useCallback(() => {
    navigator.clipboard.writeText(config.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(console.error);
  }, [config.token]);

  const handleGenerateAndCopy = useCallback(() => {
    invoke<{ code: string }>("create_auth_code")
      .then(async ({ code }) => {
        let host = "localhost";
        if (config.remote_access) {
          try {
            host = await invoke<string>("get_local_ip");
          } catch { /* fallback to localhost */ }
        }
        const url = `http://${host}:${config.port}/auth?code=${code}`;
        setAuthUrl(url);
        return navigator.clipboard.writeText(url);
      })
      .then(() => {
        setCodeCopied(true);
        setTimeout(() => setCodeCopied(false), 3000);
      })
      .catch(console.error);
  }, [config.port, config.remote_access]);

  if (!loaded) return null;

  return (
    <div className="webserver-section">
      {/* Enable toggle */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Enable web server</span>
          <span className="settings-toggle-desc">
            Access the app from a browser on any device.
            {running && " Server is running."}
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

          {/* Remote access */}
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Allow remote access</span>
              <span className="settings-toggle-desc">
                Listen on all interfaces (0.0.0.0) instead of localhost only. Required for phone access.
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={config.remote_access}
                onChange={() => saveConfig({ ...config, remote_access: !config.remote_access })}
              />
              <span className="toggle-switch-track" />
            </label>
          </div>

          {/* Master Token (hidden by default) */}
          <div className="webserver-field">
            <label className="webserver-field-label">Master token</label>
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
                onClick={handleCopyToken}
                title="Copy token"
              >
                <Copy size={16} />
              </button>
              <button
                className="webserver-icon-btn"
                onClick={handleRegenerate}
                title="Regenerate token"
              >
                <RefreshCw size={16} />
              </button>
            </div>
            {copied && <span className="webserver-copied-hint">Copied!</span>}
          </div>

          {/* One-time access link */}
          <div className="webserver-field">
            <label className="webserver-field-label">Browser access</label>
            <div className="webserver-auth-row">
              <button className="webserver-copy-btn" onClick={handleGenerateAndCopy}>
                <Link size={14} />
                {codeCopied ? "Copied to clipboard!" : "Generate one-time link"}
              </button>
            </div>
            {authUrl && (
              <span className="webserver-note" style={{ wordBreak: "break-all" }}>
                {authUrl}
              </span>
            )}
          </div>

          <div className="webserver-note">
            Changes to port, token, or remote access take effect after toggling the server off and on.
          </div>
        </>
      )}
    </div>
  );
}
