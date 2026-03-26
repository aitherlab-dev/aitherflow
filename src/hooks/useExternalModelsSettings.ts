import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "../lib/transport";
import type {
  Provider,
  ExternalModelsConfigWithKeys,
  McpStatus,
  ModelInfo,
  VisionProfile,
} from "../types/external-models";

// --- Constants ---

export const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "openrouter", label: "OpenRouter" },
  { id: "google", label: "Google Gemini" },
  { id: "ollama", label: "Ollama" },
];

export const DEFAULT_VISION_PROFILE: VisionProfile = {
  strategy: "auto",
  framesPerClip: 5,
  fps: null,
  sceneDetection: false,
  sceneThreshold: 0.3,
  resolution: 720,
  jpegQuality: 5,
};

// --- Types ---

export interface ProviderState {
  enabled: boolean;
  apiKey: string;
  defaultModel: string;
  baseUrl: string;
  models: ModelInfo[];
  modelsLoading: boolean;
  testResult: { ok: boolean; message: string } | null;
  testing: boolean;
}

function defaultProviderState(): ProviderState {
  return {
    enabled: false,
    apiKey: "",
    defaultModel: "",
    baseUrl: "",
    models: [],
    modelsLoading: false,
    testResult: null,
    testing: false,
  };
}

// --- Hook ---

export function useExternalModelsSettings() {
  const [providers, setProviders] = useState<Record<Provider, ProviderState>>({
    openrouter: defaultProviderState(),
    google: defaultProviderState(),
    ollama: defaultProviderState(),
  });
  const [visionProfile, setVisionProfile] = useState<VisionProfile>(
    DEFAULT_VISION_PROFILE,
  );
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({
    running: false,
    port: null,
  });
  const [mcpLoading, setMcpLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [mgmtKey, setMgmtKey] = useState("");
  const [showMgmtKey, setShowMgmtKey] = useState(false);
  const realMgmtKeyRef = useRef("");
  const [showKeys, setShowKeys] = useState<Record<Provider, boolean>>({
    openrouter: false,
    google: false,
    ollama: false,
  });

  const realKeysRef = useRef<Record<Provider, string>>({
    openrouter: "",
    google: "",
    ollama: "",
  });

  // Load config and MCP status
  useEffect(() => {
    Promise.all([
      invoke<ExternalModelsConfigWithKeys>("external_models_load_config"),
      invoke<McpStatus>("external_models_mcp_status"),
    ])
      .then(([cfg, status]) => {
        realKeysRef.current = {
          openrouter: cfg.openrouterApiKey,
          google: cfg.googleApiKey,
          ollama: "",
        };
        realMgmtKeyRef.current = cfg.openrouterMgmtKey;
        setMgmtKey(cfg.openrouterMgmtKey ? `****${cfg.openrouterMgmtKey.slice(-4)}` : "");

        const updated: Record<Provider, ProviderState> = {
          openrouter: defaultProviderState(),
          google: defaultProviderState(),
          ollama: defaultProviderState(),
        };

        for (const p of cfg.providers) {
          const id = p.provider as Provider;
          if (updated[id]) {
            updated[id].enabled = p.enabled;
            updated[id].defaultModel = p.defaultModel;
            updated[id].baseUrl = p.baseUrl || "";
          }
        }

        updated.openrouter.apiKey = cfg.openrouterApiKey ? `****${cfg.openrouterApiKey.slice(-4)}` : "";
        updated.google.apiKey = cfg.googleApiKey ? `****${cfg.googleApiKey.slice(-4)}` : "";

        setProviders(updated);
        if (cfg.visionProfile) {
          setVisionProfile(cfg.visionProfile);
        }
        setMcpStatus(status);
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  // Debounced save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(saveTimerRef.current), []);

  const visionProfileRef = useRef(visionProfile);
  visionProfileRef.current = visionProfile;

  const providersRef = useRef(providers);
  providersRef.current = providers;

  const save = useCallback((updated: Record<Provider, ProviderState>) => {
    setProviders(updated);
    clearTimeout(saveTimerRef.current);

    for (const id of ["openrouter", "google", "ollama"] as Provider[]) {
      const key = updated[id].apiKey;
      if (key && !key.startsWith("****")) {
        realKeysRef.current[id] = key;
      } else if (!key) {
        realKeysRef.current[id] = "";
      }
    }

    saveTimerRef.current = setTimeout(() => {
      const providersConfig = PROVIDERS.map(({ id }) => ({
        provider: id,
        enabled: updated[id].enabled,
        defaultModel: updated[id].defaultModel,
        baseUrl: updated[id].baseUrl || null,
      }));

      const orKey = realKeysRef.current.openrouter;
      const mgmt = realMgmtKeyRef.current;
      const gKey = realKeysRef.current.google;

      invoke("external_models_save_config", {
        providersConfig: {
          providers: providersConfig,
          visionProfile: visionProfileRef.current,
        },
        openrouterApiKey: orKey || null,
        openrouterMgmtKey: mgmt || null,
        googleApiKey: gKey || null,
      }).catch(console.error);
    }, 400);
  }, []);

  const saveVisionProfile = useCallback(
    (profile: VisionProfile) => {
      setVisionProfile(profile);
      visionProfileRef.current = profile;
      save({ ...providersRef.current });
    },
    [save],
  );

  const updateProvider = useCallback(
    (id: Provider, patch: Partial<ProviderState>) => {
      const updated = {
        ...providers,
        [id]: { ...providers[id], ...patch },
      };
      save(updated);
    },
    [providers, save],
  );

  const testConnection = useCallback((id: Provider) => {
    setProviders((prev) => ({
      ...prev,
      [id]: { ...prev[id], testing: true, testResult: null },
    }));

    invoke<string>("external_models_test_connection", { provider: id })
      .then((reply) => {
        setProviders((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            testing: false,
            testResult: { ok: true, message: reply },
          },
        }));
      })
      .catch((e) => {
        setProviders((prev) => ({
          ...prev,
          [id]: {
            ...prev[id],
            testing: false,
            testResult: { ok: false, message: String(e) },
          },
        }));
      });
  }, []);

  const loadModels = useCallback((id: Provider) => {
    setProviders((prev) => ({
      ...prev,
      [id]: { ...prev[id], modelsLoading: true },
    }));

    invoke<ModelInfo[]>("external_models_list_models", { provider: id })
      .then((models) => {
        setProviders((prev) => ({
          ...prev,
          [id]: { ...prev[id], models, modelsLoading: false },
        }));
      })
      .catch((e) => {
        console.error(`Failed to load models for ${id}:`, e);
        setProviders((prev) => ({
          ...prev,
          [id]: { ...prev[id], modelsLoading: false },
        }));
      });
  }, []);

  const toggleMcp = useCallback(() => {
    setMcpLoading(true);
    if (mcpStatus.running) {
      invoke("external_models_stop_mcp")
        .then(() => setMcpStatus({ running: false, port: null }))
        .catch(console.error)
        .finally(() => setMcpLoading(false));
    } else {
      invoke<number>("external_models_start_mcp")
        .then((port) => setMcpStatus({ running: true, port }))
        .catch(console.error)
        .finally(() => setMcpLoading(false));
    }
  }, [mcpStatus]);

  const toggleShowKey = useCallback((id: Provider) => {
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleMgmtKeyChange = useCallback((val: string) => {
    setMgmtKey(val);
    if (val && !val.startsWith("****")) {
      realMgmtKeyRef.current = val;
    } else if (!val) {
      realMgmtKeyRef.current = "";
    }
    save({ ...providersRef.current });
  }, [save]);

  return {
    providers,
    visionProfile,
    mcpStatus,
    mcpLoading,
    loaded,
    mgmtKey,
    showMgmtKey,
    showKeys,
    actions: {
      updateProvider,
      testConnection,
      loadModels,
      toggleMcp,
      saveVisionProfile,
      toggleShowKey,
      setShowMgmtKey,
      handleMgmtKeyChange,
      save,
    },
  };
}
