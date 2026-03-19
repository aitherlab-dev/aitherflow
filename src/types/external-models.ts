export type Provider = "openrouter" | "groq" | "ollama";

export type VisionStrategy = "auto" | "native_video" | "extract_frames";

export interface ProviderConfig {
  provider: Provider;
  enabled: boolean;
  defaultModel: string;
  baseUrl?: string | null;
}

export interface VisionProfile {
  strategy: VisionStrategy;
  framesPerClip: number | null;
  fps: number | null;
  sceneDetection: boolean;
  sceneThreshold: number;
  resolution: number;
  jpegQuality: number;
}

export interface ExternalModelsConfigWithKeys {
  providers: ProviderConfig[];
  visionProfile: VisionProfile | null;
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
