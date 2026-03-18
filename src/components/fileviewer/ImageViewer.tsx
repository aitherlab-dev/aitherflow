import { memo, useState, useCallback, useRef, useEffect } from "react";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { convertFileSrc } from "../../lib/transport";
import { Tooltip } from "../shared/Tooltip";

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
  const [imgSrc, setImgSrc] = useState("");

  useEffect(() => {
    convertFileSrc(filePath).then(setImgSrc).catch(console.error);
  }, [filePath]);

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
        <Tooltip text="Zoom out">
          <button
            className="fv-image-btn"
            onClick={handleZoomOut}
          >
            <ZoomOut size={14} />
          </button>
        </Tooltip>
        <span className="fv-image-zoom">{Math.round(zoom * 100)}%</span>
        <Tooltip text="Zoom in">
          <button
            className="fv-image-btn"
            onClick={handleZoomIn}
          >
            <ZoomIn size={14} />
          </button>
        </Tooltip>
        <Tooltip text="Reset zoom">
          <button
            className="fv-image-btn"
            onClick={handleReset}
          >
            <RotateCcw size={14} />
          </button>
        </Tooltip>
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
