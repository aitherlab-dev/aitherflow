import { memo, useCallback, useRef } from "react";
import { useLayoutStore } from "../../stores/layoutStore";

export const FileViewerResizeHandle = memo(function FileViewerResizeHandle() {
  const position = useLayoutStore((s) => s.fileViewerPosition);
  const setFileViewerSize = useLayoutStore((s) => s.setFileViewerSize);
  const dragging = useRef(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const isRight = position === "right";
      document.body.classList.add("select-none");
      document.body.style.cursor = isRight ? "col-resize" : "row-resize";

      // Disable transitions during drag
      const wrapper = document.querySelector(
        ".file-viewer-wrapper",
      ) as HTMLElement | null;
      if (wrapper) wrapper.style.transition = "none";

      let rafId = 0;
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          if (isRight) {
            const newSize = window.innerWidth - ev.clientX;
            setFileViewerSize(newSize);
          } else {
            const main = document.querySelector(".app-main") as HTMLElement | null;
            if (main) {
              const rect = main.getBoundingClientRect();
              const newSize = rect.bottom - ev.clientY;
              setFileViewerSize(newSize);
            }
          }
        });
      };

      const onUp = () => {
        cancelAnimationFrame(rafId);
        dragging.current = false;
        document.body.classList.remove("select-none");
        document.body.style.cursor = "";
        if (wrapper) wrapper.style.transition = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [position, setFileViewerSize],
  );

  return (
    <div
      className={`fv-resize-handle fv-resize-handle--${position}`}
      onMouseDown={handleMouseDown}
    />
  );
});
