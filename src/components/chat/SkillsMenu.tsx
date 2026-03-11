import { memo, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Star } from "lucide-react";
import { useSkillStore } from "../../stores/skillStore";
import { useAgentStore } from "../../stores/agentStore";
import { sendMessage } from "../../stores/chatService";
import { useTranslationStore } from "../../stores/translationStore";
import type { SkillEntry } from "../../types/skills";
import { useClickOutside } from "../../hooks/useClickOutside";

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
  const allFavorites = getFavorites();
  const favorites = useMemo(
    () => {
      const agentState = useAgentStore.getState();
      const projectPath = agentState.agents.find((a) => a.id === agentState.activeAgentId)?.projectPath;
      return allFavorites.filter((s) =>
        s.source.type !== "project" || s.source.projectPath === projectPath,
      );
    },
    [allFavorites],
  );
  const translations = useTranslationStore((s) => s.cache.entries);

  useClickOutside(menuRef, onClose, true);

  const handleSkillClick = useCallback(
    (skill: SkillEntry) => {
      onClose();
      sendMessage(skill.command).catch(console.error);
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
            title={translations[`skill:${skill.id}`] || skill.description || skill.name}
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
