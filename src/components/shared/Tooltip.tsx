import { useState, useCallback, useRef, useEffect, memo, cloneElement } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_GAP = 8;
const TOOLTIP_MAX_WIDTH = 360;

interface TooltipProps {
  text: string;
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  delay?: number;
}

export const Tooltip = memo(function Tooltip({
  text,
  children,
  delay = 400,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  const handleEnter = useCallback((e: React.MouseEvent<HTMLElement>) => {
    children.props.onMouseEnter?.(e);
    const el = e.currentTarget;
    timerRef.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const top = r.top + r.height / 2;
      // Show on right by default; flip to left if it would overflow
      const rightPos = r.right + TOOLTIP_GAP;
      const leftPos = r.left - TOOLTIP_GAP - TOOLTIP_MAX_WIDTH;
      const left = rightPos + TOOLTIP_MAX_WIDTH > window.innerWidth
        ? Math.max(0, leftPos)
        : rightPos;
      setPos({ top, left });
      setVisible(true);
    }, delay);
  }, [delay, children.props]);

  const handleLeave = useCallback((e: React.MouseEvent<HTMLElement>) => {
    children.props.onMouseLeave?.(e);
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, [children.props]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!text) {
    return children;
  }

  return (
    <>
      {cloneElement(children, {
        onMouseEnter: handleEnter,
        onMouseLeave: handleLeave,
      })}
      {visible &&
        createPortal(
          <div
            className="portal-tooltip"
            style={{ top: pos.top, left: pos.left }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
});
