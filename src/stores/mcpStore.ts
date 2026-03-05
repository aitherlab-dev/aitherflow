import { create } from "zustand";
import { invoke } from "../lib/transport";
import type {
  McpServer,
  McpServerConfig,
  McpData,
  McpTestResult,
} from "../types/mcp";

type McpScope = "global" | "project";

interface McpState {
  global: McpServer[];
  project: McpServer[];
  globalPath: string;
  projectPath: string | null;
  loaded: boolean;
  testing: Set<string>;
  testResults: Map<string, McpTestResult>;

  load: (projectPath?: string) => Promise<void>;
  addServer: (scope: McpScope, name: string, config: McpServerConfig, projectDir?: string) => Promise<void>;
  removeServer: (scope: McpScope, name: string, projectDir?: string) => Promise<void>;
  testServer: (name: string, config: McpServerConfig) => Promise<void>;
  resetChoices: (projectDir: string) => Promise<void>;
}

export const useMcpStore = create<McpState>((set, get) => ({
  global: [],
  project: [],
  globalPath: "",
  projectPath: null,
  loaded: false,
  testing: new Set(),
  testResults: new Map(),

  load: async (projectPath) => {
    try {
      const data = await invoke<McpData>("list_mcp_servers", {
        projectPath: projectPath ?? null,
      });
      set({
        global: data.global,
        project: data.project,
        globalPath: data.globalPath,
        projectPath: data.projectPath,
        loaded: true,
      });
    } catch (e) {
      console.error("Failed to load MCP servers:", e);
    }
  },

  addServer: async (scope, name, config, projectDir) => {
    if (scope === "global") {
      await invoke("add_global_mcp_server", { name, config });
    } else {
      // Read current project servers and add the new one
      const current = get().project;
      const servers: Record<string, McpServerConfig> = {};
      for (const s of current) {
        servers[s.name] = serverToConfig(s);
      }
      servers[name] = config;
      await invoke("save_project_mcp_servers", {
        projectPath: projectDir,
        servers,
      });
    }
    await get().load(projectDir);
  },

  removeServer: async (scope, name, projectDir) => {
    if (scope === "global") {
      await invoke("remove_global_mcp_server", { name });
    } else {
      const current = get().project;
      const servers: Record<string, McpServerConfig> = {};
      for (const s of current) {
        if (s.name !== name) {
          servers[s.name] = serverToConfig(s);
        }
      }
      await invoke("save_project_mcp_servers", {
        projectPath: projectDir,
        servers,
      });
    }
    // Clear test result for removed server
    const results = new Map(get().testResults);
    results.delete(name);
    set({ testResults: results });
    await get().load(projectDir);
  },

  testServer: async (name, config) => {
    const { testing } = get();
    if (testing.has(name)) return;

    set({ testing: new Set([...testing, name]) });
    try {
      const result = await invoke<McpTestResult>("test_mcp_server", { config });
      const results = new Map(get().testResults);
      results.set(name, result);
      set({ testResults: results });
    } catch (e) {
      const results = new Map(get().testResults);
      results.set(name, { ok: false, message: String(e) });
      set({ testResults: results });
    } finally {
      const current = get().testing;
      const next = new Set(current);
      next.delete(name);
      set({ testing: next });
    }
  },

  resetChoices: async (projectDir) => {
    await invoke("reset_mcp_project_choices", { projectPath: projectDir });
  },
}));

function serverToConfig(s: McpServer): McpServerConfig {
  return {
    serverType: s.serverType,
    command: s.command,
    args: s.args,
    url: s.url,
    headers: s.headers,
    env: s.env,
  };
}
