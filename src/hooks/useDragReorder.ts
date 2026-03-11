import { useState, useCallback, useRef } from "react";

interface DragState<T> {
  /** Currently dragged item identifier */
  dragId: T | null;
  /** Current mouse position */
  dragPos: { x: number; y: number };
  /** Offset from element top-left corner */
  dragOffset: { x: number; y: number };
  /** Drop target identifier */
  dropTargetId: T | null;
  /** Whether movement has started */
  dragging: boolean;
}

interface UseDragReorderReturn<T> {
  dragId: T | null;
  dragPos: { x: number; y: number };
  dragOffset: { x: number; y: number };
  dropTargetId: T | null;
  dragging: boolean;
  /** Ref for the grid/container element */
  gridRef: React.RefObject<HTMLDivElement | null>;
  /** Ref for the currently dragged element (for measuring ghost size) */
  dragElRef: React.RefObject<HTMLElement | null>;
  /** Call on pointer down (requires Shift key) */
  handlePointerDown: (e: React.PointerEvent, id: T) => void;
  /** Call on pointer move */
  handlePointerMove: (e: React.PointerEvent) => void;
  /** Call on pointer up */
  handlePointerUp: (e: React.PointerEvent) => void;
}

/**
 * Shared Shift+pointer drag-reorder logic.
 *
 * @param dataAttr - data-attribute name to query items (e.g. "cardIdx", "cardId")
 * @param onReorder - called with (fromId, toId) when drop completes
 */
export function useDragReorder<T extends string | number>(
  dataAttr: string,
  onReorder: (fromId: T, toId: T) => void,
): UseDragReorderReturn<T> {
  const [state, setState] = useState<DragState<T>>({
    dragId: null,
    dragPos: { x: 0, y: 0 },
    dragOffset: { x: 0, y: 0 },
    dropTargetId: null,
    dragging: false,
  });
  const dragElRef = useRef<HTMLElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const findAtPoint = useCallback(
    (x: number, y: number, excludeId: T): T | null => {
      if (!gridRef.current) return null;
      const items = gridRef.current.querySelectorAll<HTMLElement>(`[data-${dataAttr}]`);
      for (const item of items) {
        const val = item.dataset[toCamelCase(dataAttr)];
        if (val == null) continue;
        const id = (typeof excludeId === "number" ? Number(val) : val) as T;
        if (id === excludeId) continue;
        const rect = item.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return id;
      }
      return null;
    },
    [dataAttr],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, id: T) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      dragElRef.current = target;
      setState({
        dragId: id,
        dragOffset: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        dragPos: { x: e.clientX, y: e.clientY },
        dropTargetId: null,
        dragging: false,
      });
      target.setPointerCapture(e.pointerId);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      setState((prev) => {
        if (prev.dragId === null) return prev;
        const pos = { x: e.clientX, y: e.clientY };
        const target = findAtPoint(e.clientX, e.clientY, prev.dragId);
        return { ...prev, dragging: true, dragPos: pos, dropTargetId: target };
      });
    },
    [findAtPoint],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      setState((prev) => {
        if (prev.dragId === null) return prev;
        if (dragElRef.current) dragElRef.current.releasePointerCapture(e.pointerId);
        if (prev.dragging && prev.dropTargetId !== null && prev.dropTargetId !== prev.dragId) {
          onReorder(prev.dragId, prev.dropTargetId);
        }
        dragElRef.current = null;
        return { dragId: null, dragPos: { x: 0, y: 0 }, dragOffset: { x: 0, y: 0 }, dropTargetId: null, dragging: false };
      });
    },
    [onReorder],
  );

  return {
    dragId: state.dragId,
    dragPos: state.dragPos,
    dragOffset: state.dragOffset,
    dropTargetId: state.dropTargetId,
    dragging: state.dragging,
    gridRef,
    dragElRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}

/** Convert kebab-case data attr name to camelCase for dataset access */
function toCamelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
