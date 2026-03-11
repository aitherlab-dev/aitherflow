import { memo, useCallback, useEffect, useState } from "react";
import { useMcpStore } from "../../stores/mcpStore";
import { useSkillStore } from "../../stores/skillStore";
import { useAgentStore } from "../../stores/agentStore";
import { useProjectStore } from "../../stores/projectStore";
import { useDragReorder } from "../../hooks/useDragReorder";
import { McpCard } from "./cards/McpCard";
import { SkillsCard } from "./cards/SkillsCard";
import { TokensCard } from "./cards/TokensCard";

const EXPANDED_KEY = "aitherflow:dashboard:expanded";
const ORDER_KEY = "aitherflow:dashboard:order";

const DEFAULT_ORDER = ["mcp", "skills", "tokens"];

const CARD_COMPONENTS: Record<string, React.ComponentType<{ expanded: boolean; onToggle: (id: string) => void }>> = {
  mcp: McpCard,
  skills: SkillsCard,
  tokens: TokensCard,
};

function loadExpandedCards(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function saveExpandedCards(cards: Set<string>) {
  localStorage.setItem(EXPANDED_KEY, JSON.stringify([...cards]));
}

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (raw) {
      const order = JSON.parse(raw) as string[];
      const missing = DEFAULT_ORDER.filter((id) => !order.includes(id));
      return [...order.filter((id) => DEFAULT_ORDER.includes(id)), ...missing];
    }
  } catch { /* ignore */ }
  return [...DEFAULT_ORDER];
}

function saveOrder(order: string[]) {
  localStorage.setItem(ORDER_KEY, JSON.stringify(order));
}

export const DashboardPanel = memo(function DashboardPanel() {
  const [expandedCards, setExpandedCards] = useState<Set<string>>(loadExpandedCards);
  const [cardOrder, setCardOrder] = useState<string[]>(loadOrder);

  const handleReorder = useCallback((fromId: string, toId: string) => {
    setCardOrder((prev) => {
      const next = [...prev];
      const fromIdx = next.indexOf(fromId);
      const toIdx = next.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      next.splice(fromIdx, 1);
      next.splice(toIdx, 0, fromId);
      saveOrder(next);
      return next;
    });
  }, []);
  const {
    dragId, dragPos, dragOffset, dropTargetId, dragging,
    gridRef, dragElRef, handlePointerDown, handlePointerMove, handlePointerUp,
  } = useDragReorder<string>("card-id", handleReorder);

  const mcpNeedsReload = useMcpStore((s) => s.needsReload);
  const mcpLoad = useMcpStore((s) => s.load);
  const skillsLoaded = useSkillStore((s) => s.loaded);
  const skillsLoad = useSkillStore((s) => s.load);
  const activeProjectPath = useAgentStore(
    (s) => s.agents.find((a) => a.id === s.activeAgentId)?.projectPath,
  );

  useEffect(() => {
    if (mcpNeedsReload(activeProjectPath)) {
      mcpLoad(activeProjectPath).catch(console.error);
    }
  }, [activeProjectPath, mcpNeedsReload, mcpLoad]);

  useEffect(() => {
    if (!skillsLoaded) {
      const allProjects = useProjectStore.getState().projects;
      skillsLoad(allProjects.map((p) => ({ path: p.path, name: p.name }))).catch(console.error);
    }
  }, [skillsLoaded, skillsLoad]);

  const handleToggle = useCallback((id: string) => {
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveExpandedCards(next);
      return next;
    });
  }, []);


  return (
    <div className="dash-panel">
      {/* Card list — each card expands/collapses in place */}
      <div className="dash-grid" ref={gridRef}>
        {cardOrder.map((id) => {
          const Component = CARD_COMPONENTS[id];
          if (!Component) return null;
          const isActive = expandedCards.has(id);
          const isDragging = dragId === id && dragging;
          const isDropTarget = dropTargetId === id;
          return (
            <div
              key={id}
              data-card-id={id}
              onPointerDown={(e) => handlePointerDown(e, id)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              className={`dash-btn-wrapper${isActive ? " dash-btn-wrapper--active" : ""}${isDragging ? " dash-btn-wrapper--dragging" : ""}${isDropTarget ? " dash-btn-wrapper--drop-target" : ""}`}
            >
              <Component expanded={isActive} onToggle={handleToggle} />
            </div>
          );
        })}
      </div>

      {/* Drag ghost */}
      {dragId && dragging && dragElRef.current && (
        <div
          className="dash-card-ghost"
          style={{
            left: dragPos.x - dragOffset.x,
            top: dragPos.y - dragOffset.y,
            width: dragElRef.current.offsetWidth,
          }}
        >
          {(() => {
            const Component = CARD_COMPONENTS[dragId];
            if (!Component) return null;
            return <Component expanded={false} onToggle={() => {}} />;
          })()}
        </div>
      )}
    </div>
  );
});
