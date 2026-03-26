import { useState, useEffect, useCallback, useRef, memo } from "react";
import { FolderOpen, Download, Loader2, Check, FileSearch, Trash2, Plus, ChevronUp, X } from "lucide-react";
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
  lora: string | null;
  loraStrength: number;
}

interface RepoFile {
  repo: string;
  file: string;
}

interface ModelDefinition {
  id: string;
  name: string;
  diffusion: RepoFile;
  vae: RepoFile | null;
  llm: RepoFile | null;
  clip_l: RepoFile | null;
  t5xxl: RepoFile | null;
  single_file: boolean;
  steps: number;
  cfg_scale: number;
  width: number;
  height: number;
  offload_cpu: boolean;
  flash_attn: boolean;
  vae_tiling: boolean;
  size_mb: number;
  lora: string | null;
  lora_strength: number;
}

type ModelType = "flux2" | "flux1" | "sdxl";

const RESOLUTION_PRESETS: Record<string, { label: string; w: number; h: number }> = {
  square: { label: "Square (1024×1024)", w: 1024, h: 1024 },
  portrait: { label: "Portrait 9:16 (576×1024)", w: 576, h: 1024 },
  landscape: { label: "Landscape 16:9 (1024×576)", w: 1024, h: 576 },
  custom: { label: "Custom", w: 0, h: 0 },
};

const DEFAULT_MODEL_ID = "flux2-klein-4b";

function parseHfUrl(url: string): { repo: string; file: string } | null {
  const trimmed = url.trim();
  const prefix = trimmed.startsWith("https://huggingface.co/")
    ? "https://huggingface.co/"
    : trimmed.startsWith("http://huggingface.co/")
      ? "http://huggingface.co/"
      : null;
  if (!prefix) return null;
  const path = trimmed.slice(prefix.length);
  const parts = path.split("/");
  // org/repo/resolve|blob/main/file...
  if (parts.length < 5) return null;
  const org = parts[0];
  const repo = parts[1];
  const file = parts.slice(4).join("/");
  if (!org || !repo || !file) return null;
  return { repo: `${org}/${repo}`, file };
}

function buildModelDefinition(
  name: string,
  type: ModelType,
  diffusionUrl: string,
  llmUrl: string,
): ModelDefinition | string {
  const diffusion = parseHfUrl(diffusionUrl);
  if (!diffusion) return "Invalid diffusion model URL";

  const id = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (!id) return "Invalid model name";

  const base: ModelDefinition = {
    id,
    name,
    diffusion,
    vae: null,
    llm: null,
    clip_l: null,
    t5xxl: null,
    single_file: false,
    steps: 4,
    cfg_scale: 1.0,
    width: 1024,
    height: 1024,
    offload_cpu: false,
    flash_attn: false,
    vae_tiling: false,
    size_mb: 0,
    lora: null,
    lora_strength: 1.0,
  };

  if (type === "flux2") {
    const llm = parseHfUrl(llmUrl);
    if (!llm) return "Invalid LLM encoder URL";
    return {
      ...base,
      vae: { repo: "black-forest-labs/FLUX.2-dev", file: "vae/diffusion_pytorch_model.safetensors" },
      llm,
      steps: 4,
      cfg_scale: 1.0,
      offload_cpu: true,
      flash_attn: true,
      vae_tiling: true,
    };
  }

  if (type === "flux1") {
    return {
      ...base,
      vae: { repo: "ffxvs/vae-flux", file: "ae.safetensors" },
      clip_l: { repo: "comfyanonymous/flux_text_encoders", file: "clip_l.safetensors" },
      t5xxl: { repo: "Green-Sky/flux.1-schnell-GGUF", file: "t5xxl_q8_0.gguf" },
      steps: 28,
      cfg_scale: 1.0,
      vae_tiling: true,
    };
  }

  // sdxl
  return {
    ...base,
    vae: { repo: "madebyollin/sdxl-vae-fp16-fix", file: "sdxl.vae.safetensors" },
    single_file: true,
    steps: 4,
    cfg_scale: 1.0,
  };
}

export const ImageGenSection = memo(function ImageGenSection() {
  const [settings, setSettings] = useState<ImageGenSettings | null>(null);
  const [models, setModels] = useState<ImageModel[]>([]);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [downloadingUrl, setDownloadingUrl] = useState(false);

  // LoRA state
  const [loraPath, setLoraPath] = useState<string>("");
  const [loraStrength, setLoraStrength] = useState(1.0);

  // Add model form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState("");
  const [addType, setAddType] = useState<ModelType>("flux2");
  const [addDiffusionUrl, setAddDiffusionUrl] = useState("");
  const [addLlmUrl, setAddLlmUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

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
  const pendingSettingsRef = useRef<ImageGenSettings | null>(null);
  useEffect(() => () => {
    clearTimeout(saveTimerRef.current);
    if (pendingSettingsRef.current) {
      invoke("save_image_gen_settings", { settings: pendingSettingsRef.current }).catch(console.error);
    }
  }, []);

  const save = useCallback((updated: ImageGenSettings) => {
    setSettings(updated);
    pendingSettingsRef.current = updated;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      pendingSettingsRef.current = null;
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

  const handleRemoveModel = useCallback(
    async (modelId: string) => {
      if (!settings) return;
      try {
        await invoke("remove_image_gen_model", { modelId });
        refreshModels(settings.modelsPath);
        if (settings.selectedModel === modelId) {
          save({ ...settings, selectedModel: DEFAULT_MODEL_ID });
        }
      } catch (e) {
        console.error("Remove model failed:", e);
        setDownloadError(e instanceof Error ? e.message : String(e));
      }
    },
    [settings, refreshModels, save],
  );

  const handleAddModel = useCallback(async () => {
    if (!settings) return;
    setAddError(null);
    const result = buildModelDefinition(addName.trim(), addType, addDiffusionUrl.trim(), addLlmUrl.trim());
    if (typeof result === "string") {
      setAddError(result);
      return;
    }
    try {
      await invoke("add_image_gen_model", { model: result });
      refreshModels(settings.modelsPath);
      setShowAddForm(false);
      setAddName("");
      setAddDiffusionUrl("");
      setAddLlmUrl("");
      setAddError(null);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    }
  }, [settings, addName, addType, addDiffusionUrl, addLlmUrl, refreshModels]);

  // Load LoRA state from model list when selected model changes
  const loraLoadedForRef = useRef<string>("");
  useEffect(() => {
    if (!settings || !settings.selectedModel) return;
    const modelId = settings.selectedModel;
    if (loraLoadedForRef.current === modelId) return;
    loraLoadedForRef.current = modelId;
    const model = models.find((m) => m.id === modelId);
    setLoraPath(model?.lora ?? "");
    setLoraStrength(model?.loraStrength ?? 1.0);
  }, [settings?.selectedModel, models]);

  const handleLoraUpdate = useCallback(
    async (path: string | null, strength: number) => {
      if (!settings) return;
      const isCustom = !models.some((m) => m.id === settings.selectedModel);
      if (isCustom) return;
      try {
        await invoke("update_image_gen_model_lora", {
          modelId: settings.selectedModel,
          loraPath: path,
          loraStrength: strength,
        });
      } catch (e) {
        console.error("LoRA update failed:", e);
      }
    },
    [settings, models],
  );

  const loraTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(loraTimerRef.current), []);

  const handleLoraStrengthChange = useCallback(
    (value: number) => {
      setLoraStrength(value);
      clearTimeout(loraTimerRef.current);
      loraTimerRef.current = setTimeout(() => {
        handleLoraUpdate(loraPath || null, value);
      }, 400);
    },
    [loraPath, handleLoraUpdate],
  );

  const handleLoraBrowse = useCallback(async () => {
    const result = await openDialog({
      title: "Select LoRA file",
      filters: [{ name: "LoRA files", extensions: ["safetensors"] }],
    });
    if (typeof result === "string") {
      setLoraPath(result);
      handleLoraUpdate(result, loraStrength);
    }
  }, [loraStrength, handleLoraUpdate]);

  const handleLoraClear = useCallback(() => {
    setLoraPath("");
    setLoraStrength(1.0);
    handleLoraUpdate(null, 1.0);
  }, [handleLoraUpdate]);

  if (!settings) return null;

  const CUSTOM = "__custom__";
  const isCustom = !models.some((m) => m.id === settings.selectedModel);
  const selectValue = isCustom ? CUSTOM : settings.selectedModel;
  const selected = models.find((m) => m.id === settings.selectedModel);

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
          {!isCustom && selected && selected.id !== DEFAULT_MODEL_ID && (
            <Tooltip text="Remove model">
              <button
                className="imggen-model-btn imggen-model-btn--danger"
                onClick={() => handleRemoveModel(selected.id)}
              >
                <Trash2 size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Custom model file path */}
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

      {/* LoRA section — only for known models */}
      {!isCustom && selected && (
        <>
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">LoRA adapter</span>
              <span className="settings-toggle-desc">
                Optional .safetensors LoRA file for style transfer
              </span>
            </div>
            <div className="settings-input-row">
              <input
                type="text"
                className="settings-input"
                value={loraPath}
                onChange={(e) => setLoraPath(e.target.value)}
                placeholder="No LoRA selected"
                spellCheck={false}
                readOnly
              />
              <Tooltip text="Browse">
                <button className="settings-input-toggle" onClick={handleLoraBrowse}>
                  <FileSearch size={14} />
                </button>
              </Tooltip>
              {loraPath && (
                <Tooltip text="Clear LoRA">
                  <button className="settings-input-toggle" onClick={handleLoraClear}>
                    <X size={14} />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
          {loraPath && (
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">LoRA strength</span>
              </div>
              <div className="imggen-steps-row">
                <input
                  type="range"
                  className="imggen-slider"
                  min={0}
                  max={2}
                  step={0.1}
                  value={loraStrength}
                  onChange={(e) => handleLoraStrengthChange(Number(e.target.value))}
                />
                <span className="imggen-steps-value">{loraStrength.toFixed(1)}</span>
              </div>
            </div>
          )}
        </>
      )}

      {downloadError && (
        <div className="settings-toggle-row">
          <div className="imggen-error">{downloadError}</div>
        </div>
      )}

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

      {/* Add model */}
      <div className="settings-toggle-row">
        <button
          className="imggen-model-btn"
          onClick={() => setShowAddForm(!showAddForm)}
        >
          {showAddForm ? <ChevronUp size={14} /> : <Plus size={14} />}
          <span>{showAddForm ? "Cancel" : "Add model"}</span>
        </button>
      </div>

      {showAddForm && (
        <div className="imggen-add-form">
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Name</span>
            </div>
            <input
              type="text"
              className="settings-input"
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="My Custom Model"
              spellCheck={false}
            />
          </div>
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Type</span>
            </div>
            <select
              className="settings-select"
              value={addType}
              onChange={(e) => setAddType(e.target.value as ModelType)}
            >
              <option value="flux2">FLUX.2</option>
              <option value="flux1">FLUX.1</option>
              <option value="sdxl">SDXL</option>
            </select>
          </div>
          <div className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Diffusion model URL</span>
              <span className="settings-toggle-desc">HuggingFace URL to the model file</span>
            </div>
            <input
              type="text"
              className="settings-input"
              value={addDiffusionUrl}
              onChange={(e) => setAddDiffusionUrl(e.target.value)}
              placeholder="https://huggingface.co/org/repo/resolve/main/model.gguf"
              spellCheck={false}
            />
          </div>
          {addType === "flux2" && (
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <span className="settings-toggle-label">LLM encoder URL</span>
                <span className="settings-toggle-desc">HuggingFace URL to the LLM text encoder</span>
              </div>
              <input
                type="text"
                className="settings-input"
                value={addLlmUrl}
                onChange={(e) => setAddLlmUrl(e.target.value)}
                placeholder="https://huggingface.co/org/repo/resolve/main/encoder.gguf"
                spellCheck={false}
              />
            </div>
          )}
          {addError && (
            <div className="settings-toggle-row">
              <div className="imggen-error">{addError}</div>
            </div>
          )}
          <div className="settings-toggle-row">
            <button
              className={`imggen-model-btn imggen-model-btn--active ${!addName.trim() || !addDiffusionUrl.trim() ? "imggen-model-btn--disabled" : ""}`}
              disabled={!addName.trim() || !addDiffusionUrl.trim()}
              onClick={handleAddModel}
            >
              <Plus size={14} />
              <span>Add</span>
            </button>
          </div>
        </div>
      )}

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
