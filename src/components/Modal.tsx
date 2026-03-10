import { memo, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface ModalAction {
  label: string;
  variant?: "default" | "accent" | "danger";
  disabled?: boolean;
  onClick: () => void;
}

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  actions?: ModalAction[];
  children: React.ReactNode;
}

export const Modal = memo(function Modal({
  open,
  title,
  onClose,
  actions,
  children,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Close on overlay click
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  if (!open) return null;

  return createPortal(
    <div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="modal-card">
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <button className="modal-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && actions.length > 0 && (
          <div className="modal-footer">
            {actions.map((a) => (
              <button
                key={a.label}
                className={`modal-btn modal-btn--${a.variant ?? "default"}`}
                onClick={a.onClick}
                disabled={a.disabled}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
});
