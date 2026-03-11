import { useEffect, useRef, type RefObject } from "react";

/**
 * Close a popup/menu when clicking outside or pressing Escape.
 * Supports multiple refs (e.g. menu + submenu).
 */
export function useClickOutside(
  refs: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
  onClose: () => void,
  capture = false,
): void {
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const refList = Array.isArray(refsRef.current) ? refsRef.current : [refsRef.current];
      const inside = refList.some(
        (r) => r.current && r.current.contains(e.target as Node),
      );
      if (!inside) onCloseRef.current();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") onCloseRef.current();
    };

    document.addEventListener("mousedown", handleClick, { capture });
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick, { capture });
      document.removeEventListener("keydown", handleKey);
    };
  }, [capture]);
}
