import { memo } from "react";
import { StreamdownRenderer } from "../chat/StreamdownRenderer";

interface MarkdownPreviewProps {
  content: string;
  onDoubleClick: () => void;
}

export const MarkdownPreview = memo(function MarkdownPreview({
  content,
  onDoubleClick,
}: MarkdownPreviewProps) {
  return (
    <div className="fv-markdown-preview" onDoubleClick={onDoubleClick}>
      <StreamdownRenderer content={content} />
    </div>
  );
});
