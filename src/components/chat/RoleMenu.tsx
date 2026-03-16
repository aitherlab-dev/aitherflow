import { memo, useRef, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { invoke } from "../../lib/transport";
import { useConductorStore } from "../../stores/conductorStore";
import { useChatStore } from "../../stores/chatStore";
import { useClickOutside } from "../../hooks/useClickOutside";
import type { AgentRole, RoleEntry } from "../../types/team";

interface RoleMenuProps {
  anchorRect: DOMRect;
  onClose: () => void;
}

export const RoleMenu = memo(function RoleMenu({ anchorRect, onClose }: RoleMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const agentId = useChatStore((s) => s.agentId);
  const currentRole = useConductorStore((s) => s.agentRoles[agentId] ?? null);
  const setAgentRole = useConductorStore((s) => s.setAgentRole);

  const [roles, setRoles] = useState<RoleEntry[]>([]);

  useClickOutside([menuRef], onClose, true);

  useEffect(() => {
    invoke<RoleEntry[]>("roles_list")
      .then(setRoles)
      .catch(console.error);
  }, []);

  const handleSelect = useCallback((role: AgentRole | null) => {
    setAgentRole(agentId, role);
    onClose();
  }, [agentId, setAgentRole, onClose]);

  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: anchorRect.left,
    bottom: window.innerHeight - anchorRect.top + 4,
    zIndex: 1000,
  };

  return createPortal(
    <div ref={menuRef} className="model-menu" style={menuStyle}>
      <button
        className={`model-menu__item ${currentRole === null ? "model-menu__item--active" : ""}`}
        onClick={() => handleSelect(null)}
      >
        <span className="model-menu__check">
          {currentRole === null && <Check size={14} />}
        </span>
        <span className="model-menu__label">No role</span>
      </button>
      {roles.map((entry) => {
        const isActive = currentRole?.name === entry.name;
        return (
          <button
            key={entry.name}
            className={`model-menu__item ${isActive ? "model-menu__item--active" : ""}`}
            onClick={() => handleSelect(entry)}
          >
            <span className="model-menu__check">
              {isActive && <Check size={14} />}
            </span>
            <span className="model-menu__label">{entry.name}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
});
