import { memo, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { useConductorStore } from "../../stores/conductorStore";
import { useClickOutside } from "../../hooks/useClickOutside";

interface ModelDef {
  id: string;
  label: string;
}

const MODELS: ModelDef[] = [
  { id: "sonnet", label: "Sonnet 4.6" },
  { id: "opus", label: "Opus 4.6" },
  { id: "haiku", label: "Haiku 4.5" },
];

const EFFORT_LEVELS: { id: "high" | "medium" | "low"; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

interface ModelMenuProps {
  anchorRect: DOMRect;
  onClose: () => void;
  /** Called when user picks a model (before onClose). If provided, caller handles the switch. */
  onModelSelect?: (modelId: string) => void;
}

export const ModelMenu = memo(function ModelMenu({ anchorRect, onClose, onModelSelect }: ModelMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const selectedModel = useConductorStore((s) => s.selectedModel);
  const selectedEffort = useConductorStore((s) => s.selectedEffort);
  const setSelectedModel = useConductorStore((s) => s.setSelectedModel);
  const setSelectedEffort = useConductorStore((s) => s.setSelectedEffort);

  const [effortFor, setEffortFor] = useState<string | null>(null);
  const [subPos, setSubPos] = useState<{ x: number; y: number } | null>(null);

  useClickOutside([menuRef, subRef], onClose, true);

  // Position menu above the anchor button
  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: anchorRect.left,
    bottom: window.innerHeight - anchorRect.top + 4,
    zIndex: 1000,
  };

  const handleModelClick = useCallback((modelId: string) => {
    if (onModelSelect) {
      onModelSelect(modelId);
    } else {
      setSelectedModel(modelId);
    }
    onClose();
  }, [setSelectedModel, onClose, onModelSelect]);

  const handleContextMenu = useCallback((e: React.MouseEvent, modelId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    setEffortFor(modelId);
    setSubPos({ x: rect.right + 4, y: rect.top });
  }, []);

  const handleEffortClick = useCallback((effortId: "high" | "medium" | "low") => {
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
