import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AppSettings {
  bypassPermissions: boolean;
}

export function GeneralSection() {
  const [settings, setSettings] = useState<AppSettings>({ bypassPermissions: false });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    invoke<AppSettings>("load_settings")
      .then((s) => {
        setSettings(s);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  const handleToggle = useCallback(
    (key: keyof AppSettings) => {
      const updated = { ...settings, [key]: !settings[key] };
      setSettings(updated);
      invoke("save_settings", { settings: updated }).catch(console.error);
    },
    [settings],
  );

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
    </div>
  );
}
