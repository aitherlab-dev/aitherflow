/** Events emitted by the conductor (Rust backend) via "cli-event" */
export type CliEvent =
  | { type: "sessionId"; agent_id: string; session_id: string }
  | { type: "streamChunk"; agent_id: string; text: string }
  | { type: "messageComplete"; agent_id: string; text: string }
  | { type: "modelInfo"; agent_id: string; model: string }
  | {
      type: "usageInfo";
      agent_id: string;
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      cost_usd: number;
      context_window: number;
    }
  | {
      type: "toolUse";
      agent_id: string;
      tool_use_id: string;
      tool_name: string;
      tool_input: Record<string, unknown>;
    }
  | {
      type: "toolResult";
      agent_id: string;
      tool_use_id: string;
      output_preview: string;
      is_error: boolean;
    }
  | { type: "turnComplete"; agent_id: string }
  | { type: "processExited"; agent_id: string; exit_code: number | null }
  | { type: "error"; agent_id: string; message: string };

/** Attachment payload sent to Rust */
export interface AttachmentPayload {
  name: string;
  content: string;
  fileType: "image" | "text";
}

/** Options for starting a new CLI session */
export interface StartSessionOptions {
  agentId?: string;
  prompt: string;
  projectPath?: string;
  model?: string;
  effort?: string;
  resumeSessionId?: string;
  permissionMode?: string;
  chrome?: boolean;
  attachments?: AttachmentPayload[];
}

/** Options for sending a follow-up message */
export interface SendMessageOptions {
  agentId?: string;
  prompt: string;
  attachments?: AttachmentPayload[];
}
