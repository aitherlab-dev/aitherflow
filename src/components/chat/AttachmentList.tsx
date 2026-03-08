import { memo } from "react";
import { X } from "lucide-react";
import type { Attachment } from "../../types/chat";

interface AttachmentListProps {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}

export const AttachmentList = memo(function AttachmentList({ attachments, onRemove }: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="attachment-chips">
      {attachments.map((att) => (
        <div key={att.id} className={`attachment-chip ${att.fileType === "image" ? "attachment-chip--image" : "attachment-chip--file"}`}>
          <button
            className="attachment-chip-remove"
            onClick={() => onRemove(att.id)}
            title="Remove"
          >
            <X size={10} />
          </button>
          {att.fileType === "image" ? (
            <img
              src={att.content}
              alt={att.name}
              className="attachment-chip-preview"
            />
          ) : (
            <>
              <span className="attachment-chip-name">{att.name}</span>
              <span className="attachment-chip-ext">
                {att.name.includes(".") ? att.name.split(".").pop()!.toUpperCase() : "FILE"}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
});
