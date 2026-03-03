import { memo, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { useConductorStore } from "../../stores/conductorStore";

interface ModelDef {
  id: string;
  label: string;
}

const MODELS: ModelDef[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];

const EFFORT_LEVELS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

interface ModelMenuProps {
  anchorRect: DOMRect;
  onClose: () => void;
}

export const ModelMenu = memo(function ModelMenu({ anchorRect, onClose }: ModelMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const selectedModel = useConductorStore((s) => s.selectedModel);
  const selectedEffort = useConductorStore((s) => s.selectedEffort);
  const setSelectedModel = useConductorStore((s) => s.setSelectedModel);
  const setSelectedEffort = useConductorStore((s) => s.setSelectedEffort);

  const [effortFor, setEffortFor] = useState<string | null>(null);
  const [subPos, setSubPos] = useState<{ x: number; y: number } | null>(null);

  // Close on click outside or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        (!subRef.current || !subRef.current.contains(e.target as Node))
      ) {
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

  // Position menu above the anchor button
  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: anchorRect.left,
    bottom: window.innerHeight - anchorRect.top + 4,
    zIndex: 1000,
  };

  const handleModelClick = useCallback((modelId: string) => {
    setSelectedModel(modelId);
    onClose();
  }, [setSelectedModel, onClose]);

  const handleContextMenu = useCallback((e: React.MouseEvent, modelId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    setEffortFor(modelId);
    setSubPos({ x: rect.right + 4, y: rect.top });
  }, []);

  const handleEffortClick = useCallback((effortId: string) => {
    setSelectedEffort(effortId);
    // If the user picked effort for a different model, also switch to that model
    if (effortFor && effortFor !== selectedModel) {
      setSelectedModel(effortFor);
    }
    setEffortFor(null);
    onClose();
  }, [effortFor, selectedModel, setSelectedEffort, setSelectedModel, onClose]);

  return createPortal(
    <>
      <div ref={menuRef} className="model-menu" style={menuStyle}>
        {MODELS.map((m) => (
          <button
            key={m.id}
            className={`model-menu__item ${m.id === selectedModel ? "model-menu__item--active" : ""}`}
            onClick={() => handleModelClick(m.id)}
            onContextMenu={(e) => handleContextMenu(e, m.id)}
          >
            <span className="model-menu__check">
              {m.id === selectedModel && <Check size={14} />}
            </span>
            <span className="model-menu__label">{m.label}</span>
            <span className="model-menu__hint">
              <ChevronRight size={12} />
            </span>
          </button>
        ))}
      </div>
      {effortFor && subPos && (
        <div
          ref={subRef}
          className="model-menu model-menu--sub"
          style={{ position: "fixed", left: subPos.x, top: subPos.y, zIndex: 1001 }}
        >
          {EFFORT_LEVELS.map((e) => (
            <button
              key={e.id}
              className={`model-menu__item ${e.id === selectedEffort ? "model-menu__item--active" : ""}`}
              onClick={() => handleEffortClick(e.id)}
            >
              <span className="model-menu__check">
                {e.id === selectedEffort && <Check size={14} />}
              </span>
              <span className="model-menu__label">{e.label}</span>
            </button>
          ))}
        </div>
      )}
    </>,
    document.body,
  );
});
