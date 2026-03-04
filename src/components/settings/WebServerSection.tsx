import { useState, useEffect, useCallback } from "react";
import { Copy, RefreshCw, Eye, EyeOff, Link } from "lucide-react";
import { invoke } from "../../lib/transport";

interface WebServerConfig {
  enabled: boolean;
  port: number;
  token: string;
  remote_access: boolean;
}

export function WebServerSection() {
  const [config, setConfig] = useState<WebServerConfig>({ enabled: false, port: 3080, token: "", remote_access: false });
  const [loaded, setLoaded] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [authCode, setAuthCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [serverRunning, setServerRunning] = useState(false);

  useEffect(() => {
    Promise.all([
      invoke<WebServerConfig>("load_web_config"),
      invoke<boolean>("web_server_status"),
    ])
      .then(([c, running]) => {
        setConfig(c);
        setServerRunning(running);
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
    if (!config.enabled) {
      const start = (updated: WebServerConfig) => {
        save(updated);
        invoke("start_web_server")
          .then(() => setServerRunning(true))
          .catch(console.error);
      };
      if (!config.token) {
        invoke<string>("generate_web_token")
          .then((token) => start({ ...config, enabled: true, token }))
          .catch(console.error);
      } else {
        start({ ...config, enabled: true });
      }
    } else {
      invoke("stop_web_server")
        .then(() => {
          setServerRunning(false);
          save({ ...config, enabled: false });
        })
        .catch(console.error);
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

  const handleCopyToken = useCallback(() => {
    navigator.clipboard.writeText(config.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(console.error);
  }, [config]);

  const handleGenerateAuthCode = useCallback(() => {
    invoke<{ code: string }>("create_auth_code")
      .then(({ code }) => {
        setAuthCode(code);
        // Auto-expire the displayed code after 5 minutes
        setTimeout(() => setAuthCode(null), 5 * 60 * 1000);
      })
      .catch(console.error);
  }, []);

  const handleCopyAuthUrl = useCallback(() => {
    if (!authCode) return;
    const url = `http://localhost:${config.port}/auth?code=${authCode}`;
    navigator.clipboard.writeText(url).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }).catch(console.error);
  }, [config.port, authCode]);

  if (!loaded) return null;

  return (
    <div className="webserver-section">
      {/* Enable toggle */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Enable web server</span>
          <span className="settings-toggle-desc">
            Access the app from a browser on any device.
            {serverRunning && " Server is running."}
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
                onChange={() => save({ ...config, remote_access: !config.remote_access })}
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
              <button className="webserver-copy-btn" onClick={handleGenerateAuthCode}>
                <Link size={14} />
                Generate one-time link
              </button>
              {authCode && (
                <button className="webserver-copy-btn" onClick={handleCopyAuthUrl}>
                  <Copy size={14} />
                  {codeCopied ? "Copied!" : "Copy link"}
                </button>
              )}
            </div>
            {authCode && (
              <span className="webserver-note">
                Link expires in 5 minutes and can only be used once.
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
