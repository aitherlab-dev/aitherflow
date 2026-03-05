import { Shield, FileText, Bell } from "lucide-react";
import type { HooksConfig } from "../../../types/hooks";

interface Props {
  onApply: (template: HooksConfig) => void;
  onClose: () => void;
}

const TEMPLATES: { id: string; icon: typeof Shield; label: string; desc: string; config: HooksConfig }[] = [
  {
    id: "block-dangerous",
    icon: Shield,
    label: "Block dangerous commands",
    desc: "Prevents rm -rf /, sudo, chmod 777 in Bash",
    config: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command:
                'input=$(cat); cmd=$(echo "$input" | grep -oP \'"command"\\s*:\\s*"\\K[^"]+\'); ' +
                'if echo "$cmd" | grep -qE "(rm\\s+-rf\\s+/|sudo\\s|chmod\\s+777)"; then ' +
                'echo \'{"decision":"block","reason":"Dangerous command blocked"}\' >&2; exit 2; fi',
              statusMessage: "Checking command safety...",
            },
          ],
        },
      ],
    },
  },
  {
    id: "session-logging",
    icon: FileText,
    label: "Session logging",
    desc: "Logs session start/end to ~/claude-sessions.log",
    config: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command:
                'echo "[$(date +%Y-%m-%dT%H:%M:%S)] Session started: $(cat | jq -r .session_id)" >> ~/claude-sessions.log',
              statusMessage: "Logging session start...",
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command:
                'echo "[$(date +%Y-%m-%dT%H:%M:%S)] Session ended: $(cat | jq -r .session_id)" >> ~/claude-sessions.log',
              statusMessage: "Logging session end...",
            },
          ],
        },
      ],
    },
  },
  {
    id: "notify-complete",
    icon: Bell,
    label: "Desktop notification on stop",
    desc: "Sends a notification when Claude finishes a response",
    config: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: 'notify-send "Claude Code" "Task completed" 2>/dev/null || osascript -e \'display notification "Task completed" with title "Claude Code"\' 2>/dev/null || true',
              statusMessage: "Sending desktop notification...",
            },
          ],
        },
      ],
    },
  },
];

export function HooksTemplates({ onApply, onClose }: Props) {
  return (
    <div className="hooks-templates-dropdown">
      {TEMPLATES.map((t) => (
        <button
          key={t.id}
          className="hooks-template-item"
          onClick={() => { onApply(t.config); onClose(); }}
        >
          <t.icon size={14} className="hooks-template-icon" />
          <div className="hooks-template-info">
            <span className="hooks-template-label">{t.label}</span>
            <span className="hooks-template-desc">{t.desc}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
