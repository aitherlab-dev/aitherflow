import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  width?: string;
}

export function Modal({ isOpen, onClose, title, children, width = "480px" }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) {
      onClose();
    }
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.6)" }}
    >
      <div
        className="rounded-xl"
        style={{
          width,
          maxHeight: "80vh",
          background: "var(--bg-soft)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        {/* Header */}
        {title && (
          <div
            className="flex items-center justify-between px-5 py-3"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <span className="text-sm font-medium" style={{ color: "var(--fg)" }}>
              {title}
            </span>
            <button
              onClick={onClose}
              className="flex items-center justify-center rounded-md p-1 transition-colors"
              style={{ color: "var(--fg-muted)" }}
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Content */}
        <div className="overflow-y-auto p-5" style={{ maxHeight: "calc(80vh - 48px)" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
