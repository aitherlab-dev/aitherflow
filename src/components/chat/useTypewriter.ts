import { useState, useRef, useEffect, useCallback } from "react";

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

  const targetLen = targetText.length;
  targetLenRef.current = targetLen;

  const tick = useCallback(() => {
    const target = targetLenRef.current;
    const current = visibleLenRef.current;

    if (current < target) {
      const remaining = target - current;
      const speed = Math.max(2, Math.min(12, Math.ceil(remaining / 10)));
      const next = Math.min(current + speed, target);
      visibleLenRef.current = next;
      setVisibleLen(next);
      rafRef.current = requestAnimationFrame(tick);
    } else {
      rafRef.current = null;
    }
  }, []);

  // Restart RAF loop when new content arrives and loop is paused
  useEffect(() => {
    if (isActive && rafRef.current === null && targetLenRef.current > visibleLenRef.current) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [isActive, targetLen, tick]);

  useEffect(() => {
    if (!isActive) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      visibleLenRef.current = targetLenRef.current;
      setVisibleLen(targetLenRef.current);
      return;
    }

    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isActive, tick]);

  if (!isActive) return targetText;
  return targetText.slice(0, visibleLen);
}
