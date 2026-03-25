import { useState, useEffect, useCallback, useRef, memo } from "react";
import { FolderOpen, Download, Loader2, Check, FileSearch } from "lucide-react";
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
  repoId: string;
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
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [downloadingUrl, setDownloadingUrl] = useState(false);

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

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(refreshTimerRef.current), []);
  const debouncedRefreshModels = useCallback(
    (modelsPath: string) => {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => refreshModels(modelsPath), 600);
    },
    [refreshModels],
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

  const handleDownload = useCallback(
    async (model: ImageModel) => {
      if (!settings || downloadingModel) return;
      setDownloadingModel(model.id);
      setDownloadError(null);
      try {
        await invoke("download_image_gen_model", {
          modelId: model.id,
          modelsPath: settings.modelsPath,
        });
        refreshModels(settings.modelsPath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("Download failed:", e);
        setDownloadError(`${model.name}: ${msg}`);
      } finally {
        setDownloadingModel(null);
      }
    },
    [settings, downloadingModel, refreshModels],
  );

  const handleUrlDownload = useCallback(async () => {
    if (!settings || !customUrl.trim() || downloadingUrl) return;
    setDownloadingUrl(true);
    setDownloadError(null);
    try {
      await invoke("download_model_by_url", {
        url: customUrl.trim(),
        modelsPath: settings.modelsPath,
      });
      setCustomUrl("");
      refreshModels(settings.modelsPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("URL download failed:", e);
      setDownloadError(msg);
    } finally {
      setDownloadingUrl(false);
    }
  }, [settings, customUrl, downloadingUrl, refreshModels]);

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
              debouncedRefreshModels(e.target.value);
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
      {(() => {
        const CUSTOM = "__custom__";
        const isCustom = !models.some((m) => m.id === settings.selectedModel);
        const selectValue = isCustom ? CUSTOM : settings.selectedModel;
        const selected = models.find((m) => m.id === settings.selectedModel);

        return (
          <>
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">Model</span>
                <span className="settings-toggle-desc">
                  Select which model to use for generation
                </span>
              </div>
              <div className="settings-input-row">
                <select
                  className="settings-select"
                  value={selectValue}
                  onChange={(e) => {
                    const v = e.target.value;
                    save({ ...settings, selectedModel: v === CUSTOM ? "" : v });
                    setDownloadError(null);
                  }}
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({formatSize(m.sizeMb)})
                    </option>
                  ))}
                  <option value={CUSTOM}>Custom model</option>
                </select>
                {!isCustom && selected && (
                  selected.downloaded ? (
                    <span className="imggen-ready">
                      <Check size={14} />
                      <span>Ready</span>
                    </span>
                  ) : (
                    <button
                      className={`imggen-model-btn ${downloadingModel ? "imggen-model-btn--disabled" : ""}`}
                      disabled={downloadingModel !== null}
                      onClick={() => handleDownload(selected)}
                    >
                      {downloadingModel === selected.id ? (
                        <Loader2 size={14} className="imggen-spinner" />
                      ) : (
                        <Download size={14} />
                      )}
                      <span>{downloadingModel === selected.id ? "Downloading..." : "Download"}</span>
                    </button>
                  )
                )}
              </div>
            </div>
            {isCustom && (
              <div className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <span className="settings-toggle-label">Model file</span>
                  <span className="settings-toggle-desc">
                    Path to .safetensors or .gguf file
                  </span>
                </div>
                <div className="settings-input-row">
                  <input
                    type="text"
                    className="settings-input"
                    value={settings.selectedModel}
                    onChange={(e) => save({ ...settings, selectedModel: e.target.value })}
                    placeholder="/path/to/model.gguf"
                    spellCheck={false}
                  />
                  <Tooltip text="Browse">
                    <button
                      className="settings-input-toggle"
                      onClick={async () => {
                        const result = await openDialog({
                          title: "Select model file",
                          filters: [{ name: "Model files", extensions: ["safetensors", "gguf"] }],
                        });
                        if (typeof result === "string") {
                          save({ ...settings, selectedModel: result });
                        }
                      }}
                    >
                      <FileSearch size={14} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            )}
            {downloadError && (
              <div className="settings-toggle-row">
                <div className="imggen-error">{downloadError}</div>
              </div>
            )}
          </>
        );
      })()}

      {/* Download custom model by URL */}
      <div className="settings-toggle-row">
        <div className="settings-toggle-info">
          <span className="settings-toggle-label">Download custom model</span>
          <span className="settings-toggle-desc">
            Paste a HuggingFace model URL to download
          </span>
        </div>
        <div className="settings-input-row">
          <input
            type="text"
            className="settings-input"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            placeholder="HuggingFace model URL"
            spellCheck={false}
            disabled={downloadingUrl}
          />
          <button
            className={`imggen-model-btn ${downloadingUrl || !customUrl.trim() ? "imggen-model-btn--disabled" : ""}`}
            disabled={downloadingUrl || !customUrl.trim()}
            onClick={handleUrlDownload}
          >
            {downloadingUrl ? (
              <Loader2 size={14} className="imggen-spinner" />
            ) : (
              <Download size={14} />
            )}
            <span>{downloadingUrl ? "Downloading..." : "Download"}</span>
          </button>
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
