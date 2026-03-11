/** Roles in the chat */
type MessageRole = "user" | "assistant";

/** File attachment (image or text) */
export interface Attachment {
  id: string;
  name: string;
  /** data URI: data:image/png;base64,... */
  content: string;
  size: number;
  fileType: "image" | "text";
}

/** Tool activity — what the agent is currently doing */
export interface ToolActivity {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** User's response to an interactive card (set after clicking) */
  userResponse?: string;
  /** control_request ID from CLI — needed to send control_response */
  requestId?: string;
}

/** A single message in the chat */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  timestamp: number;
  isStreaming?: boolean;
  tools?: ToolActivity[];
  attachments?: Attachment[];
}

// ── Interactive tool input shapes ──

/** A single option in AskUserQuestion */
export interface AskOption {
  label: string;
  description?: string;
}

/** A single question in AskUserQuestion */
export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

/** Input shape for AskUserQuestion tool_use */
export interface AskUserQuestionInput {
  questions: AskQuestion[];
}

/** Allowed prompt entry in ExitPlanMode */
export interface AllowedPrompt {
  tool: string;
  prompt: string;
}

/** Input shape for ExitPlanMode tool_use */
export interface ExitPlanModeInput {
  allowedPrompts?: AllowedPrompt[];
}

/** Interactive tool names that require user action */
export const INTERACTIVE_TOOLS = ["AskUserQuestion", "ExitPlanMode"] as const;
export type InteractiveToolName = (typeof INTERACTIVE_TOOLS)[number];

/** Check if a tool name is interactive */
export function isInteractiveTool(toolName: string): toolName is InteractiveToolName {
  return INTERACTIVE_TOOLS.includes(toolName as InteractiveToolName);
}
