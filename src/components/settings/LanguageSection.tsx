import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "../../lib/transport";
import { Loader, RefreshCw, Languages } from "lucide-react";
import { useTranslationStore } from "../../stores/translationStore";
import { useSkillStore } from "../../stores/skillStore";
import { usePluginStore } from "../../stores/pluginStore";

interface AppSettings {
  bypassPermissions: boolean;
  translationLanguage: string;
}

const LANGUAGES = [
  { code: "", label: "Disabled (English)" },
  { code: "ru", label: "Russian" },
  { code: "zh", label: "Chinese (Simplified)" },
  { code: "ja", label: "Japanese" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
];

export function LanguageSection() {
  const [settings, setSettings] = useState<AppSettings>({
    bypassPermissions: false,
    translationLanguage: "",
  });
  const [loaded, setLoaded] = useState(false);

  const translating = useTranslationStore((s) => s.translating);
  const translationError = useTranslationStore((s) => s.error);
  const cacheEntries = useTranslationStore((s) => s.cache.entries);
  const translateAll = useTranslationStore((s) => s.translateAll);
  const updateTranslations = useTranslationStore((s) => s.updateTranslations);

  // Count total translatable items
  const allSkills = useSkillStore((s) => s.allSkills);
  const installed = usePluginStore((s) => s.installed);
  const available = usePluginStore((s) => s.available);

  const totalItems = useMemo(() => {
    const skills = allSkills();
    let count = 0;
    for (const s of skills) {
      if (s.description) count++;
    }
    for (const p of installed) {
      if (p.description) count++;
    }
    for (const p of available) {
      if (p.description) count++;
    }
    return count;
  }, [allSkills, installed, available]);

  const translatedCount = useMemo(
    () => Object.keys(cacheEntries).length,
    [cacheEntries],
  );

  useEffect(() => {
    invoke<AppSettings>("load_settings")
      .then((s) => {
        setSettings(s);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  const handleLanguageChange = useCallback(
    (code: string) => {
      const updated = { ...settings, translationLanguage: code };
      setSettings(updated);
      invoke("save_settings", { settings: updated }).catch(console.error);
    },
    [settings],
  );

  const handleTranslateAll = useCallback(() => {
    if (!settings.translationLanguage) return;
    translateAll(settings.translationLanguage).catch(console.error);
  }, [settings.translationLanguage, translateAll]);

  const handleUpdate = useCallback(() => {
    if (!settings.translationLanguage) return;
    updateTranslations(settings.translationLanguage).catch(console.error);
  }, [settings.translationLanguage, updateTranslations]);

  if (!loaded) return null;

  const langDisabled = !settings.translationLanguage;

  return (
    <div className="language-section">
      <div className="language-description">
        <Languages size={16} className="language-description__icon" />
        <p>
          Translate external content (skill and plugin descriptions) into your
          language using Claude Haiku. The app interface remains in English.
        </p>
      </div>

      <div className="language-select-row">
        <label htmlFor="lang-select">Language</label>
        <select
          id="lang-select"
          className="language-select"
          value={settings.translationLanguage}
          onChange={(e) => handleLanguageChange(e.target.value)}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>

      <div className="language-actions">
        <button
          className="language-btn language-btn--accent"
          onClick={handleTranslateAll}
          disabled={langDisabled || translating}
        >
          {translating ? (
            <Loader size={14} className="spinning" />
          ) : (
            <RefreshCw size={14} />
          )}
          <span>{translating ? "Translating..." : "Translate All"}</span>
        </button>

        <button
          className="language-btn"
          onClick={handleUpdate}
          disabled={langDisabled || translating}
        >
          {translating ? (
            <Loader size={14} className="spinning" />
          ) : (
            <RefreshCw size={14} />
          )}
          <span>{translating ? "Translating..." : "Update Translations"}</span>
        </button>
      </div>

      {translatedCount > 0 && (
        <div className="language-stats">
          {translatedCount} of {totalItems} descriptions translated
        </div>
      )}

      {translationError && (
        <div className="language-error">{translationError}</div>
      )}
    </div>
  );
}
