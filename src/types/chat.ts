/** Roles in the chat */
export type MessageRole = "user" | "assistant";

/** Tool activity — what the agent is currently doing */
export interface ToolActivity {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

/** A single message in the chat */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: number;
  isStreaming?: boolean;
  tools?: ToolActivity[];
}
