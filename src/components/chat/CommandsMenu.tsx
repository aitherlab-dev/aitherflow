import { memo, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "lucide-react";
import { useConductorStore } from "../../stores/conductorStore";
import { sendMessage } from "../../stores/chatService";
import { useSkillStore } from "../../stores/skillStore";
import { useTranslationStore } from "../../stores/translationStore";
import { COMMAND_DESCRIPTIONS } from "../../data/commandDescriptions";
import { useClickOutside } from "../../hooks/useClickOutside";

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

  useClickOutside(menuRef, onClose, true);

  const handleCommandClick = useCallback(
    (cmd: string) => {
      onClose();
      sendMessage(`/${cmd}`).catch(console.error);
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
