import { memo, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "lucide-react";
import { useConductorStore } from "../../stores/conductorStore";
import { useChatStore } from "../../stores/chatStore";
import { useSkillStore } from "../../stores/skillStore";
import { useTranslationStore } from "../../stores/translationStore";

/** Known CLI command descriptions */
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

interface CommandsMenuProps {
  anchorRect: DOMRect;
  onClose: () => void;
}

export const CommandsMenu = memo(function CommandsMenu({
  anchorRect,
  onClose,
}: CommandsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const allCommands = useConductorStore((s) => s.slashCommands);
  const translations = useTranslationStore((s) => s.cache.entries);
  const allSkills = useSkillStore((s) => s.allSkills);

  // Filter out skills — keep only built-in CLI commands
  const commands = useMemo(() => {
    const skillCommands = new Set(
      allSkills().map((s) => s.command.replace(/^\//, "")),
    );
    return allCommands.filter((cmd) => !skillCommands.has(cmd));
  }, [allCommands, allSkills]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick, { capture: true });
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick, { capture: true });
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const handleCommandClick = useCallback(
    (cmd: string) => {
      onClose();
      useChatStore.getState().sendMessage(`/${cmd}`).catch(console.error);
    },
    [onClose],
  );

  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: anchorRect.left,
    bottom: window.innerHeight - anchorRect.top + 4,
    zIndex: 1000,
  };

  return createPortal(
    <div ref={menuRef} className="commands-menu" style={menuStyle}>
      {commands.length === 0 ? (
        <div className="commands-menu__empty">
          No commands available. Start a session first.
        </div>
      ) : (
        commands.map((cmd) => {
          const desc =
            translations[`cmd:${cmd}`] || COMMAND_DESCRIPTIONS[cmd] || "";
          return (
            <button
              key={cmd}
              className="commands-menu__item"
              onClick={() => handleCommandClick(cmd)}
              data-tooltip={desc}
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const menuEl = menuRef.current;
                if (menuEl) {
                  const menuRect = menuEl.getBoundingClientRect();
                  e.currentTarget.style.setProperty(
                    "--tt-top",
                    `${r.top + r.height / 2}px`,
                  );
                  e.currentTarget.style.setProperty(
                    "--tt-left",
                    `${menuRect.right + 8}px`,
                  );
                }
              }}
            >
              <Terminal size={12} className="commands-menu__icon" />
              <span className="commands-menu__name">/{cmd}</span>
            </button>
          );
        })
      )}
    </div>,
    document.body,
  );
});
