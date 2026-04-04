import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "../lib/transport";
import { useMaskedSecrets } from "./useMaskedSecret";
import type {
  ProviderConfig,
  ExternalModelsConfigWithKeys,
  McpStatus,
  ModelInfo,
  VisionProfile,
} from "../types/external-models";

// --- Constants ---

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

export interface ProviderState extends ProviderConfig {
  apiKey: string;
  models: ModelInfo[];
  modelsLoading: boolean;
  testResult: { ok: boolean; message: string } | null;
  testing: boolean;
  collapsed: boolean;
}

function makeProviderState(pc: ProviderConfig, apiKey: string): ProviderState {
  return {
    ...pc,
    apiKey,
    models: [],
    modelsLoading: false,
    testResult: null,
    testing: false,
    collapsed: true,
  };
}

let nextTempId = 1;

export function generateProviderId(): string {
  return `provider-${Date.now()}-${nextTempId++}`;
}

// --- Hook ---

export function useExternalModelsSettings() {
  const [providers, setProviders] = useState<ProviderState[]>([]);
  const [visionProfile, setVisionProfile] = useState<VisionProfile>(
    DEFAULT_VISION_PROFILE,
  );
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({
    running: false,
    port: null,
  });
  const [mcpLoading, setMcpLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const secrets = useMaskedSecrets();

  // Load config and MCP status
  useEffect(() => {
    Promise.all([
      invoke<ExternalModelsConfigWithKeys>("external_models_load_config"),
      invoke<McpStatus>("external_models_mcp_status"),
    ])
      .then(([cfg, status]) => {
        const states: ProviderState[] = cfg.providers.map((p) => {
          const apiKey = cfg.keys[p.id] || "";
          secrets.setFromLoad(p.id, apiKey);
          return makeProviderState(p, apiKey);
        });

        setProviders(states);
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

  const save = useCallback((updated: ProviderState[]) => {
    setProviders(updated);
    clearTimeout(saveTimerRef.current);

    for (const p of updated) {
      secrets.resolveFromInput(p.id, p.apiKey);
    }

    saveTimerRef.current = setTimeout(() => {
      const providersConfig = updated.map((p) => ({
        id: p.id,
        name: p.name,
        providerType: p.providerType,
        baseUrl: p.baseUrl,
        defaultModel: p.defaultModel,
        enabled: p.enabled,
        requiresApiKey: p.requiresApiKey,
      }));

      const apiKeys: Record<string, string> = {};
      for (const p of updated) {
        if (p.requiresApiKey) {
          const key = secrets.realKeysRef.current[p.id] || "";
          if (key) {
            apiKeys[p.id] = key;
          }
        }
      }

      invoke("external_models_save_config", {
        providersConfig: {
          providers: providersConfig,
          visionProfile: visionProfileRef.current,
        },
        apiKeys,
      }).catch(console.error);
    }, 400);
  }, []);

  const saveVisionProfile = useCallback(
    (profile: VisionProfile) => {
      setVisionProfile(profile);
      visionProfileRef.current = profile;
      save([...providersRef.current]);
    },
    [save],
  );

  const updateProvider = useCallback(
    (id: string, patch: Partial<ProviderState>) => {
      const updated = providersRef.current.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      );
      save(updated);
    },
    [save],
  );

  const addProvider = useCallback(() => {
    const id = generateProviderId();
    const newProvider: ProviderState = {
      id,
      name: "",
      providerType: "openai_compatible",
      baseUrl: "",
      defaultModel: "",
      enabled: true,
      requiresApiKey: true,
      apiKey: "",
      models: [],
      modelsLoading: false,
      testResult: null,
      testing: false,
      collapsed: false,
    };
    const updated = [...providersRef.current, newProvider];
    save(updated);
  }, [save]);

  const removeProvider = useCallback(
    (id: string) => {
      const updated = providersRef.current.filter((p) => p.id !== id);
      secrets.remove(id);
      save(updated);
      invoke("external_models_remove_provider", { providerId: id }).catch(
        console.error,
      );
    },
    [save],
  );

  const testConnection = useCallback((id: string) => {
    setProviders((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, testing: true, testResult: null } : p,
      ),
    );

    invoke<string>("external_models_test_connection", { providerId: id })
      .then((reply) => {
        setProviders((prev) =>
          prev.map((p) =>
            p.id === id
              ? { ...p, testing: false, testResult: { ok: true, message: reply } }
              : p,
          ),
        );
      })
      .catch((e) => {
        setProviders((prev) =>
          prev.map((p) =>
            p.id === id
              ? { ...p, testing: false, testResult: { ok: false, message: String(e) } }
              : p,
          ),
        );
      });
  }, []);

  const loadModels = useCallback((id: string) => {
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, modelsLoading: true } : p)),
    );

    invoke<ModelInfo[]>("external_models_list_models", { providerId: id })
      .then((models) => {
        setProviders((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, models, modelsLoading: false } : p,
          ),
        );
      })
      .catch((e) => {
        console.error(`Failed to load models for ${id}:`, e);
        setProviders((prev) =>
          prev.map((p) => (p.id === id ? { ...p, modelsLoading: false } : p)),
        );
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

  const toggleCollapsed = useCallback((id: string) => {
    setProviders((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, collapsed: !p.collapsed } : p,
      ),
    );
  }, []);

  return {
    providers,
    visionProfile,
    mcpStatus,
    mcpLoading,
    loaded,
    showKeys: secrets.showKeys,
    actions: {
      updateProvider,
      addProvider,
      removeProvider,
      testConnection,
      loadModels,
      toggleMcp,
      saveVisionProfile,
      toggleShowKey: secrets.toggleShowKey,
      toggleCollapsed,
    },
  };
}
