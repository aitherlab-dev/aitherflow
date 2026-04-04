export type VisionStrategy = "auto" | "native_video" | "extract_frames";

export interface ProviderConfig {
  id: string;
  name: string;
  providerType: string; // "openai_compatible" | "ollama"
  baseUrl: string;
  defaultModel: string;
  enabled: boolean;
  requiresApiKey: boolean;
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
  keys: Record<string, string>; // provider id → masked key
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
