import { memo, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Star } from "lucide-react";
import { useSkillStore } from "../../stores/skillStore";
import { useChatStore } from "../../stores/chatStore";
import type { SkillEntry } from "../../types/skills";

interface SkillsMenuProps {
  anchorRect: DOMRect;
  onClose: () => void;
}

export const SkillsMenu = memo(function SkillsMenu({
  anchorRect,
  onClose,
}: SkillsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const getFavorites = useSkillStore((s) => s.getFavorites);
  const favorites = getFavorites();

  // Close on click outside or Escape
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

  const handleSkillClick = useCallback(
    (skill: SkillEntry) => {
      onClose();
      useChatStore.getState().sendMessage(skill.command).catch(console.error);
    },
    [onClose],
  );

  // Position menu above the anchor button
  const menuStyle: React.CSSProperties = {
    position: "fixed",
    right: window.innerWidth - anchorRect.right,
    bottom: window.innerHeight - anchorRect.top + 4,
    zIndex: 1000,
  };

  return createPortal(
    <div ref={menuRef} className="skills-menu" style={menuStyle}>
      {favorites.length === 0 ? (
        <div className="skills-menu__empty">
          No favorite skills yet. Star skills in the sidebar to add them here.
        </div>
      ) : (
        favorites.map((skill) => (
          <button
            key={skill.id}
            className="skills-menu__item"
            onClick={() => handleSkillClick(skill)}
            title={skill.description || skill.name}
          >
            <Star size={12} className="skills-menu__star" />
            <span className="skills-menu__name">{skill.name}</span>
            <span className="skills-menu__command">{skill.command}</span>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
});
