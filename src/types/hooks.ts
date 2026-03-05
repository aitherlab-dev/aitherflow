/** All 18 Claude CLI hook events */
export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreCompact"
  | "Notification"
  | "SubagentStart"
  | "SubagentStop"
  | "InstructionsLoaded"
  | "PermissionRequest"
  | "TeammateIdle"
  | "TaskCompleted"
  | "ConfigChange"
  | "WorktreeCreate"
  | "WorktreeRemove";

/** Human-readable descriptions for each event */
export const HOOK_EVENT_DESCRIPTIONS: Record<HookEvent, string> = {
  PreToolUse: "Before a tool executes (can block)",
  PostToolUse: "After a tool executes successfully",
  PostToolUseFailure: "After a tool fails",
  Stop: "When Claude finishes a response",
  SessionStart: "When a session starts or resumes",
  SessionEnd: "When a session ends",
  UserPromptSubmit: "Before a user prompt is processed",
  PreCompact: "Before context compaction",
  Notification: "When Claude sends a notification",
  SubagentStart: "When a subagent starts",
  SubagentStop: "When a subagent finishes",
  InstructionsLoaded: "When CLAUDE.md / rules load",
  PermissionRequest: "When a permission dialog appears",
  TeammateIdle: "When a teammate goes idle",
  TaskCompleted: "When a task is marked complete",
  ConfigChange: "When a config file changes",
  WorktreeCreate: "When a worktree is created",
  WorktreeRemove: "When a worktree is removed",
};

/** Events that support a matcher field */
export const MATCHER_EVENTS: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
];

// ── Handler types ────────────────────────────────────────────────

interface HookHandlerBase {
  timeout?: number;
  once?: boolean;
  statusMessage?: string;
}

export interface CommandHandler extends HookHandlerBase {
  type: "command";
  command: string;
  async?: boolean;
}

export interface PromptHandler extends HookHandlerBase {
  type: "prompt";
  prompt: string;
  model?: string;
}

export interface AgentHandler extends HookHandlerBase {
  type: "agent";
  prompt: string;
}

export interface HttpHandler extends HookHandlerBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
}

export type HookHandler = CommandHandler | PromptHandler | AgentHandler | HttpHandler;

export type HandlerType = HookHandler["type"];

// ── Entry & config ───────────────────────────────────────────────

export interface HookEntry {
  matcher?: string;
  hooks: HookHandler[];
}

/** Full hooks config: event name → array of entries */
export type HooksConfig = Partial<Record<HookEvent, HookEntry[]>>;

export type HookScope = "global" | "project";

// ── Test result ──────────────────────────────────────────────────

export interface HookTestResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}
