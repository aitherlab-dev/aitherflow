import { useState, useEffect } from "react";
import { getCurrentWindow } from "../lib/transport";

/**
 * Subscribes to Tauri drag-drop events and provides isDragOver state.
 */
export function useTauriDragDrop(
  processFromPaths: (paths: string[]) => Promise<void>,
) {
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;

    getCurrentWindow().then((win) => {
      if (cancelled) return;
      const unlisten = win.onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "drop") {
          setIsDragOver(false);
          processFromPaths(p.paths).catch(console.error);
        } else if (p.type === "over") {
          setIsDragOver(true);
        } else if (p.type === "leave") {
          setIsDragOver(false);
        }
      });
      unlisten.then((fn: () => void) => {
        if (cancelled) fn();
        else cleanup = fn;
      });
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [processFromPaths]);

  return { isDragOver, setIsDragOver };
}
