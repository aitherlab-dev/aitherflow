export type Provider = "openrouter" | "groq";

export interface ProviderConfig {
  provider: Provider;
  enabled: boolean;
  defaultModel: string;
}

export interface ExternalModelsConfig {
  providers: ProviderConfig[];
  openrouterApiKey: string;
  groqApiKey: string;
}

export interface McpStatus {
  running: boolean;
  port: number | null;
}

export interface ModelInfo {
  id: string;
  name: string | null;
  context_length: number | null;
}
