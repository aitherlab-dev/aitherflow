/**
 * React hook that bridges Telegram bot with the app.
 *
 * - Polls incoming messages and routes them via telegramService
 * - Watches isThinking transitions to stream responses to Telegram
 * - Cleans up on unmount (fixes BUG-005: poll interval leak)
 */

import { useEffect, useRef } from "react";
import { useChatStore } from "../stores/chatStore";
import {
  pollAndHandle,
  startStreaming,
  finishStreaming,
  cleanupStreaming,
} from "../services/telegramService";

export function useTelegramBridge() {
  const prevIsThinking = useRef(false);
  const abortRef = useRef(false);

  // Poll incoming messages
  useEffect(() => {
    abortRef.current = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    function poll() {
      if (abortRef.current) return;
      pollAndHandle().catch(console.error);
    }

    timer = setInterval(poll, 1000);

    return () => {
      abortRef.current = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);

  // Stream agent responses to Telegram
  useEffect(() => {
    const unsub = useChatStore.subscribe((state) => {
      const wasThinking = prevIsThinking.current;
      prevIsThinking.current = state.isThinking;

      // Transition: idle -> thinking
      if (!wasThinking && state.isThinking) {
        startStreaming();
      }

      // Transition: thinking -> done
      if (wasThinking && !state.isThinking) {
        finishStreaming();
      }
    });

    return () => {
      unsub();
      cleanupStreaming();
    };
  }, []);
}
