import { create } from "zustand";
import { invoke } from "../lib/transport";

interface WebServerConfig {
  enabled: boolean;
  port: number;
  token: string;
  remote_access: boolean;
}

interface WebServerState {
  config: WebServerConfig;
  running: boolean;
  loaded: boolean;
  refresh: () => Promise<void>;
  saveConfig: (config: WebServerConfig) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const defaultConfig: WebServerConfig = {
  enabled: false,
  port: 3080,
  token: "",
  remote_access: false,
};

export const useWebServerStore = create<WebServerState>((set) => ({
  config: defaultConfig,
  running: false,
  loaded: false,

  refresh: async () => {
    try {
      const [config, running] = await Promise.all([
        invoke<WebServerConfig>("load_web_config"),
        invoke<boolean>("web_server_status"),
      ]);
      set({ config, running, loaded: true });
    } catch (e) {
      console.error(e);
    }
  },

  saveConfig: (config: WebServerConfig) => {
    set({ config });
    invoke("save_web_config", { config }).catch(console.error);
  },

  start: async () => {
    await invoke("start_web_server");
    set({ running: true });
  },

  stop: async () => {
    await invoke("stop_web_server");
    set({ running: false });
  },
}));
