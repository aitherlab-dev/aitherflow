/** Known CLI command descriptions (English defaults for translation) */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  compact:
    "Clear conversation history but keep a summary in context. Frees up token space for long sessions. Optionally add custom summarization instructions.",
  context:
    "Show current context window usage as a detailed breakdown — system prompt, tools, MCP servers, messages, skills, and free space.",
  cost: "Show the total API cost and duration of the current session.",
  clear:
    "Clear all conversation history and free up context. Starts fresh without ending the session.",
  config: "Open Claude Code settings editor to configure tools, permissions, themes, and other CLI preferences.",
  "release-notes": "Show the release notes for the current Claude Code version.",
  model: "Switch the active language model (Sonnet, Opus, Haiku) for the current session.",
  permissions: "View and manage tool permission rules for the current project.",
  login: "Sign in to your Anthropic account or switch between accounts.",
  logout: "Sign out of your Anthropic account.",
  status: "Show account status — plan type, usage limits, and authentication info.",
  doctor:
    "Run diagnostics to check Claude Code health — authentication, API connectivity, and auto-updater status.",
  "extra-usage":
    "Configure extra usage to keep working when your plan limits are hit.",
  files: "List all files currently loaded in the conversation context.",
  vim: "Toggle between Vim and normal (readline) editing modes in the input.",
  theme: "Change the CLI color theme.",
  color: "Set the prompt bar color for this session.",
  voice: "Toggle voice input mode for hands-free interaction.",
  fast: "Toggle fast mode — uses the same model with faster output generation.",
  mcp: "View and manage Model Context Protocol (MCP) server connections.",
  "add-dir": "Add an additional directory to the tool access scope.",
  review: "Review code changes on the current branch.",
  "approved-tools": "View and manage the list of pre-approved tools.",
  "allowed-tools": "View and manage allowed tool patterns.",
  feedback: "Send feedback to the Claude Code team.",
  bug: "Report a bug with diagnostic information.",
  init: "Initialize Claude Code project settings in the current directory.",
  "terminal-setup":
    "Set up terminal integration for shell hooks and completions.",
  "install-github-app":
    "Set up the Claude GitHub Actions app for a repository.",
  "install-slack-app": "Install the Claude Slack app for team collaboration.",
  "reload-plugins":
    "Activate pending plugin changes in the current session without restarting.",
  usage: "Show your plan usage limits and current consumption.",
  keybindings: "Open or create the keybindings configuration file.",
  ide: "Connect to an IDE (VS Code, JetBrains) for integrated editing.",
  resume: "Resume a previous conversation by session ID.",
  stickers: "Order Claude Code stickers from the merch store.",
  help: "Show help and available commands.",
  fork: "Create a fork of the current conversation at this point.",
  hooks: "Manage hook configurations for tool events.",
  worktree: "Create a git worktree for parallel work on a separate branch.",
  memory: "View and manage Claude's project memory files.",
  listen: "Toggle listen mode — Claude observes terminal without acting.",
  profile: "Switch between saved configuration profiles.",
  "pr-comments": "Review and respond to PR comments on the current branch.",
  "security-review": "Run a security-focused review of code changes.",
  insights: "Show conversation insights and statistics.",
  debug: "Toggle debug mode for verbose diagnostic output.",
  batch: "Submit a task for asynchronous batch processing.",
};
