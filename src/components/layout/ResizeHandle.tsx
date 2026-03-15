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

      let rafId = 0;
      let lastX = 0;

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        lastX = ev.clientX;
        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            if (dragging.current) setSidebarWidth(lastX);
          });
        }
      };

      const onUp = () => {
        dragging.current = false;
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
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
