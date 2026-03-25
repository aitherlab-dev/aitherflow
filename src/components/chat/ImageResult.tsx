import { memo, useState, useEffect, useCallback } from "react";
import { Maximize2 } from "lucide-react";
import { convertFileSrc } from "../../lib/transport";
import { useFileViewerStore } from "../../stores/fileViewerStore";

interface ImageResultProps {
  filePath: string;
}

export const ImageResult = memo(function ImageResult({ filePath }: ImageResultProps) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    convertFileSrc(filePath)
      .then(setSrc)
      .catch((e) => { console.error(e); setError(true); });
  }, [filePath]);

  const handleClick = useCallback(() => {
    useFileViewerStore.getState().openPreview(filePath).catch(console.error);
  }, [filePath]);

  if (error || !src) return null;

  return (
    <div className="imgresult-container">
      <img
        src={src}
        alt="Generated image"
        className="imgresult-image"
        draggable={false}
        onClick={handleClick}
      />
      <button className="imgresult-expand" onClick={handleClick} type="button">
        <Maximize2 size={14} />
      </button>
    </div>
  );
});
