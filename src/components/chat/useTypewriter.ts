import { useState, useRef, useEffect } from "react";

/**
 * Typewriter hook: gradually reveals targetText at ~60fps.
 * Adaptive speed — catches up quickly on large chunks, slows down on small ones.
 * When isActive becomes false, immediately returns full text.
 */
export function useTypewriter(targetText: string, isActive: boolean): string {
  const [visibleLen, setVisibleLen] = useState(0);
  const targetLenRef = useRef(0);
  const visibleLenRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  targetLenRef.current = targetText.length;

  useEffect(() => {
    if (!isActive) {
      // Streaming ended — show everything, stop loop
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      visibleLenRef.current = targetLenRef.current;
      setVisibleLen(targetLenRef.current);
      return;
    }

    function tick() {
      const target = targetLenRef.current;
      const current = visibleLenRef.current;

      if (current < target) {
        const remaining = target - current;
        // Adaptive: min 2 chars/frame, ramp up with buffer size, cap at 12
        const speed = Math.max(2, Math.min(12, Math.ceil(remaining / 10)));
        const next = Math.min(current + speed, target);
        visibleLenRef.current = next;
        setVisibleLen(next);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isActive]);

  if (!isActive) return targetText;
  return targetText.slice(0, visibleLen);
}
