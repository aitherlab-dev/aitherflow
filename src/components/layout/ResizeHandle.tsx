import { memo, useCallback, useRef } from "react";
import { useLayoutStore } from "../../stores/layoutStore";

export const ResizeHandle = memo(function ResizeHandle() {
  const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
  const dragging = useRef(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      document.body.classList.add("select-none");
      document.body.style.cursor = "col-resize";
      // Disable sidebar transition during drag so it feels instant
      const sidebar = document.querySelector(".app-sidebar") as HTMLElement | null;
      if (sidebar) sidebar.style.transition = "none";

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        setSidebarWidth(ev.clientX);
      };

      const onUp = () => {
        dragging.current = false;
        document.body.classList.remove("select-none");
        document.body.style.cursor = "";
        if (sidebar) sidebar.style.transition = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setSidebarWidth],
  );

  return (
    <div className="resize-handle" onMouseDown={handleMouseDown} />
  );
});
