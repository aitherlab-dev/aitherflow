export interface McpServerConfig {
  serverType: string; // "stdio" | "sse" | "http"
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env: Record<string, string>;
}

export interface McpServer {
  name: string;
  serverType: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env: Record<string, string>;
}

export interface McpData {
  global: McpServer[];
  project: McpServer[];
  globalPath: string;
  projectPath: string | null;
}

export interface McpTestResult {
  ok: boolean;
  message: string;
}
