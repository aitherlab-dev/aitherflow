import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "../../lib/transport";
import { invalidateSettingsCache } from "../../stores/chatService";

import type { AppSettings } from "../../types/settings";

/** Serialize Record<string,string> → multiline "KEY=VALUE" text */
function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** Parse multiline "KEY=VALUE" text → Record<string,string> */
function textToEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  }
  return result;
}

export function GeneralSection() {
  const [settings, setSettings] = useState<AppSettings>({ bypassPermissions: false, translationLanguage: "", enableChrome: true, cliEnv: {} } as AppSettings);
  const [loaded, setLoaded] = useState(false);
  const [envText, setEnvText] = useState("");

  useEffect(() => {
    invoke<AppSettings>("load_settings")
      .then((s) => {
        setSettings(s);
        setEnvText(envToText(s.cliEnv ?? {}));
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  const handleToggle = useCallback(
    (key: keyof AppSettings) => {
      const updated = { ...settings, [key]: !settings[key] };
      setSettings(updated);
      invoke("save_settings", { settings: updated }).catch(console.error);
      invalidateSettingsCache();
    },
    [settings],
  );

  const savedEnvText = useMemo(() => envToText(settings.cliEnv ?? {}), [settings.cliEnv]);
  const envDirty = envText !== savedEnvText;

  const saveEnv = useCallback(() => {
    const cliEnv = textToEnv(envText);
    const updated = { ...settings, cliEnv };
    setSettings(updated);
    invoke("save_settings", { settings: updated }).catch(console.error);
    invalidateSettingsCache();
  }, [settings, envText]);

  if (!loaded) return null;

  return (
    <div className="settings-section-general">
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Bypass permissions</span>
          <span className="settings-toggle-desc">
            Run CLI with --permission-mode bypassPermissions. Tools execute without confirmation.
          </span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={settings.bypassPermissions}
            onChange={() => handleToggle("bypassPermissions")}
          />
          <span className="toggle-switch-track" />
        </label>
      </div>

      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Chrome integration</span>
          <span className="settings-toggle-desc">
            Run CLI with --chrome flag. Enables browser control via Chrome extension.
          </span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={settings.enableChrome}
            onChange={() => handleToggle("enableChrome")}
          />
          <span className="toggle-switch-track" />
        </label>
      </div>

      <div className="settings-env-section">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">CLI environment variables</span>
          <span className="settings-toggle-desc">
            Passed to every CLI process. One per line: KEY=VALUE. Lines starting with # are ignored.
          </span>
        </div>
        <textarea
          className="settings-env-textarea"
          value={envText}
          onChange={(e) => setEnvText(e.target.value)}
          onBlur={() => { if (envDirty) saveEnv(); }}
          placeholder={"CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1\n# MY_CUSTOM_VAR=value"}
          spellCheck={false}
          rows={4}
        />
        {envDirty && (
          <button className="settings-env-save" onClick={saveEnv}>
            Save
          </button>
        )}
      </div>
    </div>
  );
}
