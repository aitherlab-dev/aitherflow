import { useState, useEffect, useCallback, useRef } from "react";
import { invoke, openDialog } from "../lib/transport";

// --- Types ---

export interface ImageGenSettings {
  modelsPath: string;
  imagesPath: string;
  resolutionPreset: "square" | "portrait" | "landscape" | "custom";
  width: number;
  height: number;
  steps: number;
  selectedModel: string;
  loraDirectory: string;
}

export interface ImageModel {
  id: string;
  name: string;
  repoId: string;
  sizeMb: number;
  downloaded: boolean;
  lora: string | null;
  loraStrength: number;
  loraEnabled: boolean;
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

export type ModelType = "flux2" | "flux1" | "sdxl" | "zimage";

// --- Constants ---

export const RESOLUTION_PRESETS: Record<string, { label: string; w: number; h: number }> = {
  square: { label: "Square (1024×1024)", w: 1024, h: 1024 },
  portrait: { label: "Portrait 9:16 (576×1024)", w: 576, h: 1024 },
  landscape: { label: "Landscape 16:9 (1024×576)", w: 1024, h: 576 },
  custom: { label: "Custom", w: 0, h: 0 },
};

export const DEFAULT_MODEL_ID = "flux2-klein-4b";

// --- Helpers ---

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

  if (type === "zimage") {
    return {
      ...base,
      vae: { repo: "ffxvs/vae-flux", file: "ae.safetensors" },
      llm: { repo: "unsloth/Qwen3-4B-GGUF", file: "Qwen3-4B-Q8_0.gguf" },
      steps: 8,
      cfg_scale: 1.0,
      offload_cpu: true,
      flash_attn: true,
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

export function formatSize(mb: number): string {
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${mb} MB`;
}

// --- Hook ---

export function useImageGenSettings() {
  const [settings, setSettings] = useState<ImageGenSettings | null>(null);
  const [models, setModels] = useState<ImageModel[]>([]);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [customUrl, setCustomUrl] = useState("");
  const [downloadingUrl, setDownloadingUrl] = useState(false);

  // LoRA state
  const [loraPath, setLoraPath] = useState<string>("");
  const [loraStrength, setLoraStrength] = useState(1.0);
  const [loraFiles, setLoraFiles] = useState<string[]>([]);

  // Add model form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState("");
  const [addType, setAddType] = useState<ModelType>("flux2");
  const [addDiffusionUrl, setAddDiffusionUrl] = useState("");
  const [addLlmUrl, setAddLlmUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // Load settings on mount
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

  // Debounced save
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
      invoke("save_image_gen_settings", { settings: updated })
        .then(() => window.dispatchEvent(new Event("imagegen-updated")))
        .catch(console.error);
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

  // LoRA state sync
  const loraLoadedForRef = useRef<string>("");
  useEffect(() => {
    if (!settings || !settings.selectedModel || models.length === 0) return;
    const modelId = settings.selectedModel;
    const model = models.find((m) => m.id === modelId);
    const key = `${modelId}:${model?.lora ?? ""}:${model?.loraStrength ?? 1}`;
    if (loraLoadedForRef.current === key) return;
    loraLoadedForRef.current = key;
    setLoraPath(model?.lora ?? "");
    setLoraStrength(model?.loraStrength ?? 1.0);
  }, [settings?.selectedModel, models]);

  const refreshLoraFiles = useCallback(async (dir: string) => {
    if (!dir) { setLoraFiles([]); return; }
    try {
      const files = await invoke<string[]>("list_lora_files", { directory: dir });
      setLoraFiles(files);
    } catch (e) {
      console.error("Failed to list LoRA files:", e);
      setLoraFiles([]);
    }
  }, []);

  useEffect(() => {
    if (settings?.loraDirectory) refreshLoraFiles(settings.loraDirectory);
  }, [settings?.loraDirectory, refreshLoraFiles]);

  const handleLoraUpdate = useCallback(
    async (path: string | null, strength: number, enabled?: boolean) => {
      if (!settings) return;
      const isCustom = !models.some((m) => m.id === settings.selectedModel);
      if (isCustom) return;
      const model = models.find((m) => m.id === settings.selectedModel);
      try {
        await invoke("update_image_gen_model_lora", {
          modelId: settings.selectedModel,
          loraPath: path,
          loraStrength: strength,
          enabled: enabled ?? model?.loraEnabled ?? true,
        });
        window.dispatchEvent(new Event("imagegen-updated"));
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

  const handleLoraSelect = useCallback(
    (filename: string) => {
      if (!settings?.loraDirectory) return;
      const fullPath = filename ? `${settings.loraDirectory}/${filename}` : "";
      setLoraPath(fullPath);
      handleLoraUpdate(fullPath || null, loraStrength);
    },
    [settings?.loraDirectory, loraStrength, handleLoraUpdate],
  );

  const handleLoraDirBrowse = useCallback(async () => {
    const result = await openDialog({ title: "Select LoRA directory", directory: true });
    if (typeof result === "string" && settings) {
      const updated = { ...settings, loraDirectory: result };
      try {
        await invoke("save_image_gen_settings", { settings: updated });
        setSettings(updated);
        refreshLoraFiles(result);
      } catch (e) {
        console.error("Failed to save LoRA directory:", e);
      }
    }
  }, [settings, refreshLoraFiles]);

  const handleLoraClear = useCallback(() => {
    setLoraPath("");
    setLoraStrength(1.0);
    handleLoraUpdate(null, 1.0);
  }, [handleLoraUpdate]);

  const pickModelFile = useCallback(async () => {
    if (!settings) return;
    const result = await openDialog({
      title: "Select model file",
      filters: [{ name: "Model files", extensions: ["safetensors", "gguf"] }],
    });
    if (typeof result === "string") {
      save({ ...settings, selectedModel: result });
    }
  }, [settings, save]);

  // Derived state
  const isCustom = settings ? !models.some((m) => m.id === settings.selectedModel) : false;
  const selected = settings ? models.find((m) => m.id === settings.selectedModel) : undefined;

  return {
    settings,
    models,
    downloadingModel,
    downloadError,
    customUrl,
    downloadingUrl,
    loraPath,
    loraStrength,
    loraFiles,
    showAddForm,
    addName,
    addType,
    addDiffusionUrl,
    addLlmUrl,
    addError,
    isCustom,
    selected,
    actions: {
      save,
      pickDir,
      pickModelFile,
      debouncedRefreshModels,
      handleDownload,
      handleUrlDownload,
      handleResolutionChange,
      handleRemoveModel,
      handleAddModel,
      handleLoraStrengthChange,
      handleLoraSelect,
      handleLoraDirBrowse,
      handleLoraClear,
      setCustomUrl,
      setDownloadError,
      setShowAddForm,
      setAddName,
      setAddType,
      setAddDiffusionUrl,
      setAddLlmUrl,
    },
  };
}
