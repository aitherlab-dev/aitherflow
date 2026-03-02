import { memo, useState, useCallback, useRef } from "react";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";

interface ImageViewerProps {
  filePath: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export const ImageViewer = memo(function ImageViewer({
  filePath,
}: ImageViewerProps) {
  const [zoom, setZoom] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  const imgSrc = convertFileSrc(filePath);

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP));
  }, []);

  const handleReset = useCallback(() => {
    setZoom(1);
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom((z) => {
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z + delta));
    });
  }, []);

  return (
    <div className="fv-image-viewer" ref={containerRef}>
      <div className="fv-image-toolbar">
        <button
          className="fv-image-btn"
          onClick={handleZoomOut}
          title="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <span className="fv-image-zoom">{Math.round(zoom * 100)}%</span>
        <button
          className="fv-image-btn"
          onClick={handleZoomIn}
          title="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <button
          className="fv-image-btn"
          onClick={handleReset}
          title="Reset zoom"
        >
          <RotateCcw size={14} />
        </button>
      </div>
      <div className="fv-image-container" onWheel={handleWheel}>
        <img
          src={imgSrc}
          alt={filePath.split("/").pop() ?? "image"}
          style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
          className="fv-image"
          draggable={false}
        />
      </div>
    </div>
  );
});
