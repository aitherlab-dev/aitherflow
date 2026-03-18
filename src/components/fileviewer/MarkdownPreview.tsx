import { memo } from "react";
import { MarkdownRenderer } from "../chat/MarkdownRenderer";

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
      <MarkdownRenderer content={content} />
    </div>
  );
});
