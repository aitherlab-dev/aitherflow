import { useEffect, type RefObject } from "react";

/**
 * Close a popup/menu when clicking outside or pressing Escape.
 * Supports multiple refs (e.g. menu + submenu).
 */
export function useClickOutside(
  refs: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
  onClose: () => void,
  capture = false,
): void {
  useEffect(() => {
    const refList = Array.isArray(refs) ? refs : [refs];

    const handleClick = (e: MouseEvent) => {
      const inside = refList.some(
        (r) => r.current && r.current.contains(e.target as Node),
      );
      if (!inside) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleClick, { capture });
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick, { capture });
      document.removeEventListener("keydown", handleKey);
    };
  }, [refs, onClose, capture]);
}
