import { useState, useEffect, useCallback, useRef, memo } from "react";
import { FolderOpen, Download, Trash2 } from "lucide-react";
import { invoke, openDialog } from "../../lib/transport";
import { Tooltip } from "../shared/Tooltip";

interface ImageGenSettings {
  modelsPath: string;
  imagesPath: string;
  resolutionPreset: "square" | "portrait" | "landscape" | "custom";
  width: number;
  height: number;
  steps: number;
  selectedModel: string;
}

interface ImageModel {
  id: string;
  name: string;
  filename: string;
  sizeMb: number;
  downloaded: boolean;
}

const RESOLUTION_PRESETS: Record<string, { label: string; w: number; h: number }> = {
  square: { label: "Square (1024×1024)", w: 1024, h: 1024 },
  portrait: { label: "Portrait 9:16 (576×1024)", w: 576, h: 1024 },
  landscape: { label: "Landscape 16:9 (1024×576)", w: 1024, h: 576 },
  custom: { label: "Custom", w: 0, h: 0 },
};

export const ImageGenSection = memo(function ImageGenSection() {
  const [settings, setSettings] = useState<ImageGenSettings | null>(null);
  const [models, setModels] = useState<ImageModel[]>([]);

  useEffect(() => {
    invoke<ImageGenSettings>("load_image_gen_settings")
      .then((s) => {
        setSettings(s);
        invoke<ImageModel[]>("list_image_gen_models", { modelsPath: s.modelsPath })
          .then(setModels)
          .catch(console.error);
      })
      .catch(console.error);
  }, []);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(saveTimerRef.current), []);

  const save = useCallback((updated: ImageGenSettings) => {
    setSettings(updated);
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      invoke("save_image_gen_settings", { settings: updated }).catch(console.error);
    }, 400);
  }, []);

  const refreshModels = useCallback(
    (modelsPath: string) => {
      invoke<ImageModel[]>("list_image_gen_models", { modelsPath })
        .then(setModels)
        .catch(console.error);
    },
    [],
  );

  const pickDir = useCallback(
    async (field: "modelsPath" | "imagesPath") => {
      if (!settings) return;
      const result = await openDialog({ directory: true, title: "Select directory" });
      if (typeof result === "string") {
        const updated = { ...settings, [field]: result };
        save(updated);
        if (field === "modelsPath") refreshModels(result);
      }
    },
    [settings, save, refreshModels],
  );

  const handleDelete = useCallback(
    (model: ImageModel) => {
      if (!settings) return;
      invoke("delete_image_gen_model", {
        modelsPath: settings.modelsPath,
        filename: model.filename,
      })
        .then(() => refreshModels(settings.modelsPath))
        .catch(console.error);
    },
    [settings, refreshModels],
  );

  const handleResolutionChange = useCallback(
    (preset: string) => {
      if (!settings) return;
      const p = RESOLUTION_PRESETS[preset];
      if (preset === "custom") {
        save({ ...settings, resolutionPreset: "custom" });
      } else if (p) {
        save({ ...settings, resolutionPreset: preset as ImageGenSettings["resolutionPreset"], width: p.w, height: p.h });
      }
    },
    [settings, save],
  );

  if (!settings) return null;

  return (
    <div className="settings-section-general">
      {/* Models path */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Models directory</span>
          <span className="settings-toggle-desc">
            Where image generation models are stored
          </span>
        </div>
        <div className="settings-input-row">
          <input
            type="text"
            className="settings-input"
            value={settings.modelsPath}
            onChange={(e) => {
              const updated = { ...settings, modelsPath: e.target.value };
              save(updated);
              refreshModels(e.target.value);
            }}
            spellCheck={false}
          />
          <Tooltip text="Browse">
            <button className="settings-input-toggle" onClick={() => pickDir("modelsPath")}>
              <FolderOpen size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Images path */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Output directory</span>
          <span className="settings-toggle-desc">
            Where generated images are saved
          </span>
        </div>
        <div className="settings-input-row">
          <input
            type="text"
            className="settings-input"
            value={settings.imagesPath}
            onChange={(e) => save({ ...settings, imagesPath: e.target.value })}
            spellCheck={false}
          />
          <Tooltip text="Browse">
            <button className="settings-input-toggle" onClick={() => pickDir("imagesPath")}>
              <FolderOpen size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Model selection */}
      <div className="settings-toggle-row" style={{ alignItems: "flex-start" }}>
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Model</span>
          <span className="settings-toggle-desc">
            Select which model to use for generation
          </span>
        </div>
        <div className="imggen-models-list">
          {models.map((m) => (
            <div key={m.id} className="imggen-model-card">
              <div className="imggen-model-info">
                <span className="imggen-model-name">{m.name}</span>
                <span className="imggen-model-size">{formatSize(m.sizeMb)}</span>
              </div>
              <div className="imggen-model-actions">
                {m.downloaded ? (
                  <>
                    <Tooltip text="Use this model">
                      <button
                        className={`imggen-model-btn ${settings.selectedModel === m.id ? "imggen-model-btn--active" : ""}`}
                        onClick={() => save({ ...settings, selectedModel: m.id })}
                      >
                        {settings.selectedModel === m.id ? "Active" : "Select"}
                      </button>
                    </Tooltip>
                    <Tooltip text="Delete model">
                      <button className="imggen-model-btn imggen-model-btn--danger" onClick={() => handleDelete(m)}>
                        <Trash2 size={14} />
                      </button>
                    </Tooltip>
                  </>
                ) : (
                  <Tooltip text="Download not yet available">
                    <button className="imggen-model-btn imggen-model-btn--disabled" disabled>
                      <Download size={14} />
                      <span>Download</span>
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Resolution */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Default resolution</span>
          <span className="settings-toggle-desc">
            Image dimensions for generation
          </span>
        </div>
        <select
          className="settings-select"
          value={settings.resolutionPreset}
          onChange={(e) => handleResolutionChange(e.target.value)}
        >
          {Object.entries(RESOLUTION_PRESETS).map(([key, { label }]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>

      {/* Custom resolution fields */}
      {settings.resolutionPreset === "custom" && (
        <div className="settings-toggle-row">
          <div className="settings-toggle-info">
            <span className="settings-toggle-label">Custom size</span>
          </div>
          <div className="settings-input-row">
            <input
              type="number"
              className="settings-input imggen-size-input"
              value={settings.width}
              min={64}
              max={2048}
              step={64}
              onChange={(e) => save({ ...settings, width: Number(e.target.value) || 512 })}
            />
            <span className="imggen-size-x">×</span>
            <input
              type="number"
              className="settings-input imggen-size-input"
              value={settings.height}
              min={64}
              max={2048}
              step={64}
              onChange={(e) => save({ ...settings, height: Number(e.target.value) || 512 })}
            />
          </div>
        </div>
      )}

      {/* Steps */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Inference steps</span>
          <span className="settings-toggle-desc">
            More steps = better quality, slower generation
          </span>
        </div>
        <div className="imggen-steps-row">
          <input
            type="range"
            className="imggen-slider"
            min={10}
            max={50}
            value={settings.steps}
            onChange={(e) => save({ ...settings, steps: Number(e.target.value) })}
          />
          <span className="imggen-steps-value">{settings.steps}</span>
        </div>
      </div>
    </div>
  );
});

function formatSize(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${mb} MB`;
}
